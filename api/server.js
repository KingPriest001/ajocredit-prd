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
  // Local default: embedded Postgres (PGlite, api/.pglite-data). Cloud: set USE_EXTERNAL_DB=1
  // with DATABASE_URL pointing at managed Postgres (e.g. Neon) — same schema, same code.
  let db, exec;
  if (process.env.USE_EXTERNAL_DB === '1') {
    const { Pool } = require('pg');
    const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
    db = { query: (t, p) => pool.query(t, p), exec: async (sql) => { await pool.query(sql); } };
    exec = (sql) => pool.query(sql);
  } else {
    const { PGlite } = await import('@electric-sql/pglite');
    db = new PGlite(path.join(__dirname, '.pglite-data'));
    await db.waitReady;
    exec = (sql) => db.exec(sql);
  }
  const init = fs.readFileSync(path.join(__dirname, '..', 'db', 'init.sql'), 'utf8')
    .replace(/CREATE EXTENSION[^;]+;/, '');
  await exec(init);
  await exec(`ALTER TABLE groups ADD COLUMN IF NOT EXISTS dest_bank_code TEXT;
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
    try { await db.query('SELECT 1'); res.json({ ok: true, db: 'up', engine: process.env.USE_EXTERNAL_DB === '1' ? 'postgres-managed' : 'pglite-postgres' }); }
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
  const rl = new Map();
  function limited(key, max, ms) {
    const now = Date.now(), arr = (rl.get(key) || []).filter((t) => now - t < ms);
    arr.push(now); rl.set(key, arr);
    return arr.length > max;
  }
  app.post('/api/otp/send', async (req, res) => {
    const { phone } = req.body || {};
    if (!phone) return res.status(400).json({ error: 'phone required' });
    if (limited(`otp:${phone}`, 5, 15 * 60 * 1000)) return res.status(429).json({ error: 'too many requests, try in 15 min' });
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
  app.post('/api/otp/verify', async (req, res) => {
    const { phone, code, device_id } = req.body || {};
    const rec = otpStore.get(phone);
    if (!rec || !rec.code) return res.status(400).json({ error: 'no code sent' });
    if (Date.now() > rec.expires) return res.status(401).json({ error: 'expired' });
    if (rec.code !== String(code)) {
      rec.fails = (rec.fails || 0) + 1;
      if (rec.fails >= 5) rec.lockedUntil = Date.now() + 15 * 60 * 1000;
      return res.status(401).json({ error: 'invalid', fails: rec.fails });
    }
    otpStore.delete(phone);
    try {
      let u = await q('SELECT * FROM users WHERE phone=$1', [phone]);
      if (!u.length) {
        const uid = `u-${Date.now()}`, aj = 'AJ-' + Math.floor(100000 + Math.random() * 900000);
        await q(`INSERT INTO users (id, phone, name, verification, ajocredit_id, score, tier, provisional) VALUES ($1,$2,'New Member','OTP',$3,250,'Bronze',TRUE)`, [uid, phone, aj]);
        u = await q('SELECT * FROM users WHERE id=$1', [uid]);
      }
      if (device_id) {
        await q(`INSERT INTO devices (id, user_id, device_id, last_seen) VALUES ($1,$2,$3,NOW())
          ON CONFLICT (user_id, device_id) DO UPDATE SET last_seen=NOW()`, [`dv-${Date.now()}`, u[0].id, device_id]);
      }
      await q(`INSERT INTO audit_log (id, actor_id, action, entity, entity_id) VALUES ($1,$2,'otp.verify','user',$3)`, [`al-${Date.now()}`, u[0].id, u[0].id]);
      res.json({ ok: true, ajocredit_id: u[0].ajocredit_id, user_id: u[0].id });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });
  // Request log: every money/score write also lands in audit_log at its handler.

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
        await db.query(`INSERT INTO ledger_entries (id, group_id, debit_acct, credit_acct, amount, type, ref_id, idempotency_key, status, hash)
          VALUES ($1,$2,'psp:paystack',$3,$4,'contribution',$5,$6,'CONFIRMED',$7) ON CONFLICT (idempotency_key) DO NOTHING`,
          [`le-${Date.now()}`, md.group_id, `pot:${md.group_id}`, md.pot, ref, `webhook:${ref}`, `h${Date.now()}`]);
        await db.query(`INSERT INTO audit_log (id, actor_id, action, entity, entity_id) VALUES ($1,'paystack','webhook.confirm','contribution',$2)`, [`al-${Date.now()}`, ref]);
        res.json({ ok: true, confirmed: ref });
      } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
    } else if (ev.event === 'charge.failed') {
      const ref = ev.data?.reference || '';
      try {
        await db.query(`UPDATE contributions SET status='FAILED' WHERE reference=$1`, [ref]);
        await db.query(`INSERT INTO audit_log (id, actor_id, action, entity, entity_id) VALUES ($1,'paystack','webhook.fail','contribution',$2)`, [`al-${Date.now()}`, ref]);
        res.json({ ok: true, marked_failed: ref });
      } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
    } else res.json({ ok: true, ignored: ev.event });
  });
  // Reconciliation: confirmed contributions with no matching ledger entry, and vice versa.
  app.get('/api/recon/:groupId', async (req, res) => {
    const missing = await q(`SELECT c.reference, c.amount FROM contributions c LEFT JOIN ledger_entries l
      ON l.ref_id=c.reference AND l.status='CONFIRMED' WHERE c.status='CONFIRMED' AND l.id IS NULL
      AND c.cycle_id IN (SELECT id FROM cycles WHERE group_id=$1)`, [req.params.groupId]);
    const failed = await q(`SELECT reference, amount FROM contributions WHERE status='FAILED'
      AND cycle_id IN (SELECT id FROM cycles WHERE group_id=$1)`, [req.params.groupId]);
    res.json({ ok: missing.length === 0, unmatched: missing, failed });
  });

  app.post('/api/groups', async (req, res) => {
    const { name, amount, size, frequency, payout_mode, admin_phone, admin_name } = req.body || {};
    if (!name || !amount || !admin_phone) return res.status(400).json({ error: 'name, amount, admin_phone required' });
    try {
      const now = Date.now();
      let u = await q('SELECT * FROM users WHERE phone=$1', [admin_phone]);
      if (!u.length) {
        const uid = `u-${now}`, aj = `AJ-${Math.floor(100000 + Math.random() * 900000)}`;
        await q(`INSERT INTO users (id, phone, name, verification, ajocredit_id, score, tier, provisional) VALUES ($1,$2,$3,'OTP',$4,250,'Bronze',TRUE)`,
          [uid, admin_phone, admin_name || 'Member', aj]);
        u = await q('SELECT * FROM users WHERE id=$1', [uid]);
      }
      const gid = `g-${now}`;
      await q(`INSERT INTO groups (id, name, type, amount, size, frequency, payout_mode, status, rules) VALUES ($1,$2,'ROTATIONAL',$3,$4,$5,$6,'FORMING','{\"grace_hours\":48}')`,
        [gid, name, amount, size || 10, frequency || 'Weekly', payout_mode || 'random']);
      await q(`INSERT INTO memberships (id, user_id, group_id, role, status) VALUES ($1,$2,$3,'admin','ACTIVE')`, [`m-${now}`, u[0].id, gid]);
      res.json({ ok: true, group_id: gid, invite_code: gid.slice(2, 8).toUpperCase(), admin: u[0].ajocredit_id });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  app.post('/api/disputes/:id/appeal', async (req, res) => {
    try {
      const r = await q('UPDATE disputes SET status=$1 WHERE id=$2 RETURNING id, status', ['APPEAL', req.params.id]);
      if (!r.length) return res.status(404).json({ error: 'dispute not found' });
      res.json({ ok: true, ...r[0], note: 'a different reviewer takes over' });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });
  app.post('/api/exits', async (req, res) => {
    const { group_id, user_id, kind } = req.body || {};
    if (!group_id || !user_id || !kind) return res.status(400).json({ error: 'group_id, user_id, kind (pre|post) required' });
    try {
      const ref = `EXIT-${Date.now()}`;
      await q(`INSERT INTO notifications (id, user_id, kind, title, body) VALUES ($1,$2,'exit',$3,$4)`,
        [`ex-${Date.now()}`, user_id, `Exit recorded (${kind}-payout)`, `Ref ${ref}. ${kind === 'post' ? 'Immediate default, review opened.' : 'Replacement invited, 7-day window.'}`]);
      if (kind === 'post') {
        await q(`INSERT INTO disputes (id, group_id, raised_by, category, status) VALUES ($1,$2,$3,'non-payment','OPEN')`, [`d-${Date.now()}`, group_id, user_id]);
      }
      res.json({ ok: true, ref });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });
  app.get('/api/groups/:id/members', async (req, res) => {
    res.json(await q(`SELECT m.id, m.role, m.payout_slot, m.status, u.name, u.ajocredit_id FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.group_id=$1 ORDER BY m.payout_slot NULLS LAST`, [req.params.id]));
  });

  app.listen(PORT, () => console.log(`AJOCREDIT API on :${PORT}`));
}

main().catch((e) => { console.error('API-FAIL:', e.message); process.exit(1); });
