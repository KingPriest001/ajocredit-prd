// AJOCREDIT API — Postgres-backed (PGlite, data in api/.pglite-data). Mirrors prisma schema.
// Minimal .env loader (no dependency): KEY=VALUE lines, ignores # comments.
try {
  require('fs').readFileSync(require('path').join(__dirname, '..', '.env'), 'utf8').split('\n').forEach((l) => {
    const m = l.match(/^\s*([A-Z0-9_]+)=(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  });
} catch (e) {}
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

async function main() {
  const { PGlite } = await import('@electric-sql/pglite');
  const db = new PGlite(path.join(__dirname, '.pglite-data'));
  await db.waitReady;
  const init = fs.readFileSync(path.join(__dirname, '..', 'db', 'init.sql'), 'utf8')
    .replace(/CREATE EXTENSION[^;]+;/, '');
  await db.exec(init);
  await db.exec(`ALTER TABLE groups ADD COLUMN IF NOT EXISTS dest_bank_code TEXT;
    ALTER TABLE groups ADD COLUMN IF NOT EXISTS dest_account_number TEXT;
    ALTER TABLE groups ADD COLUMN IF NOT EXISTS dest_account_name TEXT;
    ALTER TABLE groups ADD COLUMN IF NOT EXISTS dest_verified BOOLEAN NOT NULL DEFAULT FALSE;`);

  const PORT = process.env.PORT || 4000;
  const app = express();
  app.use(cors());
  app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf; } }));
  const crypto = require('crypto');
  const PAYS_MODE = process.env.PAYMENTS_MODE || 'direct';
  const PSK = () => process.env.PAYSTACK_SECRET_KEY || '';
  const PS_HDR = () => ({ Authorization: `Bearer ${PSK()}`, 'Content-Type': 'application/json' });
  const q = (t, p) => db.query(t, p).then((r) => r.rows);

  function feeFor(amount) {
    let rate = 0.01;
    if (amount < 10000) rate = 0.015;
    else if (amount > 100000) rate = 0.0075;
    return { fee: Math.round(amount * rate), total: amount + Math.round(amount * rate) };
  }
  function tierFor(s) { return s >= 800 ? 'Platinum' : s >= 600 ? 'Gold' : s >= 350 ? 'Silver' : 'Bronze'; }

  app.get('/health', async (req, res) => {
    try { await db.query('SELECT 1'); res.json({ ok: true, db: 'up', engine: 'pglite-postgres' }); }
    catch (e) { res.status(500).json({ ok: false, db: 'down', error: e.message }); }
  });

  app.get('/api/score/:ajId', async (req, res) => {
    const u = await q('SELECT * FROM users WHERE ajocredit_id=$1', [req.params.ajId]);
    if (!u.length) return res.status(404).json({ error: 'user not found' });
    const h = await q('SELECT * FROM score_history WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1', [u[0].id]);
    res.json({ user: u[0], latest: h[0] || null });
  });

  app.get('/api/groups/:id/health', async (req, res) => {
    const g = await q('SELECT * FROM groups WHERE id=$1', [req.params.id]);
    if (!g.length) return res.status(404).json({ error: 'group not found' });
    const m = await q('SELECT status, COUNT(*) c FROM memberships WHERE group_id=$1 GROUP BY status', [req.params.id]);
    const c = await q("SELECT COUNT(*) paid FROM contributions c JOIN cycles cy ON cy.id=c.cycle_id WHERE cy.group_id=$1 AND c.status='CONFIRMED'", [req.params.id]);
    const d = await q("SELECT COUNT(*) open FROM disputes WHERE group_id=$1 AND status NOT IN ('RESOLVED','CLOSED')", [req.params.id]);
    res.json({ group: g[0], memberships: m, paid_contributions: c[0].paid, open_disputes: d[0].open,
      health: { pct: 92, paid: '15/20', late: 2, disputes: Number(d[0].open), trust: 'Gold' } });
  });

  app.get('/api/groups/:id/ledger', async (req, res) => {
    res.json(await q('SELECT * FROM ledger_entries WHERE group_id=$1 ORDER BY created_at DESC LIMIT 50', [req.params.id]));
  });

  app.post('/api/contributions', async (req, res) => {
    const { membership_id, cycle_id, amount, method, reference } = req.body || {};
    if (!membership_id || !cycle_id || !amount || !reference) return res.status(400).json({ error: 'membership_id, cycle_id, amount, reference required' });
    const { fee, total } = feeFor(amount);
    try {
      await q(`INSERT INTO contributions (id, membership_id, cycle_id, amount, fee, total, method, reference, status)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'CONFIRMED') ON CONFLICT (reference) DO NOTHING`,
        [`ct-${Date.now()}`, membership_id, cycle_id, amount, fee, total, method || 'transfer', reference]);
      res.json({ ok: true, amount, fee, total });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  app.get('/api/notifications/:userId', async (req, res) => {
    res.json(await q('SELECT * FROM notifications WHERE user_id=$1 ORDER BY created_at DESC LIMIT 20', [req.params.userId]));
  });

  app.get('/api/referrals/:userId', async (req, res) => {
    const rows = await q('SELECT * FROM referrals WHERE inviter_id=$1 ORDER BY created_at DESC', [req.params.userId]);
    res.json({ sent: rows.length, joined: rows.filter((x) => x.status === 'joined').length,
      earned_naira: rows.reduce((s, x) => s + (x.reward_naira || 0), 0), rows });
  });

  app.get('/api/passport/:ajId', async (req, res) => {
    const u = await q('SELECT * FROM users WHERE ajocredit_id=$1', [req.params.ajId]);
    if (!u.length) return res.status(404).json({ error: 'not found' });
    res.json({ name: u[0].name, ajocredit_id: u[0].ajocredit_id, score: u[0].score, tier: u[0].tier || tierFor(u[0].score), trust: 'Gold', reputation: '92% on-time · 1 group' });
  });

  // OTP via Termii (generic channel). In-memory codes (pilot scale): 6-digit, 5-min expiry, 5 fails → 15-min lock.
  const otpStore = new Map();
  app.post('/api/otp/send', async (req, res) => {
    const { phone } = req.body || {};
    if (!phone) return res.status(400).json({ error: 'phone required' });
    const rec = otpStore.get(phone) || { fails: 0, lockedUntil: 0 };
    if (Date.now() < rec.lockedUntil) return res.status(429).json({ error: 'locked, try later' });
    const code = String(Math.floor(100000 + Math.random() * 900000));
    otpStore.set(phone, { ...rec, code, expires: Date.now() + 5 * 60 * 1000 });
    const key = process.env.TERMII_API_KEY;
    if (!key || key === 'REPLACE_ME') return res.json({ ok: true, mode: 'mock', note: 'TERMII_API_KEY not set' });
    try {
      const r = await fetch('https://v3.api.termii.com/api/sms/send', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ api_key: key, to: phone.replace(/^\+/, ''), from: 'AJOCREDIT', sms: `Your AJOCREDIT code is ${code}. Expires in 5 minutes.`, type: 'plain', channel: 'generic' }),
      });
      const j = await r.json();
      res.json({ ok: true, mode: 'live', termii: j.message_id || j.message || 'sent' });
    } catch (e) { res.status(502).json({ ok: false, error: e.message }); }
  });
  app.post('/api/otp/verify', (req, res) => {
    const { phone, code } = req.body || {};
    const rec = otpStore.get(phone);
    if (!rec || !rec.code) return res.status(400).json({ error: 'no code sent' });
    if (Date.now() > rec.expires) return res.status(401).json({ error: 'expired' });
    if (rec.code !== String(code)) {
      rec.fails = (rec.fails || 0) + 1;
      if (rec.fails >= 5) rec.lockedUntil = Date.now() + 15 * 60 * 1000;
      return res.status(401).json({ error: 'invalid', fails: rec.fails });
    }
    otpStore.delete(phone);
    res.json({ ok: true, ajocredit_id: 'AJ-' + Math.floor(100000 + Math.random() * 900000) });
  });

  // WhatsApp Cloud API webhook (auto-response). Meta verifies with GET; messages arrive via POST.
  // Setup: Meta app → WhatsApp product → token (WHATSAPP_TOKEN) + Phone Number ID + webhook URL /webhooks/whatsapp + VERIFY_TOKEN. See docs/WHATSAPP.md.
  app.get('/webhooks/whatsapp', (req, res) => {
    if (req.query['hub.verify_token'] === (process.env.WHATSAPP_VERIFY_TOKEN || 'ajocredit-verify')) return res.send(req.query['hub.challenge']);
    res.sendStatus(403);
  });
  function waReply(text) {
    const t = (text || '').toLowerCase();
    const has = (...ws) => ws.some((w) => t.includes(w));
    if (has('payout', 'collect', 'gbe owo')) return 'Next payout: Aunty Ngozi · ₦100,000 in 2 days 4 hrs. 15 of 20 paid. You will be notified immediately it lands.';
    if (has('due', 'contribut', 'sanwo', 'next contribution')) return 'Your next contribution is ₦5,000 + ₦75 fee (Bodija Weekly). Due May 25 — 3 days left. Pay in the app or reply HELP.';
    if (has('score', 'credit', 'power')) return 'Your Credit Power: ₦450,000 (ESTIMATED illustrative value). Silver · 80 points to Gold. Keep paying on time!';
    if (has('dispute', 'complaint', 'wahala')) return 'Sorry about that. Open the app → Account → Disputes, or describe it here with your Transaction ID. We respond within 24 hours.';
    if (has('join', 'invite', 'code', 'darapo')) return 'Join with code AJ-4821 in the app, or ask your admin for a fresh invite. Welcome!';
    if (has('hello', 'hi', 'good', 'ebawo', 'kaabo')) return 'Welcome to AJOCREDIT! Ask about: DUE, PAYOUT, SCORE, DISPUTE, JOIN — or type HUMAN to reach support (Mon–Sat 8am–8pm).';
    if (has('human', 'agent', 'person', 'eniyan')) return 'Noted — a human will reply here Mon–Sat 8am–8pm. For urgent money issues, call [support line].';
    return "Thanks! I handle DUE, PAYOUT, SCORE, DISPUTE, JOIN. Type HUMAN for a person (Mon–Sat 8am–8pm).";
  }
  app.post('/webhooks/whatsapp', async (req, res) => {
    try {
      const msg = req.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
      const from = msg?.from || 'unknown';
      const text = msg?.text?.body || '';
      const reply = waReply(text);
      const token = process.env.WHATSAPP_TOKEN, phoneId = process.env.WHATSAPP_PHONE_ID;
      if (token && phoneId && msg) {
        await fetch(`https://graph.facebook.com/v21.0/${phoneId}/messages`, {
          method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ messaging_product: 'whatsapp', to: from, text: { body: reply } }),
        });
      }
      try { await db.query(`INSERT INTO notifications (id, user_id, kind, title, body) VALUES ($1,$2,'whatsapp',\"WA in: \"||$3,$4)`, [`wa-${Date.now()}`, 'u-bola', text.slice(0, 60), reply.slice(0, 200)]); } catch (e) {}
      res.json({ ok: true, reply, sent: Boolean(token && phoneId && msg) });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  // Direct-settlement payments (PAYMENTS_MODE=direct): money settles to the group's own
  // destination account (admin/recipient), never an AJOCREDIT balance. Pooled mode (custodian) is gated.
  app.get('/api/banks', async (req, res) => {
    try {
      const r = await fetch('https://api.paystack.co/bank?country=nigeria', { headers: PS_HDR() });
      const j = await r.json();
      res.json((j.data || []).map((b) => ({ name: b.name, code: b.code })));
    } catch (e) { res.status(502).json({ error: e.message }); }
  });
  app.post('/api/groups/:id/destination', async (req, res) => {
    const { bank_code, account_number } = req.body || {};
    if (!bank_code || !account_number) return res.status(400).json({ error: 'bank_code + account_number required' });
    try {
      const r = await fetch(`https://api.paystack.co/bank/resolve?account_number=${account_number}&bank_code=${bank_code}`, { headers: PS_HDR() });
      const j = await r.json();
      if (!j.status) return res.status(422).json({ error: j.message || 'account could not be verified' });
      await db.query('UPDATE groups SET dest_bank_code=$1, dest_account_number=$2, dest_account_name=$3, dest_verified=TRUE WHERE id=$4',
        [bank_code, account_number, j.data.account_name, req.params.id]);
      res.json({ ok: true, account_name: j.data.account_name, mode: PAYS_MODE });
    } catch (e) { res.status(502).json({ error: e.message }); }
  });
  app.post('/api/payments/init', async (req, res) => {
    const { group_id, membership_id, cycle_id, amount, email } = req.body || {};
    if (!group_id || !membership_id || !cycle_id || !amount) return res.status(400).json({ error: 'group_id, membership_id, cycle_id, amount required' });
    const g = await q('SELECT * FROM groups WHERE id=$1', [group_id]);
    if (!g.length) return res.status(404).json({ error: 'group not found' });
    const { fee, total } = feeFor(amount);
    res.json({ ok: true, mode: PAYS_MODE, amount, fee, total, amount_kobo: total * 100,
      paystack_key: process.env.PAYSTACK_PUBLIC_KEY || null,
      reference: `${group_id.slice(0, 8)}-C${cycle_id.slice(-2)}-${Date.now()}`,
      destination: g[0].dest_verified ? { bank: g[0].dest_bank_code, account: '••' + String(g[0].dest_account_number).slice(-4), name: g[0].dest_account_name } : null,
      metadata: { group_id, membership_id, cycle_id, pot: amount, fee } });
  });
  app.post('/webhooks/paystack', async (req, res) => {
    const sig = req.headers['x-paystack-signature'];
    const expect = crypto.createHmac('sha512', PSK()).update(req.rawBody || '').digest('hex');
    if (!sig || sig !== expect) return res.status(401).json({ error: 'bad signature' });
    const ev = req.body || {};
    if (ev.event === 'charge.success') {
      const md = ev.data?.metadata || {};
      const ref = ev.data?.reference || '';
      try {
        await db.query(`INSERT INTO contributions (id, membership_id, cycle_id, amount, fee, total, method, reference, status)
          VALUES ($1,$2,$3,$4,$5,$6,'paystack',$7,'CONFIRMED') ON CONFLICT (reference) DO NOTHING`,
          [`ct-${Date.now()}`, md.membership_id, md.cycle_id, md.pot, md.fee, md.pot + md.fee, ref]);
        res.json({ ok: true, confirmed: ref });
      } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
    } else res.json({ ok: true, ignored: ev.event });
  });

  app.listen(PORT, () => console.log(`AJOCREDIT API on :${PORT}`));
}

main().catch((e) => { console.error('API-FAIL:', e.message); process.exit(1); });
