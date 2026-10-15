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
  console.log('BOOT mode=' + (process.env.USE_EXTERNAL_DB === '1' ? 'external' : 'embedded') + ' node=' + process.version);
  // Local default: embedded Postgres (PGlite, api/.pglite-data). Cloud: set USE_EXTERNAL_DB=1
  // with DATABASE_URL pointing at managed Postgres (e.g. Neon) — same schema, same code.
  let db, exec;
  if (process.env.USE_EXTERNAL_DB === '1') {
    const { Pool } = require('pg');
    // Strip params node-postgres can't use (e.g. channel_binding) to avoid connect-time crashes.
    const cleanUrl = (process.env.DATABASE_URL || '').replace(/([?&])channel_binding=[^&]*/g, '$1').replace(/[?&]$/, '');
    const pool = new Pool({ connectionString: cleanUrl, ssl: { rejectUnauthorized: false } });
    db = { query: (t, p) => pool.query(t, p), exec: async (sql) => { await pool.query(sql); } };
    exec = (sql) => pool.query(sql);
    // Neon cold starts can take seconds — retry instead of crashing the deploy.
    let connected = false;
    for (let i = 1; i <= 6 && !connected; i++) {
      try { await pool.query('SELECT 1'); connected = true; console.log('DB connected'); }
      catch (e) { console.log(`DB retry ${i}/6: ${e.message}`); await new Promise((r) => setTimeout(r, 5000)); }
    }
    if (!connected) throw new Error('DB unreachable after 6 retries');
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
    ALTER TABLE groups ADD COLUMN IF NOT EXISTS dest_verified BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE groups ADD COLUMN IF NOT EXISTS invite_code TEXT;
    UPDATE groups SET invite_code='AJ-4821' WHERE id='g-aj4821' AND invite_code IS NULL;`);

  const PORT = process.env.PORT || 4000;
  const app = express();
  app.use(cors());
  app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf; } }));
  const crypto = require('crypto');
  const PAYS_MODE = process.env.PAYMENTS_MODE || 'direct';
  const PSK = () => process.env.PAYSTACK_SECRET_KEY || '';
  const PS_HDR = () => ({ Authorization: `Bearer ${PSK()}`, 'Content-Type': 'application/json' });
  const FLW = () => process.env.FLUTTERWAVE_SECRET_KEY || '';
  const FLW_HDR = () => ({ Authorization: `Bearer ${FLW()}`, 'Content-Type': 'application/json' });
  // Shared confirm path for both PSPs: idempotent contribution + ledger + audit.
  async function confirmContribution(md, ref, method) {
    const h = crypto.createHash('sha256').update(String(ref) + Date.now()).digest('hex').slice(0, 16);
    await db.query(`INSERT INTO contributions (id, membership_id, cycle_id, amount, fee, total, method, reference, status)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'CONFIRMED') ON CONFLICT (reference) DO NOTHING`,
      [`ct-${Date.now()}`, md.membership_id, md.cycle_id, md.pot, md.fee, md.pot + md.fee, method, ref]);
    await db.query(`INSERT INTO ledger_entries (id, group_id, debit_acct, credit_acct, amount, type, ref_id, idempotency_key, status, hash)
      VALUES ($1,$2,$3,$4,$5,'contribution',$6,$7,'CONFIRMED',$8) ON CONFLICT (idempotency_key) DO NOTHING`,
      [`le-${Date.now()}`, md.group_id, `psp:${method}`, `pot:${md.group_id}`, md.pot, ref, `webhook:${ref}`, h]);
    await db.query(`INSERT INTO audit_log (id, actor_id, action, entity, entity_id) VALUES ($1,$2,'webhook.confirm','contribution',$3)`, [`al-${Date.now()}`, method, ref]);
  }
  const q = (t, p) => db.query(t, p).then((r) => r.rows);

  function feeFor(amount) {
    let rate = 0.01;
    if (amount < 10000) rate = 0.015;
    else if (amount > 100000) rate = 0.0075;
    return { fee: Math.round(amount * rate), total: amount + Math.round(amount * rate) };
  }
  function tierFor(s) { return s >= 800 ? 'Platinum' : s >= 600 ? 'Gold' : s >= 350 ? 'Silver' : 'Bronze'; }
  function normPhone(p) {
    if (!p) return null;
    p = String(p).replace(/[\s\-()]/g, '');
    if (/^0[789][01]\d{8}$/.test(p)) return '+234' + p.slice(1);
    if (/^234[789][01]\d{8}$/.test(p)) return '+' + p;
    if (/^\+234[789][01]\d{8}$/.test(p)) return p;
    return null;
  }
  async function isAdmin(userId, groupId) {
    const r = await q(`SELECT id FROM memberships WHERE user_id=$1 AND group_id=$2 AND role='admin' AND status='ACTIVE'`, [userId, groupId]);
    return r.length > 0;
  }

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
      health: { paid: c[0].paid, disputes: Number(d[0].open) } });
  });

  app.get('/api/groups/:id/ledger', async (req, res) => {
    res.json(await q('SELECT * FROM ledger_entries WHERE group_id=$1 ORDER BY created_at DESC LIMIT 50', [req.params.id]));
  });

  // Auth: Bearer session token. Enforced only when REQUIRE_AUTH=1 (pilot stays open, production locks).
  async function auth(req, res, next) {
    if (process.env.REQUIRE_AUTH !== '1') { req.user = null; return next(); }
    const t = (req.headers.authorization || '').replace(/^Bearer /, '');
    if (!t) return res.status(401).json({ error: 'token required' });
    const h = crypto.createHash('sha256').update(t).digest('hex');
    const s = await q('SELECT user_id FROM sessions WHERE token_hash=$1 AND expires_at > NOW()', [h]);
    if (!s.length) return res.status(401).json({ error: 'invalid token' });
    req.user = s[0].user_id;
    next();
  }
  app.post('/api/contributions', auth, async (req, res) => {
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
    res.json({ name: u[0].name, ajocredit_id: u[0].ajocredit_id, score: u[0].score, tier: u[0].tier || tierFor(u[0].score) });
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
    if (!key || key === 'REPLACE_ME') return res.status(503).json({ ok: false, error: 'SMS service not configured. Try again later.' });
    try {
      const termiiBase = (process.env.TERMII_BASE_URL || 'https://v3.api.termii.com').replace(/\/$/, '');
      const r = await fetch(termiiBase + '/api/sms/send', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ api_key: key, to: phone.replace(/^\+/, ''), from: process.env.TERMII_SENDER_ID || 'AJOCREDIT', sms: `Your AJOCREDIT code is ${code}. Expires in 5 minutes.`, type: 'plain', channel: 'generic' }),
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
      // Session token: random 256-bit, stored hashed, 30-day expiry, bound to device.
      const token = crypto.randomBytes(32).toString('hex');
      const thash = crypto.createHash('sha256').update(token).digest('hex');
      await q(`INSERT INTO sessions (id, user_id, token_hash, device_id, expires_at) VALUES ($1,$2,$3,$4,NOW() + INTERVAL '30 days')`,
        [`se-${Date.now()}`, u[0].id, thash, device_id || '']);
      res.json({ ok: true, ajocredit_id: u[0].ajocredit_id, user_id: u[0].id, token });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });
  // Request log: every money/score write also lands in audit_log at its handler.

  // WhatsApp Cloud API webhook (auto-response). Meta verifies with GET; messages arrive via POST.
  // Setup: Meta app → WhatsApp product → token (WHATSAPP_TOKEN) + Phone Number ID + webhook URL /webhooks/whatsapp + VERIFY_TOKEN. See docs/WHATSAPP.md.
  app.get('/webhooks/whatsapp', (req, res) => {
    if (!process.env.WHATSAPP_VERIFY_TOKEN) return res.sendStatus(403);
    if (req.query['hub.verify_token'] === process.env.WHATSAPP_VERIFY_TOKEN) return res.send(req.query['hub.challenge']);
    res.sendStatus(403);
  });
  function waReply(text) {
    const t = (text || '').toLowerCase();
    const has = (...ws) => ws.some((w) => t.includes(w));
    if (has('payout', 'collect', 'gbe owo')) return 'Payout status is shared in your group before each cycle. You will be notified immediately it lands.';
    if (has('due', 'contribut', 'sanwo', 'next contribution')) return 'Your next contribution and fee show in the app under Pay. Open the app or reply HELP.';
    if (has('score', 'credit', 'power')) return 'Your Credit Power shows in the app under Credit with your tier and progress. Keep paying on time!';
    if (has('dispute', 'complaint', 'wahala')) return 'Sorry about that. Open the app → Account → Disputes, or describe it here with your Transaction ID. We respond within 24 hours.';
    if (has('join', 'invite', 'code', 'darapo')) return 'Join with your group invite code in the app, or ask your admin for a fresh invite. Welcome!';
    if (has('hello', 'hi', 'good', 'ebawo', 'kaabo')) return 'Welcome to AJOCREDIT! Ask about: DUE, PAYOUT, SCORE, DISPUTE, JOIN — or type HUMAN to reach support (Mon–Sat 8am–8pm).';
    if (has('human', 'agent', 'person', 'eniyan')) return 'Noted — a human will reply here Mon–Sat 8am–8pm. For urgent money issues, reply with your Transaction ID.';
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
      if ((req.query || {}).provider === 'flutterwave') {
        const r = await fetch('https://api.flutterwave.com/v3/banks/NG', { headers: FLW_HDR() });
        const j = await r.json();
        return res.json(((j.data || j) instanceof Array ? (j.data || j) : []).map((b) => ({ name: b.name, code: String(b.code) })));
      }
      const r = await fetch('https://api.paystack.co/bank?country=nigeria', { headers: PS_HDR() });
      const j = await r.json();
      res.json((j.data || []).map((b) => ({ name: b.name, code: b.code })));
    } catch (e) { res.status(502).json({ error: e.message }); }
  });
  app.post('/api/groups/:id/destination', auth, async (req, res) => {
    const { bank_code, account_number, provider } = req.body || {};
    if (!bank_code || !account_number) return res.status(400).json({ error: 'bank_code + account_number required' });
    try {
      let account_name;
      if ((provider || 'paystack') === 'flutterwave') {
        const r = await fetch('https://api.flutterwave.com/v3/accounts/resolve', {
          method: 'POST', headers: FLW_HDR(), body: JSON.stringify({ account_number, account_bank: bank_code }),
        });
        const j = await r.json();
        if (j.status !== 'success') return res.status(422).json({ error: j.message || 'account could not be verified' });
        account_name = j.data.account_name;
      } else {
        const r = await fetch(`https://api.paystack.co/bank/resolve?account_number=${account_number}&bank_code=${bank_code}`, { headers: PS_HDR() });
        const j = await r.json();
        if (!j.status) return res.status(422).json({ error: j.message || 'account could not be verified' });
        account_name = j.data.account_name;
      }
      await db.query('UPDATE groups SET dest_bank_code=$1, dest_account_number=$2, dest_account_name=$3, dest_verified=TRUE WHERE id=$4',
        [bank_code, account_number, account_name, req.params.id]);
      res.json({ ok: true, account_name, provider: provider || 'paystack', mode: PAYS_MODE });
    } catch (e) { res.status(502).json({ error: e.message }); }
  });
  app.post('/api/payments/init', async (req, res) => {
    const { group_id, membership_id, cycle_id, amount, email } = req.body || {};
    if (!group_id || !membership_id || !cycle_id || !amount) return res.status(400).json({ error: 'group_id, membership_id, cycle_id, amount required' });
    const g = await q('SELECT * FROM groups WHERE id=$1', [group_id]);
    if (!g.length) return res.status(404).json({ error: 'group not found' });
    const { fee, total } = feeFor(amount);
    const reference = `AJO-${Date.now()}`;
    const meta = { group_id, membership_id, cycle_id, pot: amount, fee };
    const destination = g[0].dest_verified ? { bank: g[0].dest_bank_code, account: '••' + String(g[0].dest_account_number).slice(-4), name: g[0].dest_account_name } : null;
    if (!destination) return res.status(422).json({ ok: false, error: 'Payout account not linked yet — ask your admin to verify it before contributing.' });
    // Primary: Flutterwave hosted checkout link (v3 /payments). Backup: Paystack inline config.
    try {
      const r = await fetch('https://api.flutterwave.com/v3/payments', {
        method: 'POST', headers: FLW_HDR(),
        body: JSON.stringify({ tx_ref: reference, amount: total, currency: 'NGN',
          redirect_url: process.env.FRONTEND_URL || 'https://ajocredit.pages.dev/index.html',
          customer: { email: email || 'member@ajocredit.ng', name: 'Ajo Member' },
          meta: meta, customizations: { title: 'AJOCREDIT Contribution' } }),
      });
      const j = await r.json();
      if (j.status === 'success' && j.data && j.data.link) {
        return res.json({ ok: true, provider: 'flutterwave', link: j.data.link, reference,
          mode: PAYS_MODE, amount, fee, total, destination });
      }
      throw new Error('flutterwave link failed');
    } catch (e) {
      if (!process.env.PAYSTACK_PUBLIC_KEY) return res.status(503).json({ ok: false, error: 'Payment service temporarily unavailable. Try again soon.' });
      return res.json({ ok: true, provider: 'paystack', mode: PAYS_MODE, amount, fee, total, amount_kobo: total * 100,
        paystack_key: process.env.PAYSTACK_PUBLIC_KEY,
        reference: `${group_id.slice(0, 8)}-C${cycle_id.slice(-2)}-${Date.now()}`,
        destination, metadata: meta });
    }
  });
  app.post('/webhooks/flutterwave', async (req, res) => {
    const hash = req.headers['verif-hash'];
    if (!process.env.FLW_WEBHOOK_HASH || hash !== process.env.FLW_WEBHOOK_HASH) {
      return res.status(401).json({ error: 'bad webhook hash (set FLW_WEBHOOK_HASH + dashboard secret)' });
    }
    const ev = req.body || {};
    const ok = ev.status === 'successful' || (ev.data && ev.data.status === 'successful');
    const data = ev.data || ev;
    const md = data.meta || data.metadata || {};
    const ref = data.tx_ref || data.txRef || '';
    try {
      if (ok && ref) { await confirmContribution(md, ref, 'flutterwave'); res.json({ ok: true, confirmed: ref }); }
      else { await db.query(`UPDATE contributions SET status='FAILED' WHERE reference=$1`, [ref]); res.json({ ok: true, marked_failed: ref }); }
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });
  app.get('/api/payments/status/:reference', async (req, res) => {
    const r = await q('SELECT reference, amount, fee, total, status FROM contributions WHERE reference=$1', [req.params.reference]);
    if (!r.length) return res.json({ found: false });
    res.json({ found: true, ...r[0] });
  });
  app.post('/webhooks/paystack', async (req, res) => {
    const sig = req.headers['x-paystack-signature'];
    const expect = crypto.createHmac('sha512', PSK()).update(req.rawBody || '').digest('hex');
    if (!sig || sig !== expect) return res.status(401).json({ error: 'bad signature' });
    const ev = req.body || {};
    if (ev.event === 'charge.success') {
      const md = ev.data?.metadata || {};
      const ref = ev.data?.reference || '';
      const lh = crypto.createHmac('sha256', PSK() || 'ajocredit').update(String(ref)).digest('hex').slice(0, 16);
      try {
        await db.query(`INSERT INTO contributions (id, membership_id, cycle_id, amount, fee, total, method, reference, status)
          VALUES ($1,$2,$3,$4,$5,$6,'paystack',$7,'CONFIRMED') ON CONFLICT (reference) DO NOTHING`,
          [`ct-${Date.now()}`, md.membership_id, md.cycle_id, md.pot, md.fee, md.pot + md.fee, ref]);
        await db.query(`INSERT INTO ledger_entries (id, group_id, debit_acct, credit_acct, amount, type, ref_id, idempotency_key, status, hash)
          VALUES ($1,$2,'psp:paystack',$3,$4,'contribution',$5,$6,'CONFIRMED',$7) ON CONFLICT (idempotency_key) DO NOTHING`,
          [`le-${Date.now()}`, md.group_id, `pot:${md.group_id}`, md.pot, ref, `webhook:${ref}`, lh]);
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

  app.post('/api/groups', auth, async (req, res) => {
    const { name, amount, size, frequency, payout_mode, admin_phone, admin_name } = req.body || {};
    if (!name || String(name).trim().length < 3) return res.status(400).json({ error: 'group name needs at least 3 characters' });
    if (!Number.isFinite(+amount) || +amount <= 0 || +amount > 10000000) return res.status(400).json({ error: 'amount must be between ₦1 and ₦10,000,000' });
    const nsize = Math.min(30, Math.max(5, parseInt(size) || 10));
    const phone = normPhone(admin_phone);
    if (!phone) return res.status(400).json({ error: 'valid Nigerian phone required (e.g. 08031234567)' });
    const aname = String(admin_name || '').trim();
    if (aname.length < 2) return res.status(400).json({ error: 'your name is required' });
    try {
      const now = Date.now();
      let u = await q('SELECT * FROM users WHERE phone=$1', [phone]);
      if (!u.length) {
        const uid = `u-${now}`, aj = `AJ-${Math.floor(100000 + Math.random() * 900000)}`;
        await q(`INSERT INTO users (id, phone, name, verification, ajocredit_id, score, tier, provisional) VALUES ($1,$2,$3,'OTP',$4,250,'Bronze',TRUE)`,
          [uid, phone, aname, aj]);
        u = await q('SELECT * FROM users WHERE id=$1', [uid]);
      }
      const gid = `g-${now}`;
      const icode = gid.slice(2, 8).toUpperCase();
      await q(`INSERT INTO groups (id, name, type, amount, size, frequency, payout_mode, status, rules, invite_code) VALUES ($1,$2,'ROTATIONAL',$3,$4,$5,$6,'FORMING','{\"grace_hours\":48}',$7)`,
        [gid, String(name).trim(), +amount, nsize, frequency || 'Weekly', payout_mode || 'random', icode]);
      await q(`INSERT INTO memberships (id, user_id, group_id, role, status) VALUES ($1,$2,$3,'admin','ACTIVE')`, [`m-${now}`, u[0].id, gid]);
      await q(`INSERT INTO audit_log (id, actor_id, action, entity, entity_id) VALUES ($1,$2,'group.create','group',$3)`, [`al-${now}`, u[0].id, gid]);
      res.json({ ok: true, group_id: gid, invite_code: icode, admin: u[0].ajocredit_id });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });
  app.get('/api/groups/:id/requests', auth, async (req, res) => {
    const phone = normPhone((req.query || {}).admin_phone);
    if (!phone) return res.status(400).json({ error: 'admin_phone required' });
    const u = await q('SELECT * FROM users WHERE phone=$1', [phone]);
    if (!u.length || !(await isAdmin(u[0].id, req.params.id))) return res.status(403).json({ error: 'admin only' });
    res.json(await q(`SELECT m.id, m.status, u.name, u.phone, u.ajocredit_id FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.group_id=$1 AND m.status='PENDING' ORDER BY m.joined_at`, [req.params.id]));
  });
  app.post('/api/memberships/:id/decision', auth, async (req, res) => {
    const { admin_phone, decision } = req.body || {};
    if (decision !== 'approve' && decision !== 'reject') return res.status(400).json({ error: "decision must be 'approve' or 'reject'" });
    const phone = normPhone(admin_phone);
    if (!phone) return res.status(400).json({ error: 'admin_phone required' });
    try {
      const m = await q('SELECT * FROM memberships WHERE id=$1', [req.params.id]);
      if (!m.length) return res.status(404).json({ error: 'request not found' });
      const u = await q('SELECT * FROM users WHERE phone=$1', [phone]);
      if (!u.length || !(await isAdmin(u[0].id, m[0].group_id))) return res.status(403).json({ error: 'admin only' });
      const st = decision === 'approve' ? 'ACTIVE' : 'REMOVED';
      await q(`UPDATE memberships SET status=$1 WHERE id=$2`, [st, req.params.id]);
      await q(`INSERT INTO audit_log (id, actor_id, action, entity, entity_id) VALUES ($1,$2,$3,'membership',$4)`, [`al-${Date.now()}`, u[0].id, 'member.' + decision, req.params.id]);
      res.json({ ok: true, status: st });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  app.post('/api/disputes', auth, async (req, res) => {
    const { group_id, reference, note, category } = req.body || {};
    if (!group_id || !reference) return res.status(400).json({ error: 'group_id, reference required' });
    try {
      const id = `d-${Date.now()}`;
      await q(`INSERT INTO disputes (id, group_id, raised_by, category, status) VALUES ($1,$2,$3,$4,'OPEN')`,
        [id, group_id, 'u-bola', category || 'non-payment']);
      await q(`INSERT INTO audit_log (id, actor_id, action, entity, entity_id) VALUES ($1,$2,'dispute.open','dispute',$3)`,
        [`al-${Date.now()}`, 'u-bola', id]);
      res.json({ ok: true, id, status: 'OPEN' });
    } catch (e) { res.status(500).json({ ok: false, error: 'Could not file dispute. Try again.' }); }
  });
  app.post('/api/disputes/:id/appeal', auth, async (req, res) => {
    try {
      const r = await q('UPDATE disputes SET status=$1 WHERE id=$2 RETURNING id, status', ['APPEAL', req.params.id]);
      if (!r.length) return res.status(404).json({ error: 'dispute not found' });
      res.json({ ok: true, ...r[0], note: 'a different reviewer takes over' });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });
  app.post('/api/exits', auth, async (req, res) => {
    const { group_id, user_id, kind, replacement_name, replacement_phone } = req.body || {};
    if (!group_id || !user_id || !kind) return res.status(400).json({ error: 'group_id, user_id, kind (pre|post) required' });
    try {
      const ref = `EXIT-${Date.now()}`;
      const extra = replacement_name ? ` Replacement: ${String(replacement_name).slice(0, 60)} ${String(replacement_phone || '').slice(0, 20)}.` : '';
      await q(`INSERT INTO notifications (id, user_id, kind, title, body) VALUES ($1,$2,'exit',$3,$4)`,
        [`ex-${Date.now()}`, user_id, `Exit recorded (${kind}-payout)`, `Ref ${ref}. ${kind === 'post' ? 'Immediate default, review opened.' : 'Replacement invited, 7-day window.'}${extra}`]);
      if (kind === 'post') {
        await q(`INSERT INTO disputes (id, group_id, raised_by, category, status) VALUES ($1,$2,$3,'non-payment','OPEN')`, [`d-${Date.now()}`, group_id, user_id]);
      }
      res.json({ ok: true, ref });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });
  app.get('/api/groups/:id/members', async (req, res) => {
    res.json(await q(`SELECT m.id, m.role, m.payout_slot, m.status, u.name, u.ajocredit_id FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.group_id=$1 ORDER BY m.payout_slot NULLS LAST`, [req.params.id]));
  });

  app.get('/api/groups/by-code/:code', async (req, res) => {
    const g = await q(`SELECT g.*, (SELECT COUNT(*) FROM memberships m WHERE m.group_id=g.id AND m.status='ACTIVE') AS members FROM groups g WHERE UPPER(g.invite_code)=UPPER($1)`, [req.params.code]);
    if (!g.length) return res.status(404).json({ error: 'no group with that code' });
    res.json({ ok: true, group: g[0] });
  });
  app.post('/api/groups/:id/join', auth, async (req, res) => {
    const phone = normPhone((req.body || {}).phone);
    const name = String((req.body || {}).name || '').trim();
    if (!phone) return res.status(400).json({ error: 'valid Nigerian phone required (e.g. 08031234567)' });
    if (name.length < 2) return res.status(400).json({ error: 'your name is required' });
    try {
      let u = await q('SELECT * FROM users WHERE phone=$1', [phone]);
      if (!u.length) {
        const uid = `u-${Date.now()}`, aj = 'AJ-' + Math.floor(100000 + Math.random() * 900000);
        await q(`INSERT INTO users (id, phone, name, verification, ajocredit_id, score, tier, provisional) VALUES ($1,$2,$3,'OTP',$4,250,'Bronze',TRUE)`, [uid, phone, name, aj]);
        u = await q('SELECT * FROM users WHERE id=$1', [uid]);
      }
      const ex = await q('SELECT id, status FROM memberships WHERE user_id=$1 AND group_id=$2', [u[0].id, req.params.id]);
      if (ex.length) return res.json({ ok: true, status: ex[0].status, note: 'already requested' });
      await q(`INSERT INTO memberships (id, user_id, group_id, role, status) VALUES ($1,$2,$3,'member','PENDING')`, [`m-${Date.now()}`, u[0].id, req.params.id]);
      await q(`INSERT INTO audit_log (id, actor_id, action, entity, entity_id) VALUES ($1,$2,'group.join','membership',$3)`, [`al-${Date.now()}`, u[0].id, req.params.id]);
      res.json({ ok: true, status: 'PENDING', note: 'admin approval pending' });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  app.listen(PORT, '0.0.0.0', () => console.log(`AJOCREDIT API on :${PORT}`));
}

main().catch((e) => { console.error('API-FAIL:', e.message); process.exit(1); });
process.on('unhandledRejection', (e) => console.error('UNHANDLED:', e && e.message ? e.message : e));
