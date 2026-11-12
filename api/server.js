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
// Termii client (SMS + OTP generate/verify). Loaded after the .env loader below so
// it picks up TERMII_API_KEY / TERMII_SENDER_ID from the environment.
const termii = require('./termii');
// Transactional email (welcome + password reset only). Records what it tried to
// send in email_log even when no email provider is configured yet.
const mailer = require('./mailer');

// Database handle, kept at module scope so the graceful shutdown below can close it.
let __db = null;

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
  __db = db;
  const init = fs.readFileSync(path.join(__dirname, '..', 'db', 'init.sql'), 'utf8')
    .replace(/CREATE EXTENSION[^;]+;/, '');
  await exec(init);
  await exec(`ALTER TABLE groups ADD COLUMN IF NOT EXISTS dest_bank_code TEXT;
    ALTER TABLE groups ADD COLUMN IF NOT EXISTS dest_account_number TEXT;
    ALTER TABLE groups ADD COLUMN IF NOT EXISTS dest_account_name TEXT;
    ALTER TABLE groups ADD COLUMN IF NOT EXISTS dest_verified BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE groups ADD COLUMN IF NOT EXISTS invite_code TEXT;
    ALTER TABLE disputes ADD COLUMN IF NOT EXISTS reference TEXT NOT NULL DEFAULT '';
    ALTER TABLE disputes ADD COLUMN IF NOT EXISTS note TEXT NOT NULL DEFAULT '';
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
    const h2 = crypto.createHash('sha256').update('fee:' + String(ref) + Date.now()).digest('hex').slice(0, 16);
    const fee = Math.max(0, Number(md.fee) || 0);
    await db.query(`INSERT INTO contributions (id, membership_id, cycle_id, amount, fee, total, method, reference, status)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'CONFIRMED') ON CONFLICT (reference) DO NOTHING`,
      [`ct-${Date.now()}`, md.membership_id, md.cycle_id, md.pot, md.fee, md.pot + md.fee, method, ref]);
    await db.query(`INSERT INTO ledger_entries (id, group_id, debit_acct, credit_acct, amount, type, ref_id, idempotency_key, status, hash)
      VALUES ($1,$2,$3,$4,$5,'contribution',$6,$7,'CONFIRMED',$8) ON CONFLICT (idempotency_key) DO NOTHING`,
      [`le-${Date.now()}`, md.group_id, `psp:${method}`, `pot:${md.group_id}`, md.pot, ref, `webhook:${ref}`, h]);
    // Fee leg belongs to AJOCREDIT revenue — never to the admin/group pot.
    if (fee > 0) {
      await db.query(`INSERT INTO ledger_entries (id, group_id, debit_acct, credit_acct, amount, type, ref_id, idempotency_key, status, hash)
        VALUES ($1,$2,$3,$4,$5,'fee',$6,$7,'CONFIRMED',$8) ON CONFLICT (idempotency_key) DO NOTHING`,
        [`le-${Date.now()}f`, md.group_id, `member:${md.membership_id || 'unknown'}`, `revenue:ajocredit-fees`, fee, ref, `webhook:${ref}:fee`, h2]);
    }
    await db.query(`INSERT INTO audit_log (id, actor_id, action, entity, entity_id) VALUES ($1,$2,'webhook.confirm','contribution',$3)`, [`al-${Date.now()}`, method, ref]);
    // Tell every active member — group activity is shared, not private.
    await announceContribution(md, ref);
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
  // --- Identity binding (dual-mode) -----------------------------------------
  // Every protected route used to trust a client-supplied phone (admin_phone,
  // maker_phone, checker_phone, voter_phone) — so with auth off ANYONE could act
  // as ANY member, e.g. re-point a group's payout account. These guards close
  // that WITHOUT changing behavior while REQUIRE_AUTH is off (pilot). When it is
  // '1', a session token is already required by `auth`, and the claimed identity
  // must belong to that session — otherwise 401/403. Returns null to pass, or
  // { status, error } to reject. One switch (REQUIRE_AUTH) enables/reverts all.
  function authOn() { return process.env.REQUIRE_AUTH === '1'; }
  // require_login = show the account creation / sign-in page. ON by default; set
  // REQUIRE_LOGIN=0 to hide it. Independent of the hard lock so the page can be
  // live while the API is still open for the pilot.
  function loginOn() { return process.env.REQUIRE_LOGIN !== '0'; }
  async function bindPhone(req, claimed) {
    if (!authOn()) return null;
    if (!req.user) return { status: 401, error: 'sign in required' };
    if (!claimed) return null;                       // route asserts no phone; session governs
    const norm = normPhone(claimed);
    if (!norm) return null;                          // let the route's own validation reject it
    const u = await q('SELECT id FROM users WHERE phone=$1', [norm]);
    if (!u.length || u[0].id !== req.user) return { status: 403, error: 'this must be done from your signed-in account' };
    return null;
  }
  async function bindUser(req, claimed) {
    if (!authOn()) return null;
    if (!req.user) return { status: 401, error: 'sign in required' };
    if (!claimed) return null;
    if (String(claimed).slice(0, 32) !== req.user) return { status: 403, error: 'this must be done from your signed-in account' };
    return null;
  }
  async function bindAdmin(req, groupId) {
    if (!authOn()) return null;
    if (!req.user) return { status: 401, error: 'sign in required' };
    if (!(await isAdmin(req.user, groupId))) return { status: 403, error: 'only a group admin can do this' };
    return null;
  }
  async function bindMember(req, membershipId) {
    if (!authOn()) return null;
    if (!req.user) return { status: 401, error: 'sign in required' };
    const r = await q('SELECT id FROM memberships WHERE id=$1 AND user_id=$2', [membershipId, req.user]);
    if (!r.length) return { status: 403, error: 'you can only act on your own membership' };
    return null;
  }
  // Unique invite code: 6 random chars, DB-checked. Replaces gid.slice(2,8), a
  // timestamp prefix that gave every group created in the same window ONE code,
  // so by-code lookup could resolve to the wrong group.
  const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I
  async function newInviteCode() {
    for (let i = 0; i < 25; i++) {
      let c = 'AJ-';
      for (let k = 0; k < 5; k++) c += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
      const dup = await q(`SELECT 1 FROM groups WHERE UPPER(invite_code)=UPPER($1)`, [c]);
      if (!dup.length) return c;
    }
    throw new Error('could not generate a unique invite code — try again');
  }
  // Task 2: member email address, and a log of every transactional email we try to send.
  await exec(`ALTER TABLE users ADD COLUMN IF NOT EXISTS email TEXT;
    CREATE TABLE IF NOT EXISTS email_log (
      id TEXT PRIMARY KEY,
      to_email TEXT,
      kind TEXT NOT NULL,
      subject TEXT,
      body TEXT,
      status TEXT NOT NULL DEFAULT 'queued',
      detail TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());`);

  // ---- Notifications (MVP) --------------------------------------------------
  // In-app notifications are the channel for group activity: a contribution is
  // recorded, a payout is due, a member joins. SMS is reserved for the OTP, the
  // welcome message and a password reset - we do not send bulk SMS to groups.
  // Every transactional email is written to email_log as well as being sent, so we
  // can always see what went out and whether it landed.
  async function recordEmail(row) {
    try {
      await q(`INSERT INTO email_log (id, to_email, kind, subject, body, status, detail) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [`el-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, row.to || '', row.kind || 'general', String(row.subject || '').slice(0, 120), String(row.body || '').slice(0, 2000), row.status || 'queued', String(row.detail || '').slice(0, 300)]);
    } catch (e) {}
  }
  // Group activity notifications: every ACTIVE member sees contributions/payouts/etc.
  async function notifyUser(userId, kind, title, body) {
    try {
      await q(`INSERT INTO notifications (id, user_id, kind, title, body) VALUES ($1,$2,$3,$4,$5)`,
        [`nt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, userId, kind, String(title).slice(0, 80), String(body).slice(0, 200)]);
    } catch (e) {}
  }
  async function notifyGroup(groupId, kind, title, body) {
    try {
      const ms = await q(`SELECT user_id FROM memberships WHERE group_id=$1 AND status='ACTIVE'`, [groupId]);
      for (const m of ms) await notifyUser(m.user_id, kind, title, body);
      return ms.length;
    } catch (e) { return 0; }
  }
  // Announce a confirmed contribution to the whole group (webhook + manual paths).
  async function announceContribution(md, ref) {
    try {
      if (!md || !md.group_id) return;
      const info = await q(`SELECT g.name, g.size, cy.seq FROM groups g, cycles cy WHERE cy.id=$1 AND g.id=$2`, [md.cycle_id, md.group_id]);
      const payer = md.membership_id ? await q(`SELECT u.name FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.id=$1`, [md.membership_id]) : [];
      const paid = await q(`SELECT COUNT(*)::int AS n FROM contributions WHERE cycle_id=$1 AND status='CONFIRMED'`, [md.cycle_id]);
      const gname = info.length ? info[0].name : 'your group';
      const seq = info.length ? info[0].seq : '';
      const size = info.length ? info[0].size : '?';
      await notifyGroup(md.group_id, 'contribution', '💰 Contribution received',
        `₦${Number(md.pot) || 0} confirmed${payer.length ? ' from ' + payer[0].name : ''}${ref ? ' (ref ' + String(ref).slice(0, 24) + ')' : ''} for ${gname} cycle ${seq} · ${paid.length ? paid[0].n : '?'} of ${size} members paid`);
    } catch (e) {}
  }
  // Legacy timestamp-derived codes collide — keep the oldest group per code,
  // regenerate the rest (one-time repair, then a unique index enforces it forever).
  try {
    const dups = await q(`SELECT UPPER(invite_code) AS c FROM groups WHERE invite_code IS NOT NULL GROUP BY UPPER(invite_code) HAVING COUNT(*) > 1`);
    for (const d of dups) {
      const rows = await q(`SELECT id FROM groups WHERE UPPER(invite_code)=UPPER($1) ORDER BY created_at, id`, [d.c]);
      for (const r of rows.slice(1)) await q(`UPDATE groups SET invite_code=$1 WHERE id=$2`, [await newInviteCode(), r.id]);
    }
    await exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_groups_invite_code ON groups (UPPER(invite_code));`);
  } catch (e) { console.log('invite-code repair: ' + e.message); }
  // Payout maker/checker audit columns (see /api/payouts/* below).
  await exec(`ALTER TABLE payouts ADD COLUMN IF NOT EXISTS initiated_by TEXT;
    ALTER TABLE payouts ADD COLUMN IF NOT EXISTS approved_by TEXT;`);

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
  // Clients poll /api/auth/config so the login gate turns on/off with the same switch — no app update needed.
  app.get('/api/auth/config', (req, res) => {
    res.json({ require_auth: authOn(), require_login: loginOn(), app: 'ajocredit' });
  });
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
    const cnb = await bindMember(req, membership_id);
    if (cnb) return res.status(cnb.status).json({ error: cnb.error });
    const { fee, total } = feeFor(amount);
    try {
      // RETURNING tells us whether a row was really inserted. A duplicate reference
      // (webhook delivered twice, retry from a client) must NOT re-announce to the
      // group and must be reported as a duplicate rather than a fresh contribution.
      const ins = await q(`INSERT INTO contributions (id, membership_id, cycle_id, amount, fee, total, method, reference, status)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'CONFIRMED') ON CONFLICT (reference) DO NOTHING RETURNING id`,
        [`ct-${Date.now()}`, membership_id, cycle_id, amount, fee, total, method || 'transfer', reference]);
      if (!ins.length) {
        const ex = await q('SELECT id FROM contributions WHERE reference=$1', [reference]);
        return res.json({ ok: true, duplicate: true, id: ex.length ? ex[0].id : null, amount, fee, total });
      }
      // Announce to the group (resolve group from the membership — manual path has no md).
      const mm = await q('SELECT group_id FROM memberships WHERE id=$1', [membership_id]);
      await announceContribution({ group_id: mm.length ? mm[0].group_id : null, cycle_id, membership_id, pot: amount }, reference);
      res.json({ ok: true, id: ins[0].id, amount, fee, total });
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

  // OTP — Termii Verify API. Rules: 6-digit code, 5-minute expiry, max 3 verification
  // attempts per code, max 3 codes (resends) per hour per phone number. The code is
  // never stored and never logged: we keep only a salted SHA-256 hash plus Termii's
  // pin_id, and Termii's Verify API is the authoritative check. Codes live in the DB
  // (not memory) so a redeploy can't strand a member mid-login.
  const OTP_LENGTH = 6;
  const OTP_TTL_MIN = 5;
  const OTP_MAX_ATTEMPTS = 3;
  const OTP_MAX_SENDS_PER_HOUR = 3;
  const OTP_PURPOSES = ['signup', 'login', 'reset'];
  await exec(`CREATE TABLE IF NOT EXISTS otp_codes (
      id TEXT PRIMARY KEY,
      phone TEXT NOT NULL,
      purpose TEXT NOT NULL,
      pin_id TEXT,
      code_hash TEXT NOT NULL,
      salt TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      attempts INT NOT NULL DEFAULT 0,
      verified_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
    CREATE INDEX IF NOT EXISTS idx_otp_phone ON otp_codes (phone, created_at DESC);`);
  function otpHash(salt, code) { return crypto.createHash('sha256').update(`${salt}:${code}`).digest('hex'); }
  function otpSafeEqual(a, b) {
    const ab = Buffer.from(String(a)), bb = Buffer.from(String(b));
    if (ab.length !== bb.length) return false;
    return crypto.timingSafeEqual(ab, bb);
  }
  // Termii OTP generate/verify live in api/termii.js:
  //   termii.generateOtp(phone, {length, ttlMinutes, attempts}) -> { otp, pinId }
  //   termii.verifyOtp(pinId, pin)                            -> { ok }
  // The plaintext code is used only to build the message; it is never stored or logged.
  app.post('/api/otp/send', async (req, res) => {
    const { phone, purpose } = req.body || {};
    const norm = normPhone(phone);
    if (!norm) return res.status(400).json({ error: 'valid Nigerian phone required (e.g. 08031234567)' });
    // Purpose: signup / login / reset. If the client doesn't say, the server decides
    // from whether the phone is already registered. The purpose is NOT echoed back,
    // so this cannot be used to discover who already has an account.
    let pur = OTP_PURPOSES.includes(purpose) ? purpose : null;
    if (!pur) {
      const u = await q('SELECT id FROM users WHERE phone=$1', [norm]);
      pur = u.length ? 'login' : 'signup';
    }
    // Max 3 codes per hour per phone number (the resend limit).
    const sent = await q(`SELECT COUNT(*)::int AS n FROM otp_codes WHERE phone=$1 AND created_at > NOW() - INTERVAL '1 hour'`, [norm]);
    if (sent.length && sent[0].n >= OTP_MAX_SENDS_PER_HOUR) {
      return res.status(429).json({ error: 'too many codes requested - please try again in an hour' });
    }
    // Generate the code with Termii; we keep only a hash of it.
    const gen = await termii.generateOtp(norm.replace(/^\+/, ''), { length: OTP_LENGTH, ttlMinutes: OTP_TTL_MIN, attempts: OTP_MAX_ATTEMPTS });
    if (!gen.ok) {
      // Friendly, non-technical error - the app must not crash on a Termii outage.
      return res.status(503).json({ ok: false, error: 'Could not send code. Please try again.', detail: gen.detail });
    }
    const smsText = pur === 'reset'
      ? `Your AJOCREDIT reset code is ${gen.otp}. Expires in ${OTP_TTL_MIN} minutes.`
      : `Your AJOCREDIT code is ${gen.otp}. Expires in ${OTP_TTL_MIN} minutes.`;
    // Deliver it over Termii. Only report "sent" when Termii actually delivered it.
    const s1 = await termii.sendSms(norm, smsText);
    if (!s1.delivered) {
      // Friendly, non-technical error - the app must not crash on a Termii outage.
      return res.status(503).json({ ok: false, error: 'Could not send code. Please try again.', detail: s1.detail });
    }
    // Store ONLY a salted hash of the code - never the code itself.
    const salt = crypto.randomBytes(16).toString('hex');
    await q(`INSERT INTO otp_codes (id, phone, purpose, pin_id, code_hash, salt, expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [`otp-${Date.now()}-${crypto.randomBytes(5).toString('hex')}`, norm, pur, gen.pinId, otpHash(salt, gen.otp), salt, new Date(Date.now() + OTP_TTL_MIN * 60 * 1000)]);
    // A password-reset request also emails the member a notice. The reset code
    // itself always goes by SMS to the phone - it is never emailed.
    if (pur === 'reset') {
      try {
        const u = await q('SELECT name, phone, email FROM users WHERE phone=$1', [norm]);
        if (u.length) {
          await mailer.passwordResetEmail({ name: u[0].name, email: u[0].email, phone: u[0].phone, record: recordEmail });
        }
      } catch (e) {}
    }
    res.json({ ok: true, mode: 'termii', expires_in: OTP_TTL_MIN * 60 });
  });
  app.post('/api/otp/verify', async (req, res) => {
    const { phone, code, device_id, name, purpose, email } = req.body || {};
    const norm = normPhone(phone);
    if (!norm) return res.status(400).json({ error: 'valid Nigerian phone required' });
    const pin = String(code || '').replace(/\D/g, '');
    if (pin.length !== OTP_LENGTH) return res.status(400).json({ error: `code must be ${OTP_LENGTH} digits` });
    const rows = await q(`SELECT * FROM otp_codes WHERE phone=$1 AND verified_at IS NULL ORDER BY created_at DESC LIMIT 1`, [norm]);
    if (!rows.length) return res.status(400).json({ error: 'no code sent' });
    const rec = rows[0];
    if (purpose && OTP_PURPOSES.includes(purpose) && purpose !== rec.purpose) {
      return res.status(400).json({ error: 'that code was sent for a different request - please request a new one' });
    }
    if (new Date(rec.expires_at).getTime() < Date.now()) return res.status(401).json({ error: 'expired' });
    if (rec.attempts >= OTP_MAX_ATTEMPTS) {
      // Mark spent rather than delete: the row still counts toward the hourly
      // send limit, so burning attempts cannot be used to buy extra codes.
      await q('UPDATE otp_codes SET verified_at=NOW() WHERE id=$1', [rec.id]);
      return res.status(429).json({ error: 'too many attempts - please request a new code' });
    }
    // Local check against the stored hash - the code itself is never stored.
    const local = otpSafeEqual(rec.code_hash, otpHash(rec.salt, pin));
    // Authoritative check: the Termii Verify API. It is only called once our own
    // hash matches, so a wrong guess never burns the provider's attempt budget.
    let v = { ok: false, detail: 'local hash mismatch' };
    if (local) v = rec.pin_id ? await termii.verifyOtp(rec.pin_id, pin) : { ok: true, detail: 'no pin id' };
    if (!local || !v.ok) {
      await q('UPDATE otp_codes SET attempts=attempts+1 WHERE id=$1', [rec.id]);
      const left = Math.max(0, OTP_MAX_ATTEMPTS - (rec.attempts + 1));
      return res.status(401).json({ error: 'invalid', attempts_left: left });
    }
    await q('UPDATE otp_codes SET verified_at=NOW() WHERE id=$1', [rec.id]);
    try {
      let u = await q('SELECT * FROM users WHERE phone=$1', [norm]);
      const isNew = !u.length;
      const mail = String(email || '').trim().slice(0, 160);
      if (isNew) {
        const uid = `u-${Date.now()}`, aj = 'AJ-' + Math.floor(100000 + Math.random() * 900000);
        // Account creation: the first successful OTP for a phone creates the member.
        // Name is optional - fall back to a neutral placeholder.
        const nm = String(name || '').trim().slice(0, 60) || 'New Member';
        await q(`INSERT INTO users (id, phone, name, email, verification, ajocredit_id, score, tier, provisional) VALUES ($1,$2,$3,$4,'OTP',$5,250,'Bronze',TRUE)`, [uid, norm, nm, mail || null, aj]);
        u = await q('SELECT * FROM users WHERE id=$1', [uid]);
      } else if (mail && !u[0].email) {
        // An existing member adding their email address for the first time.
        await q('UPDATE users SET email=$1 WHERE id=$2', [mail, u[0].id]);
        u = await q('SELECT * FROM users WHERE id=$1', [u[0].id]);
      }
      if (rec.purpose === 'reset') {
        // Account recovery: the member proved control of the phone, so drop every
        // existing session before a fresh one is issued.
        await q('UPDATE sessions SET expires_at=NOW() WHERE user_id=$1', [u[0].id]);
      }
      if (device_id) {
        await q(`INSERT INTO devices (id, user_id, device_id, last_seen) VALUES ($1,$2,$3,NOW())
          ON CONFLICT (user_id, device_id) DO UPDATE SET last_seen=NOW()`, [`dv-${Date.now()}`, u[0].id, device_id]);
      }
      await q(`INSERT INTO audit_log (id, actor_id, action, entity, entity_id, detail) VALUES ($1,$2,$3,'user',$4,$5)`,
        [`al-${Date.now()}`, u[0].id, `otp.${rec.purpose}`, u[0].id, JSON.stringify({ purpose: rec.purpose, created: isNew })]);
      // Session token: random 256-bit, stored hashed, 30-day expiry, bound to device.
      const token = crypto.randomBytes(32).toString('hex');
      const thash = crypto.createHash('sha256').update(token).digest('hex');
      await q(`INSERT INTO sessions (id, user_id, token_hash, device_id, expires_at) VALUES ($1,$2,$3,$4,NOW() + INTERVAL '30 days')`,
        [`se-${Date.now()}`, u[0].id, thash, device_id || '']);
      // Welcome the new member - SMS and email, once, at sign-up only.
      if (isNew) {
        const wtxt = `Welcome to AJOCREDIT! Your ID is ${u[0].ajocredit_id}. Your score starts at 250 (Bronze). Open the app to create or join a group.`;
        termii.sendSms(norm, wtxt).then((r) => { if (!r.delivered) console.log('welcome sms failed: ' + r.detail); });
        await mailer.welcomeEmail({ name: u[0].name, email: u[0].email, ajocreditId: u[0].ajocredit_id, record: recordEmail });
      }
      res.json({ ok: true, ajocredit_id: u[0].ajocredit_id, user_id: u[0].id, token, purpose: rec.purpose, created: isNew });
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
      // Log to the sender's notifications (resolve by phone; WhatsApp numbers arrive
      // as bare international digits). Was: broken double-quoted SQL + hardcoded u-bola.
      try {
        const wu = await q('SELECT id FROM users WHERE phone=$1', [normPhone(from)]);
        if (wu.length) await notifyUser(wu[0].id, 'whatsapp', 'WhatsApp: ' + text.slice(0, 40), reply.slice(0, 200));
      } catch (e) {}
      res.json({ ok: true, reply, sent: Boolean(token && phoneId && msg) });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  // Direct-settlement payments (PAYMENTS_MODE=direct): money settles to the group's own
  // destination account (admin/recipient), never an AJOCREDIT balance. Pooled mode (custodian) is gated.
  // Bank lists are cached 12h in memory: keeps cold starts fast and survives PSP blips (serves stale).
  const bankCache = new Map();
  app.get('/api/banks', async (req, res) => {
    const pv = (req.query || {}).provider === 'flutterwave' ? 'flutterwave' : 'paystack';
    const hit = bankCache.get(pv);
    if (hit && Date.now() - hit.at < 12 * 60 * 60 * 1000) return res.json(hit.banks);
    try {
      let banks;
      if (pv === 'flutterwave') {
        const r = await fetch('https://api.flutterwave.com/v3/banks/NG', { headers: FLW_HDR(), signal: AbortSignal.timeout(15000) });
        const j = await r.json();
        banks = (((j.data || j) instanceof Array ? (j.data || j) : []).map((b) => ({ name: b.name, code: String(b.code) })));
      } else {
        const r = await fetch('https://api.paystack.co/bank?country=nigeria', { headers: PS_HDR(), signal: AbortSignal.timeout(15000) });
        const j = await r.json();
        banks = ((j.data || []).map((b) => ({ name: b.name, code: b.code })));
      }
      if (banks && banks.length) bankCache.set(pv, { at: Date.now(), banks });
      res.json(banks);
    } catch (e) {
      const stale = bankCache.get(pv);
      if (stale) return res.json(stale.banks);
      res.status(502).json({ error: 'Bank list temporarily unavailable. Try again.' });
    }
  });
  app.post('/api/groups/:id/destination', auth, async (req, res) => {
    const gb = await bindAdmin(req, req.params.id);
    if (gb) return res.status(gb.status).json({ error: gb.error });
    const { bank_code, account_number, provider } = req.body || {};
    if (!bank_code || !account_number) return res.status(400).json({ error: 'bank_code + account_number required' });
    try {
      let account_name;
      if ((provider || 'paystack') === 'flutterwave') {
        const r = await fetch('https://api.flutterwave.com/v3/accounts/resolve', {
          method: 'POST', headers: FLW_HDR(), signal: AbortSignal.timeout(20000), body: JSON.stringify({ account_number, account_bank: bank_code }),
        });
        const j = await r.json();
        if (j.status !== 'success') return res.status(422).json({ error: j.message || 'account could not be verified' });
        account_name = j.data.account_name;
      } else {
        const r = await fetch(`https://api.paystack.co/bank/resolve?account_number=${account_number}&bank_code=${bank_code}`, { headers: PS_HDR(), signal: AbortSignal.timeout(20000) });
        const j = await r.json();
        if (!j.status) return res.status(422).json({ error: j.message || 'account could not be verified' });
        account_name = j.data.account_name;
      }
      await db.query('UPDATE groups SET dest_bank_code=$1, dest_account_number=$2, dest_account_name=$3, dest_verified=TRUE WHERE id=$4',
        [bank_code, account_number, account_name, req.params.id]);
      res.json({ ok: true, account_name, provider: provider || 'paystack', mode: PAYS_MODE });
    } catch (e) { res.status(502).json({ error: 'Verification service timed out. Check the details and try again.' }); }
  });
  app.post('/api/payments/init', async (req, res) => {
    const { group_id, membership_id, cycle_id, amount, email, phone } = req.body || {};
    if (!group_id || !membership_id || !cycle_id || !amount) return res.status(400).json({ error: 'group_id, membership_id, cycle_id, amount required' });
    const g = await q('SELECT * FROM groups WHERE id=$1', [group_id]);
    if (!g.length) return res.status(404).json({ error: 'group not found' });
    // Membership gate: a PENDING (unapproved) member must wait for the admin.
    if (phone) {
      const pu = await q('SELECT * FROM users WHERE phone=$1', [normPhone(phone) || phone]);
      if (!pu.length) return res.status(403).json({ error: 'Join the group first, then pay.' });
      const pm = await q('SELECT status FROM memberships WHERE user_id=$1 AND group_id=$2', [pu[0].id, group_id]);
      if (!pm.length) return res.status(403).json({ error: 'Join the group first, then pay.' });
      if (pm[0].status !== 'ACTIVE') return res.status(403).json({ error: 'Waiting for admin approval — you can pay once approved.' });
    }
    const { fee, total } = feeFor(amount);
    const reference = `AJO-${Date.now()}`;
    const meta = { group_id, membership_id, cycle_id, pot: amount, fee };
    const destination = g[0].dest_verified ? { bank: g[0].dest_bank_code, account: '••' + String(g[0].dest_account_number).slice(-4), name: g[0].dest_account_name } : null;
    if (!destination) return res.status(422).json({ ok: false, error: 'Payout account not linked yet — ask your admin to verify it before contributing.' });
    // Primary: Flutterwave hosted checkout link (v3 /payments). Backup: Paystack inline config.
    // 20s cap on PSP calls: a hanging PSP must never wedge the client past its own timeout.
    try {
      const r = await fetch('https://api.flutterwave.com/v3/payments', {
        method: 'POST', headers: FLW_HDR(), signal: AbortSignal.timeout(20000),
        body: JSON.stringify({ tx_ref: reference, amount: total, currency: 'NGN',
          redirect_url: (process.env.FRONTEND_URL || 'https://ajocredit.pages.dev').replace(/\/$/, ''),
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
      // Fall back to Paystack ONLY when its key is live. A test key (pk_test_) must never be
      // handed to a real member: they'd be sent to a checkout that can't take real money, and a
      // test-mode webhook could confirm a contribution with no money behind it. Once
      // PAYSTACK_PUBLIC_KEY is switched to pk_live_ this backup activates automatically.
      const pk = process.env.PAYSTACK_PUBLIC_KEY || '';
      if (pk.startsWith('pk_live_')) {
        return res.json({ ok: true, provider: 'paystack', mode: PAYS_MODE, amount, fee, total, amount_kobo: total * 100,
          paystack_key: pk,
          reference: `${group_id.slice(0, 8)}-C${cycle_id.slice(-2)}-${Date.now()}`,
          destination, metadata: meta });
      }
      // Flutterwave hiccup while Paystack isn't live yet: fail cleanly, never silently downgrade.
      return res.json({ ok: false, error: 'Payment provider is busy — no charge was made. Please try again in a moment.' });
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
      const lh2 = crypto.createHmac('sha256', (PSK() || 'ajocredit') + 'fee').update(String(ref)).digest('hex').slice(0, 16);
      const pfee = Math.max(0, Number(md.fee) || 0);
      try {
        await db.query(`INSERT INTO contributions (id, membership_id, cycle_id, amount, fee, total, method, reference, status)
          VALUES ($1,$2,$3,$4,$5,$6,'paystack',$7,'CONFIRMED') ON CONFLICT (reference) DO NOTHING`,
          [`ct-${Date.now()}`, md.membership_id, md.cycle_id, md.pot, md.fee, md.pot + md.fee, ref]);
        await db.query(`INSERT INTO ledger_entries (id, group_id, debit_acct, credit_acct, amount, type, ref_id, idempotency_key, status, hash)
          VALUES ($1,$2,'psp:paystack',$3,$4,'contribution',$5,$6,'CONFIRMED',$7) ON CONFLICT (idempotency_key) DO NOTHING`,
          [`le-${Date.now()}`, md.group_id, `pot:${md.group_id}`, md.pot, ref, `webhook:${ref}`, lh]);
        if (pfee > 0) {
          await db.query(`INSERT INTO ledger_entries (id, group_id, debit_acct, credit_acct, amount, type, ref_id, idempotency_key, status, hash)
            VALUES ($1,$2,$3,$4,$5,'fee',$6,$7,'CONFIRMED',$8) ON CONFLICT (idempotency_key) DO NOTHING`,
            [`le-${Date.now()}f`, md.group_id, `member:${md.membership_id || 'unknown'}`, `revenue:ajocredit-fees`, pfee, ref, `webhook:${ref}:fee`, lh2]);
        }
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
    const ab = await bindPhone(req, admin_phone);
    if (ab) return res.status(ab.status).json({ error: ab.error });
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
      const icode = await newInviteCode();
      await q(`INSERT INTO groups (id, name, type, amount, size, frequency, payout_mode, status, rules, invite_code) VALUES ($1,$2,'ROTATIONAL',$3,$4,$5,$6,'FORMING','{\"grace_hours\":48}',$7)`,
        [gid, String(name).trim(), +amount, nsize, frequency || 'Weekly', payout_mode || 'random', icode]);
      await q(`INSERT INTO memberships (id, user_id, group_id, role, status) VALUES ($1,$2,$3,'admin','ACTIVE')`, [`m-${now}`, u[0].id, gid]);
      // Cycle 1 must exist at birth: contributions.cycle_id is a real FK — without this
      // every later contribution/webhook confirm for a new group fails with FK violation.
      const cid = `c-${gid.slice(2)}-1`;
      await q(`INSERT INTO cycles (id, group_id, seq, due_date, pot_expected, pot_collected, status) VALUES ($1,$2,1,NOW() + INTERVAL '7 days',$3,0,'COLLECTING') ON CONFLICT (id) DO NOTHING`,
        [cid, gid, (+amount) * nsize]);
      await q(`INSERT INTO audit_log (id, actor_id, action, entity, entity_id) VALUES ($1,$2,'group.create','group',$3)`, [`al-${now}`, u[0].id, gid]);
      res.json({ ok: true, group_id: gid, invite_code: icode, admin: u[0].ajocredit_id, user_id: u[0].id, cycle_id: cid });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });
  app.get('/api/groups/:id/requests', auth, async (req, res) => {
    const phone = normPhone((req.query || {}).admin_phone);
    const rb = await bindPhone(req, phone);
    if (rb) return res.status(rb.status).json({ error: rb.error });
    if (!phone) return res.status(400).json({ error: 'admin_phone required' });
    const u = await q('SELECT * FROM users WHERE phone=$1', [phone]);
    if (!u.length || !(await isAdmin(u[0].id, req.params.id))) return res.status(403).json({ error: 'admin only' });
    res.json(await q(`SELECT m.id, m.status, u.name, u.phone, u.ajocredit_id FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.group_id=$1 AND m.status='PENDING' ORDER BY m.joined_at`, [req.params.id]));
  });
  app.post('/api/memberships/:id/decision', auth, async (req, res) => {
    const { admin_phone, decision } = req.body || {};
    if (decision !== 'approve' && decision !== 'reject') return res.status(400).json({ error: "decision must be 'approve' or 'reject'" });
    const phone = normPhone(admin_phone);
    const db2 = await bindPhone(req, phone);
    if (db2) return res.status(db2.status).json({ error: db2.error });
    if (!phone) return res.status(400).json({ error: 'admin_phone required' });
    try {
      const m = await q('SELECT * FROM memberships WHERE id=$1', [req.params.id]);
      if (!m.length) return res.status(404).json({ error: 'request not found' });
      const u = await q('SELECT * FROM users WHERE phone=$1', [phone]);
      if (!u.length || !(await isAdmin(u[0].id, m[0].group_id))) return res.status(403).json({ error: 'admin only' });
      const st = decision === 'approve' ? 'ACTIVE' : 'REMOVED';
      await q(`UPDATE memberships SET status=$1 WHERE id=$2`, [st, req.params.id]);
      await q(`INSERT INTO audit_log (id, actor_id, action, entity, entity_id) VALUES ($1,$2,$3,'membership',$4)`, [`al-${Date.now()}`, u[0].id, 'member.' + decision, req.params.id]);
      // Tell the member the outcome, and tell the group when someone joins.
      const gname = await q('SELECT name FROM groups WHERE id=$1', [m[0].group_id]);
      const gnameS = gname.length ? gname[0].name : 'the group';
      if (decision === 'approve') {
        const who = await q('SELECT name FROM users WHERE id=$1', [m[0].user_id]);
        const wname = who.length ? who[0].name : 'A new member';
        await notifyUser(m[0].user_id, 'joined', "You're in! ✅", `Your request to join ${gnameS} was approved. Contributions are open — tap Pay when due.`);
        await notifyGroup(m[0].group_id, 'member', 'New member 👋', `${wname} joined ${gnameS}. Say welcome!`);
      } else {
        await notifyUser(m[0].user_id, 'join_rejected', 'Request not approved', `The admin did not approve your request to join ${gnameS}. You can request again or contact the admin.`);
      }
      res.json({ ok: true, status: st });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  app.post('/api/disputes', auth, async (req, res) => {
    const { group_id, reference, note, category, user_id } = req.body || {};
    if (!group_id || !reference) return res.status(400).json({ error: 'group_id, reference required' });
    const xb = await bindUser(req, user_id);
    if (xb) return res.status(xb.status).json({ error: xb.error });
    try {
      const id = `d-${Date.now()}`;
      const who = String(user_id || 'u-bola').slice(0, 32);
      await q(`INSERT INTO disputes (id, group_id, raised_by, category, reference, note, status) VALUES ($1,$2,$3,$4,$5,$6,'OPEN')`,
        [id, group_id, who, category || 'non-payment', String(reference || '').slice(0, 64), String(note || '').slice(0, 500)]);
      await q(`INSERT INTO audit_log (id, actor_id, action, entity, entity_id) VALUES ($1,$2,'dispute.open','dispute',$3)`,
        [`al-${Date.now()}`, who, id]);
      res.json({ ok: true, id, status: 'OPEN' });
    } catch (e) { res.status(500).json({ ok: false, error: 'Could not file dispute. Try again.' }); }
  });
  app.get('/api/disputes/group/:gid', auth, async (req, res) => {
    res.json(await q(`SELECT id, group_id, raised_by, category, reference, note, status, created_at FROM disputes WHERE group_id=$1 ORDER BY created_at DESC LIMIT 20`, [req.params.gid]));
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
    const eb = await bindUser(req, user_id);
    if (eb) return res.status(eb.status).json({ error: eb.error });
    try {
      const ref = `EXIT-${Date.now()}`;
      const extra = replacement_name ? ` Replacement: ${String(replacement_name).slice(0, 60)} ${String(replacement_phone || '').slice(0, 20)}.` : '';
      await notifyUser(user_id, 'exit', `Exit recorded (${kind}-payout)`,
        `Ref ${ref}. ${kind === 'post' ? 'Immediate default, review opened.' : 'Replacement invited, 7-day window.'}${extra}`);
      // The whole group feels an exit — tell every active member.
      const eg = await q('SELECT name FROM groups WHERE id=$1', [group_id]);
      const eu = await q('SELECT name FROM users WHERE id=$1', [user_id]);
      await notifyGroup(group_id, 'exit', 'Member exit 🚪',
        `${eu.length ? eu[0].name : 'A member'} recorded a ${kind === 'post' ? 'post' : 'pre'}-payout exit from ${eg.length ? eg[0].name : 'the group'}. Ref ${ref}.`);
      if (kind === 'post') {
        await q(`INSERT INTO disputes (id, group_id, raised_by, category, status) VALUES ($1,$2,$3,'non-payment','OPEN')`, [`d-${Date.now()}`, group_id, user_id]);
      }
      res.json({ ok: true, ref });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });
  app.get('/api/groups/:id/members', async (req, res) => {
    res.json(await q(`SELECT m.id, m.role, m.payout_slot, m.status, u.name, u.ajocredit_id FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.group_id=$1 ORDER BY m.payout_slot NULLS LAST`, [req.params.id]));
  });
  // Payout order engine: random draw (auditable shuffle), admin assignment, member voting.
  app.post('/api/groups/:id/order', auth, async (req, res) => {
    const { admin_phone, mode, order } = req.body || {};
    if (mode !== 'random' && mode !== 'admin') return res.status(400).json({ error: "mode must be 'random' or 'admin'" });
    const phone = normPhone(admin_phone);
    const ob = await bindPhone(req, phone);
    if (ob) return res.status(ob.status).json({ error: ob.error });
    if (!phone) return res.status(400).json({ error: 'admin_phone required' });
    try {
      const u = await q('SELECT * FROM users WHERE phone=$1', [phone]);
      if (!u.length || !(await isAdmin(u[0].id, req.params.id))) return res.status(403).json({ error: 'admin only' });
      const act = await q(`SELECT id FROM memberships WHERE group_id=$1 AND status='ACTIVE' ORDER BY joined_at`, [req.params.id]);
      if (!act.length) return res.status(422).json({ error: 'no active members yet' });
      let seq;
      if (mode === 'random') {
        seq = act.map((x) => x.id);
        for (let i = seq.length - 1; i > 0; i--) { const k = Math.floor(Math.random() * (i + 1)); const t = seq[i]; seq[i] = seq[k]; seq[k] = t; }
      } else {
        if (!(order instanceof Array) || order.length !== act.length) return res.status(400).json({ error: 'order must list every active member once' });
        const have = {}; for (const x of act) have[x.id] = 1;
        for (const id of order) { if (!have[id]) return res.status(400).json({ error: 'order lists an unknown member' }); }
        if (new Set(order).size !== order.length) return res.status(400).json({ error: 'order lists a member twice' });
        seq = order;
      }
      for (let i = 0; i < seq.length; i++) await q(`UPDATE memberships SET payout_slot=$1 WHERE id=$2`, [i + 1, seq[i]]);
      await q(`UPDATE groups SET payout_mode=$1 WHERE id=$2`, [mode, req.params.id]);
      await q(`INSERT INTO audit_log (id, actor_id, action, entity, entity_id) VALUES ($1,$2,$3,'group',$4)`, [`al-${Date.now()}`, u[0].id, 'payout.order.' + mode, req.params.id]);
      res.json({ ok: true, mode, slots: seq.length });
    } catch (e) { res.status(500).json({ ok: false, error: 'Could not save order. Try again.' }); }
  });
  app.post('/api/groups/:id/vote', auth, async (req, res) => {
    const { voter_phone, candidate_id } = req.body || {};
    const phone = normPhone(voter_phone);
    const vb = await bindPhone(req, phone);
    if (vb) return res.status(vb.status).json({ error: vb.error });
    if (!phone || !candidate_id) return res.status(400).json({ error: 'voter_phone, candidate_id required' });
    try {
      const u = await q('SELECT * FROM users WHERE phone=$1', [phone]);
      if (!u.length) return res.status(403).json({ error: 'join the group first' });
      const vm = await q(`SELECT id FROM memberships WHERE user_id=$1 AND group_id=$2 AND status='ACTIVE'`, [u[0].id, req.params.id]);
      if (!vm.length) return res.status(403).json({ error: 'only active members vote' });
      const cm = await q(`SELECT id FROM memberships WHERE id=$1 AND group_id=$2 AND status='ACTIVE'`, [candidate_id, req.params.id]);
      if (!cm.length) return res.status(404).json({ error: 'candidate not in group' });
      await q(`INSERT INTO votes (id, group_id, voter_membership_id, candidate_membership_id) VALUES ($1,$2,$3,$4)
        ON CONFLICT (group_id, voter_membership_id) DO UPDATE SET candidate_membership_id=$4`,
        [`v-${Date.now()}`, req.params.id, vm[0].id, candidate_id]);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ ok: false, error: 'Could not record vote. Try again.' }); }
  });
  app.get('/api/groups/:id/votes', async (req, res) => {
    res.json(await q(`SELECT m.id AS membership_id, u.name, COUNT(v.id)::int AS votes
      FROM memberships m JOIN users u ON u.id=m.user_id
      LEFT JOIN votes v ON v.candidate_membership_id=m.id AND v.group_id=m.group_id
      WHERE m.group_id=$1 AND m.status='ACTIVE' GROUP BY m.id, u.name ORDER BY COUNT(v.id) DESC, MIN(m.joined_at)`, [req.params.id]));
  });

  app.get('/api/groups/mine', auth, async (req, res) => {
    const phone = normPhone((req.query || {}).phone);
    const mb = await bindPhone(req, phone);
    if (mb) return res.status(mb.status).json({ error: mb.error });
    if (!phone) return res.status(400).json({ error: 'phone required' });
    const u = await q('SELECT * FROM users WHERE phone=$1', [phone]);
    if (!u.length) return res.json([]);
    res.json(await q(`SELECT g.id, g.name, g.invite_code, g.amount, g.frequency, m.role, m.status FROM memberships m JOIN groups g ON g.id=m.group_id WHERE m.user_id=$1 ORDER BY m.joined_at DESC`, [u[0].id]));
  });
  app.get('/api/groups/by-code/:code', async (req, res) => {
    const g = await q(`SELECT g.*, (SELECT COUNT(*) FROM memberships m WHERE m.group_id=g.id AND m.status='ACTIVE') AS members FROM groups g WHERE UPPER(g.invite_code)=UPPER($1)`, [req.params.code]);
    if (!g.length) return res.status(404).json({ error: 'no group with that code' });
    const cy = await q(`SELECT id, seq, due_date, status FROM cycles WHERE group_id=$1 ORDER BY seq DESC LIMIT 1`, [g[0].id]);
    res.json({ ok: true, group: g[0], cycle: cy[0] || null });
  });
  app.post('/api/groups/:id/join', auth, async (req, res) => {
    const phone = normPhone((req.body || {}).phone);
    const jb = await bindPhone(req, phone);
    if (jb) return res.status(jb.status).json({ error: jb.error });
    const name = String((req.body || {}).name || '').trim();
    if (!phone) return res.status(400).json({ error: 'valid Nigerian phone required (e.g. 08031234567)' });
    if (name.length < 2) return res.status(400).json({ error: 'your name is required' });
    try {
      let u = await q('SELECT * FROM users WHERE phone=$1', [phone]);
      if (!u.length) {
        const uid = `u-${Date.now()}`, aj = 'AJ-' + Math.floor(100000 + Math.random() * 900000);
        await q(`INSERT INTO users (id, phone, name, verification, ajocredit_id, score, tier, provisional) VALUES ($1,$2,$3,'OTP',$4,250,'Bronze',TRUE)`, [uid, phone, name, aj]);
        u = await q('SELECT * FROM users WHERE id=$1', [uid]);
      } else if ((u[0].name || '') === 'New Member' && name.length >= 2) {
        // Account was created by OTP with a placeholder name — adopt the first real
        // name the member gives us. Never overwrite a name they've already set.
        await q('UPDATE users SET name=$1 WHERE id=$2', [String(name).slice(0, 60), u[0].id]);
        u = await q('SELECT * FROM users WHERE id=$1', [u[0].id]);
      }
      const ex = await q('SELECT id, status FROM memberships WHERE user_id=$1 AND group_id=$2', [u[0].id, req.params.id]);
      if (ex.length) return res.json({ ok: true, status: ex[0].status, note: 'already requested', user_id: u[0].id, ajocredit_id: u[0].ajocredit_id });
      const mid = `m-${Date.now()}`;
      await q(`INSERT INTO memberships (id, user_id, group_id, role, status) VALUES ($1,$2,$3,'member','PENDING')`, [mid, u[0].id, req.params.id]);
      await q(`INSERT INTO audit_log (id, actor_id, action, entity, entity_id) VALUES ($1,$2,'group.join','membership',$3)`, [`al-${Date.now()}`, u[0].id, req.params.id]);
      // Notify every active admin: approval happens in-app, never automatically.
      try {
        const admins = await q(`SELECT user_id FROM memberships WHERE group_id=$1 AND role='admin' AND status='ACTIVE'`, [req.params.id]);
        const gnm = await q(`SELECT name FROM groups WHERE id=$1`, [req.params.id]);
        for (const a of admins) {
          await notifyUser(a.user_id, 'join_request', 'New join request',
            `${u[0].name} (${u[0].phone}) wants to join ${gnm.length ? gnm[0].name : 'your group'}. Open Groups → Requests to approve.`);
        }
      } catch (e) {}
      res.json({ ok: true, status: 'PENDING', note: 'admin approval pending', user_id: u[0].id, ajocredit_id: u[0].ajocredit_id });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  // ---------------- End-of-cycle payout (maker initiates, checker approves) ----------------
  // Non-custodial: a payout records the group handing the pot to the cycle's
  // beneficiary from the group's OWN bank account. Maker ≠ checker (THREAT-MODEL T5).
  async function collectedPot(cycleId) {
    const r = await q(`SELECT COALESCE(SUM(amount),0)::int AS pot FROM contributions WHERE cycle_id=$1 AND status='CONFIRMED'`, [cycleId]);
    return r.length ? r[0].pot : 0;
  }
  app.get('/api/payouts/:groupId', auth, async (req, res) => {
    try {
      const cy = await q('SELECT * FROM cycles WHERE group_id=$1 ORDER BY seq DESC LIMIT 1', [req.params.groupId]);
      if (!cy.length) return res.json({ ok: true, payout: null, cycle: null });
      const p = await q('SELECT * FROM payouts WHERE cycle_id=$1', [cy[0].id]);
      const ben = p.length ? await q('SELECT u.name FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.id=$1', [p[0].beneficiary_id]) : [];
      res.json({ ok: true, cycle: cy[0], collected: await collectedPot(cy[0].id), payout: p[0] || null,
        beneficiary_name: ben.length ? ben[0].name : null });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });
  app.post('/api/payouts/initiate', auth, async (req, res) => {
    const { group_id, cycle_id, maker_phone, beneficiary_membership_id, amount } = req.body || {};
    const pb = await bindPhone(req, maker_phone);
    if (pb) return res.status(pb.status).json({ error: pb.error });
    const phone = normPhone(maker_phone);
    if (!group_id) return res.status(400).json({ error: 'group_id required' });
    if (!phone) return res.status(400).json({ error: 'maker_phone required' });
    try {
      const u = await q('SELECT * FROM users WHERE phone=$1', [phone]);
      if (!u.length || !(await isAdmin(u[0].id, group_id))) return res.status(403).json({ error: 'only a group admin can initiate a payout' });
      const cy = cycle_id
        ? await q('SELECT * FROM cycles WHERE id=$1 AND group_id=$2', [cycle_id, group_id])
        : await q('SELECT * FROM cycles WHERE group_id=$1 ORDER BY seq DESC LIMIT 1', [group_id]);
      if (!cy.length) return res.status(404).json({ error: 'no cycle found for this group' });
      const cyc = cy[0];
      // Beneficiary defaults to the next payout slot (frozen order, slot 1 first).
      let ben = beneficiary_membership_id
        ? await q(`SELECT * FROM memberships WHERE id=$1 AND group_id=$2 AND status='ACTIVE'`, [beneficiary_membership_id, group_id])
        : await q(`SELECT * FROM memberships WHERE group_id=$1 AND status='ACTIVE' ORDER BY payout_slot NULLS LAST, joined_at LIMIT 1`, [group_id]);
      if (!ben.length) return res.status(422).json({ error: 'no active member can receive this payout — set the payout order first' });
      const pot = await collectedPot(cyc.id);
      const amt = Number.isFinite(+amount) && +amount > 0 ? Math.floor(+amount) : pot;
      // Guards: shortfall blocked, duplicate payout blocked.
      if (pot <= 0) return res.status(409).json({ error: 'nothing collected for this cycle yet — payout blocked' });
      if (amt > pot) return res.status(409).json({ error: `shortfall blocked: pot is ₦${pot.toLocaleString()}, cannot pay ₦${amt.toLocaleString()}` });
      const dup = await q(`SELECT id, status FROM payouts WHERE idempotency_key=$1`, [`payout:${cyc.id}`]);
      if (dup.length) return res.status(409).json({ error: `payout already ${dup[0].status.toLowerCase()} for this cycle`, payout_id: dup[0].id });
      const pid = `po-${Date.now()}`;
      await q(`INSERT INTO payouts (id, group_id, cycle_id, beneficiary_id, amount, status, idempotency_key, initiated_by) VALUES ($1,$2,$3,$4,$5,'PENDING',$6,$7)`,
        [pid, group_id, cyc.id, ben[0].id, amt, `payout:${cyc.id}`, u[0].id]);
      await q(`INSERT INTO audit_log (id, actor_id, action, entity, entity_id) VALUES ($1,$2,'payout.initiate','payout',$3)`, [`al-${Date.now()}`, u[0].id, pid]);
      // All admins get pinged that a second pair of eyes is needed.
      const bn = await q('SELECT u.name FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.id=$1', [ben[0].id]);
      const admins = await q(`SELECT user_id FROM memberships WHERE group_id=$1 AND role='admin' AND status='ACTIVE'`, [group_id]);
      for (const a of admins) await notifyUser(a.user_id, 'payout_pending', 'Payout awaiting approval ⏳',
        `₦${amt.toLocaleString()} to ${bn.length ? bn[0].name : 'beneficiary'} (cycle ${cyc.seq}) is ready. A second person must approve — maker ≠ checker.`);
      res.json({ ok: true, payout_id: pid, status: 'PENDING', amount: amt, beneficiary: bn.length ? bn[0].name : null,
        note: 'awaiting a second approver (maker ≠ checker)' });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });
  app.post('/api/payouts/approve', auth, async (req, res) => {
    const { payout_id, checker_phone } = req.body || {};
    const cb = await bindPhone(req, checker_phone);
    if (cb) return res.status(cb.status).json({ error: cb.error });
    const phone = normPhone(checker_phone);
    if (!payout_id) return res.status(400).json({ error: 'payout_id required' });
    if (!phone) return res.status(400).json({ error: 'checker_phone required' });
    try {
      const p = await q('SELECT * FROM payouts WHERE id=$1', [payout_id]);
      if (!p.length) return res.status(404).json({ error: 'payout not found' });
      const po = p[0];
      if (po.status !== 'PENDING') return res.status(409).json({ error: `payout already ${po.status.toLowerCase()}` });
      const u = await q('SELECT * FROM users WHERE phone=$1', [phone]);
      // Checker must be an active member of the group — and never the maker.
      const cm = u.length ? await q(`SELECT id FROM memberships WHERE user_id=$1 AND group_id=$2 AND status='ACTIVE'`, [u[0].id, po.group_id]) : [];
      if (!cm.length) return res.status(403).json({ error: 'checker must be an active member of the group' });
      if (po.initiated_by && u[0].id === po.initiated_by) return res.status(403).json({ error: 'self-approve blocked — a different person must approve (maker ≠ checker)' });
      // Re-check the shortfall at approval time (contributions may have been disputed).
      const pot = await collectedPot(po.cycle_id);
      if (po.amount > pot) return res.status(409).json({ error: `shortfall at approval: pot is ₦${pot.toLocaleString()}, payout ₦${po.amount.toLocaleString()} — blocked` });
      const ben = await q('SELECT u.name, u.id FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.id=$1', [po.beneficiary_id]);
      await q(`UPDATE payouts SET status='APPROVED', approved_by=$1, executed_at=NOW() WHERE id=$2`, [u[0].id, po.id]);
      await q(`INSERT INTO ledger_entries (id, group_id, debit_acct, credit_acct, amount, type, ref_id, idempotency_key, status, hash)
        VALUES ($1,$2,$3,$4,$5,'payout',$6,$7,'CONFIRMED',$8) ON CONFLICT (idempotency_key) DO NOTHING`,
        [`le-${Date.now()}p`, po.group_id, `pot:${po.group_id}`, `member:${po.beneficiary_id}`, po.amount, po.id, `payout:${po.id}`, `h${Date.now()}p`]);
      await q(`INSERT INTO audit_log (id, actor_id, action, entity, entity_id) VALUES ($1,$2,'payout.approve','payout',$3)`, [`al-${Date.now()}`, u[0].id, po.id]);
      // Close this cycle and open the next one (same cadence as the group's frequency).
      await q(`UPDATE cycles SET status='PAID_OUT' WHERE id=$1`, [po.cycle_id]);
      const g = await q('SELECT * FROM groups WHERE id=$1', [po.group_id]);
      const days = /month/i.test(g[0].frequency) ? 28 : /day/i.test(g[0].frequency) ? 1 : 7;
      const ncid = `c-${po.group_id.slice(2)}-${Number(cycSeq(po.cycle_id)) + 1}`;
      await q(`INSERT INTO cycles (id, group_id, seq, due_date, pot_expected, pot_collected, status) VALUES ($1,$2,$3,NOW() + INTERVAL '${days} days',$4,0,'COLLECTING') ON CONFLICT (id) DO NOTHING`,
        [ncid, po.group_id, Number(cycSeq(po.cycle_id)) + 1, g[0].amount * g[0].size]);
      // Everyone hears about it: payout done + next cycle now open.
      await notifyGroup(po.group_id, 'payout', '🎉 Payout completed',
        `₦${po.amount.toLocaleString()} released to ${ben.length ? ben[0].name : 'the beneficiary'} (cycle ${cycSeq(po.cycle_id)}). Approved by a second member.`);
      await notifyGroup(po.group_id, 'due', `Cycle ${Number(cycSeq(po.cycle_id)) + 1} is open`,
        `₦${g[0].amount.toLocaleString()} due in ${days} days — pay early to keep your score. Next up: see Payout order.`);
      res.json({ ok: true, status: 'APPROVED', payout_id: po.id, amount: po.amount,
        beneficiary: ben.length ? ben[0].name : null, next_cycle_id: ncid });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });
  function cycSeq(cycleId) { const m = String(cycleId).match(/-(\d+)$/); return m ? m[1] : '1'; }

  app.listen(PORT, '0.0.0.0', () => console.log(`AJOCREDIT API on :${PORT}`));
}

main().catch((e) => { console.error('API-FAIL:', e.message); process.exit(1); });
process.on('unhandledRejection', (e) => console.error('UNHANDLED:', e && e.message ? e.message : e));

// Graceful shutdown. Render (and any process manager) sends SIGTERM on every
// deploy and restart: closing the database cleanly stops the embedded PGlite
// data directory being left in a broken state, which it otherwise is whenever
// the process is killed mid-write.
let __closing = false;
async function shutdown() {
  if (__closing) return;
  __closing = true;
  try { if (__db && typeof __db.close === 'function') await __db.close(); } catch (e) {}
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
