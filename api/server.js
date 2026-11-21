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
// Transactional email (welcome + password reset). Loaded here so the .env
// loader below can fill RESEND_API_KEY / RESEND_FROM before it is used.
const mailer = require('./mailer');
// Web-bundle updates (Capacitor Updater): the rollout and rollback rules.
const updater = require('./updater');
// The agent programme: agent records, group migration, commission.
const agent = require('./agent');
// Money routing: the company fee account, the group pools and the split.
const money = require('./money');
const moneyRoutes = require('./money-routes');

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
    UPDATE groups SET invite_code='AJ-4821' WHERE id='g-aj4821' AND invite_code IS NULL;
    ALTER TABLE contributions ALTER COLUMN fee TYPE NUMERIC USING fee::NUMERIC;
    ALTER TABLE contributions ALTER COLUMN total TYPE NUMERIC USING total::NUMERIC;
    ALTER TABLE ledger_entries ALTER COLUMN amount TYPE NUMERIC USING amount::NUMERIC;
    -- How the winner of a cycle is picked. 'admin' = the treasurer/admin marks
    -- the winner (the default), 'rotate' = next slot in the frozen payout
    -- order, 'random' = a draw among the members who actually paid.
    ALTER TABLE groups ADD COLUMN IF NOT EXISTS winner_mode TEXT NOT NULL DEFAULT 'admin';
    -- Payout status machine: PENDING > PROCESSING > PAID (or FAILED). The
    -- winner's bank account is stored on the payout itself.
    ALTER TABLE payouts ADD COLUMN IF NOT EXISTS bank_code TEXT;
    ALTER TABLE payouts ADD COLUMN IF NOT EXISTS bank_account_number TEXT;
    ALTER TABLE payouts ADD COLUMN IF NOT EXISTS bank_account_name TEXT;
    ALTER TABLE payouts ADD COLUMN IF NOT EXISTS processed_at TIMESTAMPTZ;
    ALTER TABLE payouts ADD COLUMN IF NOT EXISTS failure_reason TEXT;
    ALTER TABLE payouts ADD COLUMN IF NOT EXISTS transfer_reference TEXT;
    ALTER TABLE payouts ADD COLUMN IF NOT EXISTS fee_remitted NUMERIC NOT NULL DEFAULT 0;`);
  // The agent programme: agent records, group migration and commission.
  // This runs before `q` exists, so it talks to the driver directly.
  await agent.installSchema({
    exec: async (text) => { await exec(text); },
    q: async (text, params) => (await db.query(text, params)).rows,
  });
  // The company fee account, the group pools and the payment ledger.
  await moneyRoutes.installSchema({
    exec: async (text) => { await exec(text); },
    q: async (text, params) => (await db.query(text, params)).rows,
  });

  const PORT = process.env.PORT || 4000;
  const app = express();
  app.use(cors());
  // 6mb: a receipt photo is uploaded as a data URL inside JSON. The rest of
  // the API sends a few hundred bytes, so this limit only ever matters on the
  // claim route.
  app.use(express.json({ limit: '6mb', verify: (req, res, buf) => { req.rawBody = buf; } }));
  const crypto = require('crypto');
  const PAYS_MODE = process.env.PAYMENTS_MODE || 'direct';
  // Launch gateway policy: PAYMENT_GATEWAY=FLUTTERWAVE_LIVE_ONLY means every
  // payment, account check and webhook runs on Flutterwave LIVE only. Paystack
  // (still on test keys) is switched off completely until it goes live itself.
  const FLW_ONLY = () => String(process.env.PAYMENT_GATEWAY || '').toUpperCase() === 'FLUTTERWAVE_LIVE_ONLY';
  const PSK = () => process.env.PAYSTACK_SECRET_KEY || '';
  const PS_HDR = () => ({ Authorization: `Bearer ${PSK()}`, 'Content-Type': 'application/json' });
  const FLW = () => process.env.FLUTTERWAVE_SECRET_KEY || '';
  const FLW_HDR = () => ({ Authorization: `Bearer ${FLW()}`, 'Content-Type': 'application/json' });
  // Shared confirm path for both PSPs: idempotent contribution + ledger + audit.
  async function confirmContribution(md, ref, method) {
    const h = crypto.createHash('sha256').update(String(ref) + Date.now()).digest('hex').slice(0, 16);
    const h2 = crypto.createHash('sha256').update('fee:' + String(ref) + Date.now()).digest('hex').slice(0, 16);
    const fee = Math.max(0, Number(md.fee) || 0);
    const pot = Number(md.pot) || 0;
    const total = Math.round((pot + fee) * 100) / 100;
    await db.query(`INSERT INTO contributions (id, membership_id, cycle_id, amount, fee, total, method, reference, status)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'CONFIRMED') ON CONFLICT (reference) DO NOTHING`,
      [`ct-${Date.now()}`, md.membership_id, md.cycle_id, pot, fee, total, method, ref]);
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

  // ---- Split payments: where each naira goes --------------------------------
  // Two streams that must never mix:
  //   the contribution goes to the group's pool, the fee goes to the company.
  // api/money.js decides; this is only the gateway plumbing.
  const moneyQ = async (text, params) => (params && params.length ? q(text, params) : exec(text));
  const moneyDb = { q, exec: moneyQ };

  async function routingPlan(groupId, amount, fee, gateway, channel) {
    return money.plan(moneyDb, { groupId, amount, fee, gateway, channel });
  }

  // Paystack splits are percentage based, so one split is created per exact
  // ratio and then reused. A group where everybody contributes the same amount
  // therefore needs exactly one split, not one per payment.
  async function ensurePaystackSplit(groupId, p) {
    const ratioKey = p.groupShare.toFixed(4);
    const ex = await q('SELECT * FROM paystack_splits WHERE group_id=$1 AND ratio_key=$2', [groupId, ratioKey]);
    if (ex.length) return ex[0].split_code;
    const r = await fetch('https://api.paystack.co/split', {
      method: 'POST', headers: PS_HDR(), signal: AbortSignal.timeout(20000),
      body: JSON.stringify({
        name: money.paystackSplitName(groupId, ratioKey),
        type: 'percentage',
        currency: 'NGN',
        subaccounts: money.paystackSubaccounts(p),
      }),
    });
    const j = await r.json();
    if (!j.status) throw new Error('Paystack could not set up the split: ' + (j.message || 'unknown error'));
    const code = j.data.split_code;
    await q('INSERT INTO paystack_splits (id, group_id, ratio_key, split_code, tier_index) VALUES ($1,$2,$3,$4,$5)',
      [`ps-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`, groupId, ratioKey, code, money.tierIndexForAmount(p.amount)]);
    return code;
  }

  // The two-step fallback: the gateway could not split the payment, so the fee
  // is moved to the company account straight after the charge. If the transfer
  // fails the whole payment fails - we never take money we cannot place.
  async function transferFee(p, reference) {
    if (!p || !p.company || !p.company.account_number) return { ok: false, error: 'no company account' };
    if (p.gateway === 'paystack') {
      if (!p.company.subaccount) return { ok: false, error: 'no company subaccount' };
      const r = await fetch('https://api.paystack.co/transfer', {
        method: 'POST', headers: PS_HDR(), signal: AbortSignal.timeout(20000),
        body: JSON.stringify({
          amount: Math.round(p.fee * 100), recipient: p.company.subaccount,
          reason: 'AJOCREDIT contribution fee', reference: 'FEE-' + reference,
        }),
      });
      const j = await r.json();
      if (!j.status) return { ok: false, error: j.message || 'paystack transfer failed' };
      return { ok: true, transfer: j.data };
    }
    if (!p.company.subaccount) return { ok: false, error: 'no company subaccount' };
    const r = await fetch('https://api.flutterwave.com/v3/transfers', {
      method: 'POST', headers: FLW_HDR(), signal: AbortSignal.timeout(20000),
      body: JSON.stringify({
        amount: Math.round(p.fee * 100), destination: String(p.company.subaccount),
        reference: 'FEE-' + reference, reason: 'AJOCREDIT contribution fee',
      }),
    });
    const j = await r.json();
    if (j.status !== 'success') return { ok: false, error: j.message || 'flutterwave transfer failed' };
    return { ok: true, transfer: j.data };
  }

  // Contribution fee: flat 1% up to ₦10,000, 0.5% above it. Exactly ₦10,000
  // is still 1% (the boundary is inclusive), ₦10,001 and up drop to 0.5%.
  // The fee is rounded to the nearest kobo (2 decimal places).
  function feeFor(amount) {
    const rate = amount <= 10000 ? 0.01 : 0.005;
    const fee = Math.round(amount * rate * 100) / 100;
    return { fee, total: Math.round((amount + fee) * 100) / 100, rate };
  }

  // One row per payment in the transactions ledger, showing exactly where each
  // naira went. The reconciliation sheet the admin reads.
  async function recordPaymentTx(plan, groupId, memberId, reference, gateway, status) {
    try {
      await money.recordTransaction(moneyDb, {
        reference, group_id: groupId, member_id: memberId,
        contribution_amount: plan.amount, fee_amount: plan.fee, total_amount: plan.total,
        gateway_fee: plan.gateway_fee || 0,
        contribution_destination: plan.pool ? plan.pool.label : 'pool:unconfigured',
        fee_destination: plan.company ? plan.company.label : 'company:unconfigured',
        gateway, mode: plan.mode, status: status || 'PENDING',
      });
    } catch (e) { console.log('transaction record failed: ' + e.message); }
  }

  // The payment was confirmed by the gateway: mark the transaction confirmed
  // and, in two-step mode, move the fee to the company account now.
  async function confirmPaymentTx(reference, gateway) {
    try {
      const rows = await q('SELECT * FROM transactions WHERE reference=$1 ORDER BY created_at DESC LIMIT 1', [reference]);
      if (!rows.length) return null;
      const t = rows[0];
      if (t.status === 'CONFIRMED') return t;
      if (t.mode === 'two_step' && Number(t.fee_amount) > 0) {
        const plan = await routingPlan(t.group_id, Number(t.contribution_amount), Number(t.fee_amount), gateway);
        const tr = await transferFee(plan, reference);
        if (!tr.ok) {
          // The fee could not be placed. The contribution is NOT confirmed.
          await q('UPDATE transactions SET status=$1 WHERE id=$2', ['SPLIT_FAILED', t.id]);
          await q('UPDATE contributions SET status=$1 WHERE reference=$2', ['FAILED', reference]);
          await q(`INSERT INTO audit_log (id, actor_id, action, entity, entity_id) VALUES ($1,$2,'payment.split_failed','transaction',$3)`,
            [`al-${Date.now()}`, gateway, t.id]);
          throw new Error('the fee could not be moved to the company account: ' + tr.error);
        }
      }
      await q('UPDATE transactions SET status=$1 WHERE id=$2', ['CONFIRMED', t.id]);
      return t;
    } catch (e) {
      console.log('payment confirm failed: ' + e.message);
      throw e;
    }
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
  // The treasurer reviews direct-transfer receipts. A group admin is always a
  // treasurer; a group may also promote one of its members to 'treasurer' so
  // the admin does not have to eyeball every screenshot.
  async function isTreasurer(userId, groupId) {
    const r = await q(`SELECT id FROM memberships WHERE user_id=$1 AND group_id=$2
        AND role IN ('admin','treasurer') AND status='ACTIVE'`, [userId, groupId]);
    return r.length > 0;
  }
  async function bindTreasurer(req, groupId) {
    if (!authOn()) return null;
    if (!req.user) return { status: 401, error: 'sign in required' };
    if (!(await isTreasurer(req.user, groupId))) {
      return { status: 403, error: 'only the group treasurer or admin can review payments' };
    }
    return null;
  }
  // How this group picks the winner of a cycle — set at group creation.
  //   admin    the admin/treasurer marks the winner (DEFAULT)
  //   rotate   the next slot in the frozen payout order
  //   random   a draw among the members who actually paid
  async function beneficiaryFor(group, cycleId, explicitId) {
    if (explicitId) {
      const b = await q(`SELECT * FROM memberships WHERE id=$1 AND group_id=$2 AND status='ACTIVE'`, [explicitId, group.id]);
      return b.length ? b[0] : null;
    }
    if ((group.winner_mode || 'admin') === 'random') {
      const paid = await q(
        `SELECT id FROM memberships m
          WHERE m.group_id=$1 AND m.status='ACTIVE'
            AND EXISTS (SELECT 1 FROM contributions c
                         WHERE c.membership_id=m.id AND c.cycle_id=$2 AND c.status='CONFIRMED')
          ORDER BY m.joined_at`, [group.id, cycleId]);
      const field = paid.length ? paid : await q(
        `SELECT id FROM memberships WHERE group_id=$1 AND status='ACTIVE' ORDER BY joined_at`, [group.id]);
      if (!field.length) return null;
      const picked = field[crypto.randomInt(field.length)];
      const row = await q('SELECT * FROM memberships WHERE id=$1', [picked.id]);
      return row.length ? row[0] : null;
    }
    // 'admin' and 'rotate' both follow the frozen payout order (slot 1 first).
    const b = await q(`SELECT * FROM memberships WHERE group_id=$1 AND status='ACTIVE'
        ORDER BY payout_slot NULLS LAST, joined_at LIMIT 1`, [group.id]);
    return b.length ? b[0] : null;
  }
  // The ajo fees that are physically sitting in a group's pool BANK account
  // because the member used Direct Transfer: contribution and fee arrived in
  // one transfer, the ledger split them, and the fee half is company money that
  // has not reached FIDELITY yet. It is remitted when the cycle pays out —
  // it never belongs to the pool.
  async function feesHeldInPool(groupId) {
    const r = await q(
      `SELECT COALESCE(SUM(c.fee),0)::float AS fee
         FROM contributions c JOIN cycles cy ON cy.id = c.cycle_id
        WHERE cy.group_id=$1 AND c.status='CONFIRMED' AND c.method='direct_transfer'`, [groupId]);
    const sent = await q(
      `SELECT COALESCE(SUM(amount),0)::float AS amt FROM fee_remittances
        WHERE group_id=$1 AND status IN ('PENDING','CONFIRMED')`, [groupId]);
    const booked = r.length ? Number(r[0].fee) || 0 : 0;
    const done = sent.length ? Number(sent[0].amt) || 0 : 0;
    return Math.max(0, Math.round((booked - done) * 100) / 100);
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
  // Task 3: password accounts + explicit phone verification. Existing members already
  // proved their phone with an OTP, so they default to verified.
  await exec(`ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS phone_verified BOOLEAN NOT NULL DEFAULT TRUE;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS verified_at TIMESTAMPTZ;`);
  // Email is optional. Older rows stored an empty string; normalise them to NULL so
  // "no email" always reads as NULL.
  await exec(`UPDATE users SET email=NULL WHERE email=''`);

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
      // An agent who brought this member in earns 1% of this contribution, and
      // their N500 is released the first time this member pays. Nothing here
      // moves money - it only records the commission.
      try {
        await agent.releaseOnFirstContribution({ q, exec }, md.membership_id, md.pot);
      } catch (e) { console.log('agent commission failed: ' + e.message); }
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

  // Root: a plain liveness answer so hitting the bare domain in a browser
  // (or a health check) shows "Cannot GET /" no more.
  app.get('/', (req, res) => {
    res.json({ status: 'AJO Credit API is live' });
  });

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
    res.json({ require_auth: authOn(), require_login: loginOn(), app: 'ajocredit', otp_resend_cooldown: Math.round(OTP_RESEND_COOLDOWN_MS / 1000) });
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
  // 10 minutes, matching the DND-approved message template. Termii will block
  // any variation of the wording, so the message comes from config/termii.js.
  const OTP_TTL_MIN = Math.max(1, parseInt(process.env.OTP_TTL_MIN || '10', 10) || 10);
  const { buildOtpMessage } = require('../config/termii');
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
  // ---- Password accounts (Task 3) --------------------------------------------
  // bcryptjs with 10 rounds - pure JS, so Render needs no native toolchain.
  const bcrypt = require('bcryptjs');
  const BCRYPT_ROUNDS = 10;
  // How long a member must wait before another code can be requested for the same
  // number. Termii's own OTP endpoint enforces 60s, so this matches the provider.
  const OTP_RESEND_COOLDOWN_MS = Math.max(0, parseInt(process.env.OTP_RESEND_COOLDOWN_SEC || '60', 10) || 0) * 1000;
  function passwordOk(p) {
    const s = String(p || '');
    if (s.length < 8 || s.length > 72) return false;   // bcrypt ignores bytes past 72
    if (!/[A-Za-z]/.test(s) || !/\d/.test(s)) return false;
    return true;
  }
  function emailOk(e) {
    const s = String(e || '').trim();
    return s.length >= 5 && s.length <= 160 && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s);
  }
  // Opaque session token: random 256-bit, stored hashed, 30-day expiry, device bound.
  async function issueSession(userId, deviceId) {
    const token = crypto.randomBytes(32).toString('hex');
    const thash = crypto.createHash('sha256').update(token).digest('hex');
    await q(`INSERT INTO sessions (id, user_id, token_hash, device_id, expires_at) VALUES ($1,$2,$3,$4,NOW() + INTERVAL '30 days')`,
      [`se-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`, userId, thash, deviceId || '']);
    return token;
  }
  async function publicUser(u) {
    return { id: u.id, name: u.name, phone: u.phone, email: u.email || null,
      ajocredit_id: u.ajocredit_id, score: u.score, tier: u.tier || tierFor(u.score),
      verified: u.phone_verified !== false };
  }
  // Send a phone code for a purpose: hourly cap, 60-second cooldown, then Termii.
  async function sendOtpTo(norm, pur) {
    const sent = await q(`SELECT COUNT(*)::int AS n FROM otp_codes WHERE phone=$1 AND created_at > NOW() - INTERVAL '1 hour'`, [norm]);
    if (sent.length && sent[0].n >= OTP_MAX_SENDS_PER_HOUR) {
      return { ok: false, reason: 'rate_limit', detail: 'too many codes requested - please try again in an hour' };
    }
    const last = await q(`SELECT created_at FROM otp_codes WHERE phone=$1 ORDER BY created_at DESC LIMIT 1`, [norm]);
    if (last.length) {
      const waitMs = OTP_RESEND_COOLDOWN_MS - (Date.now() - new Date(last[0].created_at).getTime());
      // A code is already on its way - say so, rather than reporting that nothing was sent.
      if (waitMs > 0) return { ok: false, reason: 'rate_limit', already_sent: true, detail: 'please wait before requesting another code', retry_after: Math.ceil(waitMs / 1000) };
    }
    const gen = await termii.generateOtp(norm.replace(/^\+/, ''), { length: OTP_LENGTH, ttlMinutes: OTP_TTL_MIN, attempts: OTP_MAX_ATTEMPTS });
    if (!gen.ok) return { ok: false, reason: 'provider', detail: gen.detail };
    const smsText = buildOtpMessage(gen.otp);
    const s1 = await termii.sendSms(norm, smsText);
    if (!s1.delivered) return { ok: false, reason: 'provider', detail: s1.detail };
    // Store ONLY a salted hash of the code - never the code itself.
    const salt = crypto.randomBytes(16).toString('hex');
    await q(`INSERT INTO otp_codes (id, phone, purpose, pin_id, code_hash, salt, expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [`otp-${Date.now()}-${crypto.randomBytes(5).toString('hex')}`, norm, pur, gen.pinId, otpHash(salt, gen.otp), salt, new Date(Date.now() + OTP_TTL_MIN * 60 * 1000)]);
    return { ok: true, detail: 'sent' };
  }
  // One shape for "we could not send that code": 429 when it is our rate limit,
  // 503 when Termii itself failed.
  function otpSendError(res, sent) {
    const status = sent && sent.reason === 'rate_limit' ? 429 : 503;
    let message;
    if (sent && sent.retry_after) message = `Please wait ${sent.retry_after}s before requesting another code.`;
    else if (sent && sent.reason === 'rate_limit') message = 'Too many codes requested - please try again in an hour.';
    else message = 'Could not send code. Please try again.';
    return res.status(status).json({ ok: false, error: message, detail: sent && sent.detail, retry_after: (sent && sent.retry_after) || 0 });
  }
  app.post('/api/otp/send', async (req, res) => {
    const { phone, purpose } = req.body || {};
    const norm = normPhone(phone);
    if (!norm) return res.status(400).json({ error: 'valid Nigerian phone required' });
    let pur = OTP_PURPOSES.includes(purpose) ? purpose : null;
    if (!pur) {
      const u = await q('SELECT id FROM users WHERE phone=$1', [norm]);
      pur = u.length ? 'login' : 'signup';
    }
    const sent = await sendOtpTo(norm, pur);
    if (!sent.ok) {
      return otpSendError(res, sent);
    }
    // A password-reset request also emails the member a notice - but only if they
    // gave us an address. The reset code itself always goes by SMS to the phone.
    if (pur === 'reset') {
      try {
        const u = await q('SELECT name, phone, email FROM users WHERE phone=$1', [norm]);
        if (u.length && u[0].email) {
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
        const uid = `u-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`, aj = 'AJ-' + Math.floor(100000 + Math.random() * 900000);
        // Legacy one-tap sign-up: the first successful OTP for a phone creates the member.
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
      // The phone is proven, so the member counts as verified.
      await q('UPDATE users SET phone_verified=TRUE, verified_at=COALESCE(verified_at,NOW()) WHERE id=$1', [u[0].id]);
      u = await q('SELECT * FROM users WHERE id=$1', [u[0].id]);
      if (device_id) {
        await q(`INSERT INTO devices (id, user_id, device_id, last_seen) VALUES ($1,$2,$3,NOW())
          ON CONFLICT (user_id, device_id) DO UPDATE SET last_seen=NOW()`, [`dv-${Date.now()}`, u[0].id, device_id]);
      }
      await q(`INSERT INTO audit_log (id, actor_id, action, entity, entity_id, detail) VALUES ($1,$2,$3,'user',$4,$5)`,
        [`al-${Date.now()}`, u[0].id, `otp.${rec.purpose}`, u[0].id, JSON.stringify({ purpose: rec.purpose, created: isNew })]);
      const token = await issueSession(u[0].id, device_id);
      // A member who came through an agent's link is linked to that agent, and
      // the agent's N500 is held until this member makes their first
      // contribution. Nothing here touches money - it only records who brought
      // the member in.
      try {
        const ref = (req.body && req.body.ref) || u[0].agent_ref;
        if (ref) {
          await agent.linkReferral({ q, exec }, u[0].id, norm, ref);
          await q('UPDATE users SET agent_ref=NULL WHERE id=$1', [u[0].id]);
        }
      } catch (e) { console.log('agent link failed: ' + e.message); }
      // Welcome the new member by SMS - that is the channel everyone has. The email
      // welcome is dropped on purpose: many members have no email address.
      if (isNew) {
        const wtxt = `Welcome to AJOCREDIT! Your ID is ${u[0].ajocredit_id}. Your score starts at 250 (Bronze). Open the app to create or join a group.`;
        termii.sendSms(norm, wtxt).then((r) => { if (!r.delivered) console.log('welcome sms failed: ' + r.detail); });
      }
      res.json({ ok: true, ajocredit_id: u[0].ajocredit_id, user_id: u[0].id, token, purpose: rec.purpose, created: isNew, user: await publicUser(u[0]) });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  // ---- Web bundle updates (Capacitor Updater) ------------------------------
  // The bundle (a zip of the web assets) and its manifest are published to the
  // static site by CI. The API decides WHO gets the update - a stable per-device
  // bucket, so the same phone always gets the same answer - and can force every
  // device back to the last known good bundle. The rules live in api/updater.js.
  const bundleCache = { at: 0, data: null };
  const checksumCache = { at: 0, key: '', value: '' };
  app.all('/api/app/update', async (req, res) => {
    try {
      const body = (req.method === 'POST' && req.body && typeof req.body === 'object') ? req.body : {};
      const q = req.query || {};
      const device = String(body.device_id || q.device_id || '');
      const current = String(body.version_name || q.current || '');
      const manifest = await updater.fetchManifest(updater.manifestUrl(process.env), bundleCache);
      const d = updater.decide(manifest, process.env, device, current);
      if (!d) return res.json({});
      // The plugin compares our `version` with the bundle it is running: the
      // same version means "nothing to install". `url` and `checksum` must
      // still be there, or the plugin rejects the whole response.
      const checksum = await updater.resolveChecksum(d.url, d.checksum, checksumCache);
      res.json({ version: d.version, url: d.url, checksum });
    } catch (e) {
      res.json({});
    }
  });
  // The updater plugin also posts anonymous usage stats and channel calls to
  // Capgo's servers by default. We point them here instead, so nothing about a
  // member's phone leaves the country and no request fails.
  app.all('/api/app/stats', (req, res) => { try { res.json({}); } catch (e) { res.json({}); } });
  app.all('/api/app/channel', (req, res) => { try { res.json({}); } catch (e) { res.json({}); } });
  // What is live right now: the bundle on offer, the bundle a rollback would
  // serve, and how much of the fleet is being offered the new one. Read-only -
  // it changes nothing.
  app.get('/api/app/update/status', async (req, res) => {
    try {
      const m = await updater.fetchManifest(updater.manifestUrl(process.env), bundleCache);
      const rb = (m && m.rollback) || null;
      res.json({
        rollout: updater.rolloutPct(process.env),
        rollback: updater.rollbackOn(process.env),
        serving: updater.rollbackOn(process.env) ? 'rollback' : 'current',
        manifest: updater.manifestUrl(process.env),
        current: m ? { version: m.version, url: m.url, sha256: m.sha256 || '' } : null,
        rollback_bundle: rb && rb.url ? { version: rb.version, url: rb.url, sha256: rb.sha256 || '' } : null
      });
    } catch (e) {
      res.json({ error: 'could not read the bundle manifest' });
    }
  });

  // ---- The agent programme ----------------------------------------------------
  // Agents bring Ajo groups to AJOCREDIT and earn a commission. The rules live in
  // api/agent.js; the agent pages are prototype/become-agent.html and friends.
  // `exec` in the agent module takes optional parameters, so DDL and parameterised
  // statements can both use it.
  const agentSql = async (text, params) => (params && params.length ? q(text, params) : exec(text));
  agent.installRoutes({
    app, q, exec: agentSql, normPhone,
    sendSms: (phone, text) => termii.sendSms(phone, text),
    ensurePool: moneyRoutes.ensurePool,
  });

  // ---- Company account, group pools, transactions ----------------------------
  // The company account receives EVERY fee. A group pool receives the group's
  // contributions. The two never mix - api/money.js is the only place that
  // decides where money goes.
  const moneySql = async (text, params) => (params && params.length ? q(text, params) : exec(text));
  const moneyCtx = {
    app, q, exec: moneySql, normPhone, bindPhone,
    requireAdmin: agent.requireAdmin,
    requireSession: agent.makeRequireSession({ q }),
    ensurePool: moneyRoutes.ensurePool,
  };
  moneyRoutes.installRoutes(moneyCtx);
  // ---- Account creation, login, password reset (Task 3) --------------------
  // Signup creates the account and sends the phone code. The member is NOT verified
  // yet, so they cannot reach the dashboard until the code is entered.
  app.post('/api/auth/signup', async (req, res) => {
    const { name, phone, email, password, terms } = req.body || {};
    const norm = normPhone(phone);
    if (!norm) return res.status(400).json({ error: 'Enter a valid Nigerian phone number (e.g. 08031234567)' });
    const nm = String(name || '').trim().slice(0, 60);
    if (nm.length < 2) return res.status(400).json({ error: 'Enter your full name' });
    // Email is OPTIONAL - many members do not have one. If it is given it must be
    // valid; if it is left empty it is stored as NULL (never as an empty string).
    const em = String(email || '').trim().slice(0, 160);
    if (em && !emailOk(em)) return res.status(400).json({ error: 'That email address does not look right - leave it empty if you do not have one' });
    if (!passwordOk(password)) return res.status(400).json({ error: 'Password must be at least 8 characters, with a letter and a number' });
    if (terms !== true && terms !== 'true' && terms !== 'on' && terms !== 1) return res.status(400).json({ error: 'Please accept the Terms to continue' });
    // Phone numbers are unique.
    const ex = await q('SELECT id FROM users WHERE phone=$1', [norm]);
    if (ex.length) return res.status(409).json({ error: 'That phone number is already registered. Sign in instead.' });
    const uid = `u-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
    const aj = 'AJ-' + Math.floor(100000 + Math.random() * 900000);
    let hash;
    try { hash = await bcrypt.hash(String(password), BCRYPT_ROUNDS); }
    catch (e) { return res.status(500).json({ error: 'Could not create your account. Try again.' }); }
    try {
      await q(`INSERT INTO users (id, phone, name, email, password_hash, phone_verified, verification, ajocredit_id, score, tier, provisional) VALUES ($1,$2,$3,$4,$5,FALSE,'OTP',$6,250,'Bronze',TRUE)`, [uid, norm, nm, em, hash, aj]);
    } catch (e) {
      if (/duplicate|unique/i.test(e.message || '')) return res.status(409).json({ error: 'That phone number is already registered. Sign in instead.' });
      return res.status(500).json({ error: 'Could not create your account. Try again.' });
    }
    await q(`INSERT INTO audit_log (id, actor_id, action, entity, entity_id) VALUES ($1,$2,'auth.signup','user',$3)`, [`al-${Date.now()}`, uid, uid]);
    // An agent code from a join link is remembered on the account so that the
    // referral is recorded when the phone is verified.
    if (req.body && req.body.ref) {
      try {
        await q('UPDATE users SET agent_ref=$1 WHERE id=$2', [String(req.body.ref).trim().toUpperCase().slice(0, 40), uid]);
      } catch (e) { console.log('agent ref save failed: ' + e.message); }
    }
    const sent = await sendOtpTo(norm, 'signup');
    if (!sent.ok) {
      return otpSendError(res, sent);
    }
    res.json({ ok: true, phone: norm, needs_verification: true });
  });

  // Login with phone + password. A member whose phone is not verified yet gets a
  // code and is sent to the verify page.
  app.post('/api/auth/login', async (req, res) => {
    const { phone, password, device_id } = req.body || {};
    const norm = normPhone(phone);
    if (!norm) return res.status(400).json({ error: 'Enter a valid Nigerian phone number' });
    const u = await q('SELECT * FROM users WHERE phone=$1', [norm]);
    if (!u.length) return res.status(401).json({ error: 'We do not recognise that phone number or password.' });
    if (!u[0].password_hash) {
      // Older account: it signs in with a one-time code instead of a password.
      const sent = await sendOtpTo(norm, 'login');
      return res.status(403).json({
        error: 'This account signs in with a one-time code - we just sent one to your phone.',
        code_sent: sent.ok || sent.already_sent === true, phone: norm, retry_after: sent.retry_after || 0,
      });
    }
    let good = false;
    try { good = await bcrypt.compare(String(password || ''), u[0].password_hash); } catch (e) { good = false; }
    if (!good) return res.status(401).json({ error: 'Wrong password. Check it and try again.' });
    if (u[0].phone_verified === false) {
      const sent = await sendOtpTo(norm, 'login');
      return res.status(403).json({
        error: 'Your phone number is not verified yet. Enter the code we just sent.',
        unverified: true, code_sent: sent.ok || sent.already_sent === true, phone: norm, retry_after: sent.retry_after || 0,
      });
    }
    const token = await issueSession(u[0].id, device_id);
    await q(`INSERT INTO audit_log (id, actor_id, action, entity, entity_id) VALUES ($1,$2,'auth.login','user',$3)`, [`al-${Date.now()}`, u[0].id, u[0].id]);
    res.json({ ok: true, token, user: await publicUser(u[0]) });
  });

  // Resend a code (60s cooldown, 3 per hour per number).
  app.post('/api/auth/resend', async (req, res) => {
    const { phone, purpose } = req.body || {};
    const norm = normPhone(phone);
    if (!norm) return res.status(400).json({ error: 'Enter a valid Nigerian phone number' });
    const pur = OTP_PURPOSES.includes(purpose) ? purpose : 'login';
    const sent = await sendOtpTo(norm, pur);
    if (!sent.ok) {
      return otpSendError(res, sent);
    }
    res.json({ ok: true, expires_in: OTP_TTL_MIN * 60 });
  });

  // Forgot password: phone -> code. We never say whether the number is registered.
  app.post('/api/auth/forgot', async (req, res) => {
    const { phone } = req.body || {};
    const norm = normPhone(phone);
    if (!norm) return res.status(400).json({ error: 'Enter a valid Nigerian phone number' });
    const u = await q('SELECT id, name, email FROM users WHERE phone=$1', [norm]);
    if (!u.length) return res.json({ ok: true, message: 'If that number is registered, a code is on its way.' });
    const sent = await sendOtpTo(norm, 'reset');
    if (!sent.ok) {
      return otpSendError(res, sent);
    }
    // The phone is the main path: the OTP goes by SMS to the number. The email notice
    // is only a bonus, and only for members who gave us an address.
    if (u[0].email) {
      try { await mailer.passwordResetEmail({ name: u[0].name, email: u[0].email, phone: norm, record: recordEmail }); } catch (e) {}
    }
    res.json({ ok: true, message: 'If that number is registered, a code is on its way.' });
  });

  // Reset password with the code we sent.
  app.post('/api/auth/reset', async (req, res) => {
    const { phone, code, password, device_id } = req.body || {};
    const norm = normPhone(phone);
    if (!norm) return res.status(400).json({ error: 'Enter a valid Nigerian phone number' });
    if (!passwordOk(password)) return res.status(400).json({ error: 'Password must be at least 8 characters, with a letter and a number' });
    const rows = await q(`SELECT * FROM otp_codes WHERE phone=$1 AND verified_at IS NULL ORDER BY created_at DESC LIMIT 1`, [norm]);
    if (!rows.length) return res.status(400).json({ error: 'Request a code first.' });
    const rec = rows[0];
    if (rec.purpose !== 'reset') return res.status(400).json({ error: 'That code was sent for a different request - please request a new one.' });
    if (new Date(rec.expires_at).getTime() < Date.now()) return res.status(401).json({ error: 'expired' });
    if (rec.attempts >= OTP_MAX_ATTEMPTS) return res.status(429).json({ error: 'too many attempts - please request a new code' });
    const pin = String(code || '').replace(/\D/g, '');
    const local = otpSafeEqual(rec.code_hash, otpHash(rec.salt, pin));
    let v = { ok: false, detail: 'mismatch' };
    if (local) v = rec.pin_id ? await termii.verifyOtp(rec.pin_id, pin) : { ok: true, detail: 'no pin id' };
    if (!local || !v.ok) {
      await q('UPDATE otp_codes SET attempts=attempts+1 WHERE id=$1', [rec.id]);
      return res.status(401).json({ error: 'invalid', attempts_left: Math.max(0, OTP_MAX_ATTEMPTS - (rec.attempts + 1)) });
    }
    const u = await q('SELECT * FROM users WHERE phone=$1', [norm]);
    if (!u.length) return res.status(404).json({ error: 'We do not recognise that phone number.' });
    const hash = await bcrypt.hash(String(password), BCRYPT_ROUNDS);
    await q('UPDATE users SET password_hash=$1, phone_verified=TRUE, verified_at=COALESCE(verified_at,NOW()) WHERE id=$2', [hash, u[0].id]);
    await q('UPDATE otp_codes SET verified_at=NOW() WHERE id=$1', [rec.id]);
    // The password changed: drop every existing session before issuing a new one.
    await q('UPDATE sessions SET expires_at=NOW() WHERE user_id=$1', [u[0].id]);
    const token = await issueSession(u[0].id, device_id);
    await q(`INSERT INTO audit_log (id, actor_id, action, entity, entity_id) VALUES ($1,$2,'auth.reset','user',$3)`, [`al-${Date.now()}`, u[0].id, u[0].id]);
    const fresh = await q('SELECT * FROM users WHERE id=$1', [u[0].id]);
    res.json({ ok: true, token, user: await publicUser(fresh[0]) });
  });

  // Logout: kill the session this request is carrying.
  app.post('/api/auth/logout', async (req, res) => {
    try {
      const raw = String(req.headers.authorization || '').replace(/^Bearer /, '').trim();
      if (raw) {
        const thash = crypto.createHash('sha256').update(raw).digest('hex');
        await q('UPDATE sessions SET expires_at=NOW() WHERE token_hash=$1', [thash]);
      }
    } catch (e) {}
    res.json({ ok: true });
  });

  // Who am I - used by the app to check the phone is verified before the dashboard.
  app.get('/api/auth/me', async (req, res) => {
    const raw = String(req.headers.authorization || '').replace(/^Bearer /, '').trim();
    if (!raw) return res.status(401).json({ error: 'sign in required' });
    const thash = crypto.createHash('sha256').update(raw).digest('hex');
    const s = await q('SELECT user_id FROM sessions WHERE token_hash=$1 AND expires_at > NOW()', [thash]);
    if (!s.length) return res.status(401).json({ error: 'sign in required' });
    const u = await q('SELECT * FROM users WHERE id=$1', [s[0].user_id]);
    if (!u.length) return res.status(401).json({ error: 'sign in required' });
    res.json({ ok: true, user: await publicUser(u[0]) });
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
    // Flutterwave-only launch: the bank list always comes from Flutterwave,
    // whatever the caller asks for — Paystack stays switched off.
    const pv = FLW_ONLY() ? 'flutterwave' : ((req.query || {}).provider === 'flutterwave' ? 'flutterwave' : 'paystack');
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
      // Flutterwave-only launch: account verification runs on Flutterwave too.
      const useFlw = FLW_ONLY() || (provider || 'paystack') === 'flutterwave';
      if (useFlw) {
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
      res.json({ ok: true, account_name, provider: useFlw ? 'flutterwave' : 'paystack', mode: PAYS_MODE });
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
    // ---- which channel is the member paying on? ---------------------------
    //   gateway          card / pay-with-transfer via Flutterwave → gateway fee
    //   direct_transfer  straight into the group's pool bank account → ₦0
    //   virtual_account  bank transfer into a Flutterwave VA        → ₦0
    // The ajo fee (1% ≤ ₦10,000, 0.5% above) applies on EVERY channel. Only the
    // gateway fee differs, and the member always sees this breakdown first.
    let channel = String((req.body || {}).channel || 'gateway').toLowerCase().trim().replace(/[\s-]+/g, '_');
    if (channel === 'card' || channel === 'transfer' || channel === 'pay_with_transfer') channel = 'gateway';
    if (channel !== 'gateway' && channel !== 'direct_transfer' && channel !== 'virtual_account') {
      return res.status(400).json({ error: "channel must be 'gateway', 'direct_transfer' or 'virtual_account'" });
    }
    // Direct Transfer needs somewhere to transfer TO — the group's own pool
    // account. Without it the member would be sending money blind.
    let poolRow = null;
    if (channel === 'direct_transfer') {
      const pr = await q('SELECT * FROM group_pools WHERE group_id=$1', [group_id]);
      poolRow = pr.length ? pr[0] : null;
      if (!poolRow || !poolRow.verified || !poolRow.account_number) {
        return res.status(422).json({
          ok: false,
          error: 'This group has no verified pool account yet. Ask the group admin to save and verify the Group pool account — until then use Pay with Transfer (card) or Virtual account.',
        });
      }
    }
    // Where each naira lands, and what the member pays on top of the ajo fee.
    const plan = await routingPlan(group_id, amount, fee, channel === 'direct_transfer' ? 'bank' : 'flutterwave', channel);
    money.assertNoMixing(plan);
    const feeBreakdown = {
      channel,
      amount,                 // contribution — the whole of it reaches the pool
      fee,                    // AJOCREDIT ajo fee
      total,                  // contribution + ajo fee
      gateway_fee: plan.gateway_fee || 0,   // ₦0 on direct transfer + virtual account
      charge: plan.charge,    // what the member actually parts with
      breakdown: [
        { label: 'Contribution to the group pool', amount, to: 'group_pool' },
        { label: 'AJOCREDIT ajo fee', amount: fee, to: 'company' },
        { label: plan.gateway_fee > 0 ? 'Gateway / processing fee' : 'Gateway fee', amount: plan.gateway_fee || 0,
          to: plan.gateway_fee > 0 ? 'flutterwave' : 'none' },
      ],
    };
    // Payout gate. An account can LOOK linked (its name is saved) while the
    // verified flag is still false - rows written by older builds did that, and
    // rejecting then showed as an instant "Nothing was taken" failure. So if
    // the details are on file, re-verify them here and heal the flag instead
    // of bouncing the member.
    let destRow = g[0];
    if (channel === 'gateway' && !destRow.dest_verified && destRow.dest_account_number && destRow.dest_bank_code) {
      try {
        const vr = await fetch('https://api.flutterwave.com/v3/accounts/resolve', {
          method: 'POST', headers: FLW_HDR(), signal: AbortSignal.timeout(20000),
          body: JSON.stringify({ account_number: String(destRow.dest_account_number), account_bank: String(destRow.dest_bank_code) }),
        });
        const vj = await vr.json();
        if (vj.status === 'success' && vj.data && vj.data.account_name) {
          destRow = Object.assign({}, destRow, { dest_verified: true, dest_account_name: vj.data.account_name });
          await db.query('UPDATE groups SET dest_account_name=$1, dest_verified=TRUE WHERE id=$2', [vj.data.account_name, destRow.id]);
        }
      } catch (e) { /* fall through to the gate below */ }
    }
    const destination = destRow.dest_verified ? { bank: destRow.dest_bank_code, account: '••' + String(destRow.dest_account_number).slice(-4), name: destRow.dest_account_name } : null;
    // The other two channels do not settle into that account: Direct Transfer
    // lands in the group's pool account, a Virtual Account settles with
    // Flutterwave. Only the gateway checkout needs it.
    if (channel === 'gateway' && !destination) return res.status(422).json({ ok: false, error: 'The payout account is saved but not verified yet — open Payout account, tap Verify & Save once, then pay.' });
    // Where the money goes: the contribution to the group's pool, the fee to the
    // company account. The two never mix - api/money.js decides and the
    // assert above refuses to go ahead if they could.
    if (channel === 'direct_transfer') {
      // No gateway is involved: the member sends contribution + ajo fee in one
      // transfer to the pool account and uploads the receipt. NOTHING enters
      // the pool balance until the treasurer confirms the claim.
      await recordPaymentTx(plan, group_id, membership_id, reference, 'bank', 'PENDING');
      const naira = (n) => '₦' + (Math.round(Number(n) * 100) / 100).toLocaleString('en-NG');
      return res.json(Object.assign({
        ok: true, provider: 'bank_transfer', reference,
        pool: {
          bank_name: poolRow.bank_name, account_number: poolRow.account_number,
          account_name: poolRow.account_name, bank_code: poolRow.bank_code,
        },
        next: 'upload_receipt',
        note: 'Transfer the total below, then upload the receipt. The treasurer confirms it before it counts.',
        instructions: [
          `Transfer ${naira(plan.charge)} to ${poolRow.account_name} — ${poolRow.bank_name}, ${poolRow.account_number}.`,
          'Send it from your own bank account so the name matches your membership.',
          'Upload the transfer receipt here. Only the group treasurer can confirm it.',
        ],
      }, feeBreakdown));
    }
    if (channel === 'virtual_account') {
      // Flutterwave issues a throw-away account for this exact amount. No card,
      // so no gateway fee — and the transfer that lands is auto-confirmed by
      // Flutterwave's charge.completed webhook, no receipt needed.
      try {
        const r = await fetch('https://api.flutterwave.com/v3/virtual-account-numbers', {
          method: 'POST', headers: FLW_HDR(), signal: AbortSignal.timeout(20000),
          body: JSON.stringify({ amount: plan.charge, email: email || 'member@ajocredit.ng', tx_ref: reference }),
        });
        const j = await r.json();
        const d = j && j.data ? j.data : null;
        const vaNumber = d && (d.account_number || (d.recipients && d.recipients[0] && d.recipients[0].account_number));
        if (j.status !== 'success' || !vaNumber) throw new Error((j && j.message) || 'virtual account unavailable');
        await q(`INSERT INTO payment_vas (reference, group_id, membership_id, cycle_id, amount, fee, total,
                  va_number, va_bank, va_bank_name, status)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'PENDING') ON CONFLICT (reference) DO NOTHING`,
          [reference, group_id, membership_id, cycle_id, amount, fee, total, String(vaNumber),
            d.bank_name || d.bank || null, d.account_name || null]);
        await recordPaymentTx(plan, group_id, membership_id, reference, 'flutterwave', 'PENDING');
        const naira = (n) => '₦' + (Math.round(Number(n) * 100) / 100).toLocaleString('en-NG');
        return res.json(Object.assign({
          ok: true, provider: 'flutterwave_virtual_account', reference,
          va: { account_number: String(vaNumber), bank_name: d.bank_name || d.bank || 'Flutterwave',
                account_name: d.account_name || null },
          next: 'transfer',
          note: 'Transfer the total into this account. It confirms automatically — no receipt needed.',
          instructions: [
            `Transfer ${naira(plan.charge)} to ${d.account_name || 'AJOCREDIT'} — ${d.bank_name || 'Flutterwave'}, ${vaNumber}.`,
            'This account is for THIS payment only. Anyone may fund it; the reference ties it to you.',
          ],
        }, feeBreakdown));
      } catch (e) {
        return res.status(502).json({
          ok: false, channel,
          error: 'We could not create a virtual account right now — nothing was charged. Try Pay with Transfer instead. (' + (e && e.message) + ')',
        });
      }
    }
    // Primary: Flutterwave hosted checkout link (v3 /payments). Backup: Paystack inline config.
    // 20s cap on PSP calls: a hanging PSP must never wedge the client past its own timeout.
    try {
      // The member is charged plan.charge = contribution + ajo fee + Flutterwave's
      // own fee. Flutterwave takes its fee off the top before paying the split
      // legs, so charging only `total` would leave less than the legs need and
      // the split would collapse into the main account. The legs below are
      // still exactly contribution and fee - the pool gets the full pot, the
      // company gets exactly its fee.
      const flwBody = {
        tx_ref: reference, amount: plan.charge, currency: 'NGN',
        redirect_url: (process.env.FRONTEND_URL || 'https://ajocredit.pages.dev').replace(/\/$/, ''),
        customer: { email: email || 'member@ajocredit.ng', name: 'Ajo Member' },
        meta: meta, customizations: { title: 'AJOCREDIT Contribution' },
      };
      // If the group has a verified pool subaccount, the payment is split at the
      // gateway: the contribution lands in the group pool, the fee in the
      // company account.
      const flwSplit = plan.gateway === 'flutterwave' ? money.flutterwaveInit(plan) : null;
      if (flwSplit) flwBody.subaccounts = flwSplit.subaccounts;
      const r = await fetch('https://api.flutterwave.com/v3/payments', {
        method: 'POST', headers: FLW_HDR(), signal: AbortSignal.timeout(20000),
        body: JSON.stringify(flwBody),
      });
      const j = await r.json();
      if (j.status === 'success' && j.data && j.data.link) {
        await recordPaymentTx(plan, group_id, membership_id, reference, 'flutterwave', 'PENDING');
        return res.json({ ok: true, provider: 'flutterwave', link: j.data.link, reference,
          mode: PAYS_MODE, amount, fee, total, gateway_fee: plan.gateway_fee, charge: plan.charge,
          destination, split_mode: plan.mode, channel: 'gateway', breakdown: feeBreakdown.breakdown });
      }
      throw new Error('flutterwave link failed: ' + (j.message || 'unknown'));
    } catch (e) {
      // A split that the gateway refused is a hard stop: no charge, and the
      // contribution is not marked paid.
      if (/split/i.test(String(e && e.message))) {
        return res.status(502).json({ ok: false, error: 'We could not set up the payment split for this group, so no money was taken. Please try again or tell your group admin.' });
      }
      // Paystack is DISABLED for launch (PAYMENT_GATEWAY=FLUTTERWAVE_LIVE_ONLY):
      // it is still on test keys, so it must never take a live payment. The
      // fallback below stays off until Paystack goes live AND the gateway
      // policy is changed. Fail cleanly, never silently downgrade.
      const pk = FLW_ONLY() ? '' : (process.env.PAYSTACK_PUBLIC_KEY || '');
      if (pk.startsWith('pk_live_')) {
        const psPlan = await routingPlan(group_id, amount, fee, 'paystack');
        money.assertNoMixing(psPlan);
        let splitCode = null;
        if (psPlan.mode === 'split') {
          try { splitCode = await ensurePaystackSplit(group_id, psPlan); }
          catch (se) {
            return res.status(502).json({ ok: false, error: 'We could not set up the payment split for this group, so no money was taken. Please try again or tell your group admin.' });
          }
        }
        const psRef = `${group_id.slice(0, 8)}-C${cycle_id.slice(-2)}-${Date.now()}`;
        const psInit = money.paystackInit(psPlan, splitCode);
        await recordPaymentTx(psPlan, group_id, membership_id, psRef, 'paystack', 'PENDING');
        return res.json({ ok: true, provider: 'paystack', mode: PAYS_MODE, amount, fee, total, amount_kobo: Math.round(total * 100),
          paystack_key: pk, split_code: psInit ? psInit.split_code : undefined,
          subaccount: psInit ? psInit.subaccount : undefined,
          reference: psRef, destination, metadata: meta, split_mode: psPlan.mode,
          channel: 'gateway', gateway_fee: psPlan.gateway_fee || 0, charge: psPlan.charge,
          breakdown: feeBreakdown.breakdown });
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
      if (ok && ref) {
        // A Virtual Account credit arrives with no useful meta — the row WE
        // created when the account was issued carries the group, member, cycle
        // and the exact split. Rehydrate the metadata so a VA credit books the
        // same way a checkout charge does.
        const va = await q('SELECT * FROM payment_vas WHERE reference=$1', [ref]);
        if (va.length && va[0].status !== 'CONFIRMED') {
          const paid = Number(data.amount) || 0;
          const expected = Number(va[0].total) || 0;
          if (paid && expected && paid + 0.001 < expected) {
            // Under-paid: never book it as a contribution.
            await q(`UPDATE payment_vas SET status='UNDERPAID' WHERE reference=$1`, [ref]);
            await q(`UPDATE transactions SET status='FAILED' WHERE reference=$1`, [ref]);
            await db.query(`UPDATE contributions SET status='FAILED' WHERE reference=$1`, [ref]);
            return res.json({ ok: true, underpaid: ref, expected, received: paid });
          }
          md.group_id = md.group_id || va[0].group_id;
          md.membership_id = md.membership_id || va[0].membership_id;
          md.cycle_id = md.cycle_id || va[0].cycle_id;
          md.pot = Number(md.pot) || Number(va[0].amount) || 0;
          md.fee = Number(md.fee) || Number(va[0].fee) || 0;
          md.method = 'virtual_account';
        }
        // The money is confirmed: mark the transaction confirmed (and move the
        // fee to the company account in two-step mode) BEFORE the contribution
        // is booked as paid.
        await confirmPaymentTx(ref, 'flutterwave');
        await confirmContribution(md, ref, (md && md.method) || 'flutterwave');
        if (va.length) await q(`UPDATE payment_vas SET status='CONFIRMED' WHERE reference=$1`, [ref]);
        res.json({ ok: true, confirmed: ref, channel: va.length ? 'virtual_account' : 'gateway' });
      }
      else { await db.query(`UPDATE contributions SET status='FAILED' WHERE reference=$1`, [ref]); await q('UPDATE transactions SET status=$1 WHERE reference=$2', ['FAILED', ref]); res.json({ ok: true, marked_failed: ref }); }
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
    // PAYMENT_GATEWAY=FLUTTERWAVE_LIVE_ONLY: Paystack is off for launch. A
    // signature is still checked, but NO Paystack event may confirm a
    // contribution (a test-mode event must never mark money that never moved
    // as paid). The receipt is acknowledged and ignored.
    if (FLW_ONLY()) return res.json({ ok: false, ignored: true, error: 'Paystack is disabled for launch — Flutterwave LIVE only.' });
    const ev = req.body || {};
    if (ev.event === 'charge.success') {
      const md = ev.data?.metadata || {};
      const ref = ev.data?.reference || '';
      const lh = crypto.createHmac('sha256', PSK() || 'ajocredit').update(String(ref)).digest('hex').slice(0, 16);
      const lh2 = crypto.createHmac('sha256', (PSK() || 'ajocredit') + 'fee').update(String(ref)).digest('hex').slice(0, 16);
      const pfee = Math.max(0, Number(md.fee) || 0);
      const ppot = Number(md.pot) || 0;
      const ptotal = Math.round((ppot + pfee) * 100) / 100;
      try {
        await db.query(`INSERT INTO contributions (id, membership_id, cycle_id, amount, fee, total, method, reference, status)
          VALUES ($1,$2,$3,$4,$5,$6,'paystack',$7,'CONFIRMED') ON CONFLICT (reference) DO NOTHING`,
          [`ct-${Date.now()}`, md.membership_id, md.cycle_id, ppot, pfee, ptotal, ref]);
        await db.query(`INSERT INTO ledger_entries (id, group_id, debit_acct, credit_acct, amount, type, ref_id, idempotency_key, status, hash)
          VALUES ($1,$2,'psp:paystack',$3,$4,'contribution',$5,$6,'CONFIRMED',$7) ON CONFLICT (idempotency_key) DO NOTHING`,
          [`le-${Date.now()}`, md.group_id, `pot:${md.group_id}`, md.pot, ref, `webhook:${ref}`, lh]);
        if (pfee > 0) {
          await db.query(`INSERT INTO ledger_entries (id, group_id, debit_acct, credit_acct, amount, type, ref_id, idempotency_key, status, hash)
            VALUES ($1,$2,$3,$4,$5,'fee',$6,$7,'CONFIRMED',$8) ON CONFLICT (idempotency_key) DO NOTHING`,
            [`le-${Date.now()}f`, md.group_id, `member:${md.membership_id || 'unknown'}`, `revenue:ajocredit-fees`, pfee, ref, `webhook:${ref}:fee`, lh2]);
        }
        await db.query(`INSERT INTO audit_log (id, actor_id, action, entity, entity_id) VALUES ($1,'paystack','webhook.confirm','contribution',$2)`, [`al-${Date.now()}`, ref]);
        // The money is confirmed: mark the transaction confirmed (and in two-step
        // mode move the fee to the company account). If the fee cannot be placed
        // the contribution is NOT marked paid.
        try { await confirmPaymentTx(ref, 'paystack'); }
        catch (ce) {
          await db.query(`UPDATE contributions SET status='FAILED' WHERE reference=$1`, [ref]);
          return res.status(500).json({ ok: false, error: ce.message });
        }
        res.json({ ok: true, confirmed: ref });
      } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
    } else if (ev.event === 'charge.failed') {
      const ref = ev.data?.reference || '';
      try {
        await db.query(`UPDATE contributions SET status='FAILED' WHERE reference=$1`, [ref]);
        await q('UPDATE transactions SET status=$1 WHERE reference=$2', ['FAILED', ref]);
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
    const { name, amount, size, frequency, payout_mode, winner_mode, admin_phone, admin_name } = req.body || {};
    const ab = await bindPhone(req, admin_phone);
    if (ab) return res.status(ab.status).json({ error: ab.error });
    if (!name || String(name).trim().length < 3) return res.status(400).json({ error: 'group name needs at least 3 characters' });
    if (!Number.isFinite(+amount) || +amount <= 0 || +amount > 10000000) return res.status(400).json({ error: 'amount must be between ₦1 and ₦10,000,000' });
    const nsize = Math.min(30, Math.max(5, parseInt(size) || 10));
    const phone = normPhone(admin_phone);
    if (!phone) return res.status(400).json({ error: 'valid Nigerian phone required (e.g. 08031234567)' });
    const aname = String(admin_name || '').trim();
    if (aname.length < 2) return res.status(400).json({ error: 'your name is required' });
    // How this group picks its cycle winner:
    //   admin    the admin/treasurer marks the winner — the DEFAULT
    //   rotate   the next slot in the payout order
    //   random   a draw among the members who paid
    const wmode = ['admin', 'rotate', 'random'].includes(String(winner_mode || '').toLowerCase())
      ? String(winner_mode).toLowerCase() : 'admin';
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
    // Every group gets its own pool wallet - this is where its contributions land.
    await moneyRoutes.ensurePool({ q }, gid);
      await q(`INSERT INTO groups (id, name, type, amount, size, frequency, payout_mode, status, rules, invite_code, winner_mode)
        VALUES ($1,$2,'ROTATIONAL',$3,$4,$5,$6,'FORMING','{\"grace_hours\":48}',$7,$8)`,
        [gid, String(name).trim(), +amount, nsize, frequency || 'Weekly', payout_mode || 'random', icode, wmode]);
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
  // beneficiary from the group's OWN pool account. Maker ≠ checker (THREAT-MODEL T5).
  //
  // Status machine — exactly one payout per cycle, ever (idempotency_key):
  //   PENDING     initiated; the winner and their bank account are on file
  //   PROCESSING  a second person approved; the pot is ALREADY out of the pool
  //               balance (poolBalance subtracts PROCESSING and PAID)
  //   PAID        the money reached the winner's bank account: the cycle closes
  //               and the next one opens
  //   FAILED      the transfer did not go through; the pot goes straight back
  //               into the pool balance and the payout can be approved again
  async function collectedPot(cycleId) {
    const r = await q(`SELECT COALESCE(SUM(amount),0)::int AS pot FROM contributions WHERE cycle_id=$1 AND status='CONFIRMED'`, [cycleId]);
    return r.length ? r[0].pot : 0;
  }
  app.get('/api/payouts/:groupId', auth, async (req, res) => {
    try {
      const gid = req.params.groupId;
      const g = await q('SELECT * FROM groups WHERE id=$1', [gid]);
      if (!g.length) return res.status(404).json({ ok: false, error: 'group not found' });
      const cy = await q('SELECT * FROM cycles WHERE group_id=$1 ORDER BY seq DESC LIMIT 1', [gid]);
      if (!cy.length) return res.json({ ok: true, payout: null, cycle: null, winner_mode: g[0].winner_mode || 'admin' });
      const p = await q('SELECT * FROM payouts WHERE cycle_id=$1', [cy[0].id]);
      const ben = p.length ? await q('SELECT u.name FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.id=$1', [p[0].beneficiary_id]) : [];
      // Every active member, so the admin can mark the winner when the group
      // runs on winner_mode='admin'. Ordered by the frozen payout order.
      const members = await q(`SELECT m.id, u.name, m.payout_slot FROM memberships m
        JOIN users u ON u.id=m.user_id
        WHERE m.group_id=$1 AND m.status='ACTIVE'
        ORDER BY m.payout_slot NULLS LAST, m.joined_at`, [gid]);
      const counts = await q(`SELECT status, COUNT(*)::int AS n FROM payouts WHERE group_id=$1 GROUP BY status`, [gid]);
      const statuses = {};
      for (const c of counts) statuses[c.status] = c.n;
      res.json({ ok: true, cycle: cy[0], collected: await collectedPot(cy[0].id), payout: p[0] || null,
        beneficiary_name: ben.length ? ben[0].name : null,
        winner_mode: g[0].winner_mode || 'admin',
        payout_statuses: statuses,
        members,
        // Direct Transfer fees are still sitting in the pool bank account.
        // They are company money and must reach FIDELITY — reported here so the
        // treasurer remits them with the payout instead of forgetting.
        fee_due_to_company: await feesHeldInPool(gid) });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });
  app.post('/api/payouts/initiate', auth, async (req, res) => {
    const { group_id, cycle_id, maker_phone, beneficiary_membership_id, amount,
      bank_code, bank_account_number, bank_account_name } = req.body || {};
    const pb = await bindPhone(req, maker_phone);
    if (pb) return res.status(pb.status).json({ error: pb.error });
    const phone = normPhone(maker_phone);
    if (!group_id) return res.status(400).json({ error: 'group_id required' });
    if (!phone) return res.status(400).json({ error: 'maker_phone required' });
    try {
      const u = await q('SELECT * FROM users WHERE phone=$1', [phone]);
      if (!u.length || !(await isAdmin(u[0].id, group_id))) return res.status(403).json({ error: 'only a group admin can initiate a payout' });
      const g = await q('SELECT * FROM groups WHERE id=$1', [group_id]);
      if (!g.length) return res.status(404).json({ error: 'group not found' });
      const cy = cycle_id
        ? await q('SELECT * FROM cycles WHERE id=$1 AND group_id=$2', [cycle_id, group_id])
        : await q('SELECT * FROM cycles WHERE group_id=$1 ORDER BY seq DESC LIMIT 1', [group_id]);
      if (!cy.length) return res.status(404).json({ error: 'no cycle found for this group' });
      const cyc = cy[0];
      // The winner, chosen the way THIS group was set up to choose one:
      // admin marks / rotate the order / random draw among those who paid.
      if (beneficiary_membership_id) {
        const chk = await q(`SELECT id FROM memberships WHERE id=$1 AND group_id=$2 AND status='ACTIVE'`, [beneficiary_membership_id, group_id]);
        if (!chk.length) return res.status(404).json({ error: 'that member is not active in this group' });
      }
      const ben = await beneficiaryFor(g[0], cyc.id, beneficiary_membership_id);
      if (!ben) return res.status(422).json({ error: 'no active member can receive this payout — set the payout order first' });
      // The money can only be sent to an account, so the winner's bank details
      // are part of starting the payout — not something to discover at the end.
      const bCode = String(bank_code || '').trim();
      const bAcct = String(bank_account_number || '').trim();
      const bName = String(bank_account_name || '').trim();
      if (!bCode || !/^\d{6,11}$/.test(bAcct)) {
        return res.status(422).json({
          error: "Add the winner's bank first: bank, account number and account name are required to start a payout.",
        });
      }
      const pot = await collectedPot(cyc.id);
      const amt = Number.isFinite(+amount) && +amount > 0 ? Math.floor(+amount) : pot;
      // Guards: shortfall blocked, duplicate payout blocked.
      if (pot <= 0) return res.status(409).json({ error: 'nothing collected for this cycle yet — payout blocked' });
      if (amt > pot) return res.status(409).json({ error: `shortfall blocked: pot is ₦${pot.toLocaleString()}, cannot pay ₦${amt.toLocaleString()}` });
      const dup = await q(`SELECT id, status FROM payouts WHERE idempotency_key=$1`, [`payout:${cyc.id}`]);
      if (dup.length) {
        const hint = dup[0].status === 'FAILED'
          ? ' — this payout failed, approve it again instead of starting a new one'
          : '';
        return res.status(409).json({ error: `payout already ${dup[0].status.toLowerCase()} for this cycle${hint}`, payout_id: dup[0].id });
      }
      const pid = `po-${Date.now()}`;
      await q(`INSERT INTO payouts (id, group_id, cycle_id, beneficiary_id, amount, status, idempotency_key, initiated_by,
                bank_code, bank_account_number, bank_account_name)
        VALUES ($1,$2,$3,$4,$5,'PENDING',$6,$7,$8,$9,$10)`,
        [pid, group_id, cyc.id, ben.id, amt, `payout:${cyc.id}`, u[0].id, bCode, bAcct, bName || null]);
      await q(`INSERT INTO audit_log (id, actor_id, action, entity, entity_id) VALUES ($1,$2,'payout.initiate','payout',$3)`, [`al-${Date.now()}`, u[0].id, pid]);
      // All admins get pinged that a second pair of eyes is needed.
      const bn = await q('SELECT u.name FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.id=$1', [ben.id]);
      const admins = await q(`SELECT user_id FROM memberships WHERE group_id=$1 AND role='admin' AND status='ACTIVE'`, [group_id]);
      for (const a of admins) await notifyUser(a.user_id, 'payout_pending', 'Payout awaiting approval ⏳',
        `₦${amt.toLocaleString()} to ${bn.length ? bn[0].name : 'beneficiary'} (cycle ${cyc.seq}) is ready. A second person must approve — maker ≠ checker.`);
      res.json({ ok: true, payout_id: pid, status: 'PENDING', amount: amt,
        beneficiary: bn.length ? bn[0].name : null, beneficiary_membership_id: ben.id,
        winner_mode: g[0].winner_mode || 'admin',
        bank: { bank_code: bCode, account_number: bAcct, account_name: bName || null },
        note: 'awaiting a second approver (maker ≠ checker)' });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });
  // Checker approves: PENDING → PROCESSING. The pot leaves the pool balance
  // right here — before a single naira has moved — so nobody can spend money
  // that is already promised to the winner.
  app.post('/api/payouts/approve', auth, async (req, res) => {
    const { payout_id, checker_phone, bank_code, bank_account_number, bank_account_name } = req.body || {};
    const cb = await bindPhone(req, checker_phone);
    if (cb) return res.status(cb.status).json({ error: cb.error });
    const phone = normPhone(checker_phone);
    if (!payout_id) return res.status(400).json({ error: 'payout_id required' });
    if (!phone) return res.status(400).json({ error: 'checker_phone required' });
    try {
      const p = await q('SELECT * FROM payouts WHERE id=$1', [payout_id]);
      if (!p.length) return res.status(404).json({ error: 'payout not found' });
      const po = p[0];
      // A FAILED payout may be approved again (same payout, no second pot); a
      // PROCESSING or PAID one may never be approved twice.
      if (po.status !== 'PENDING' && po.status !== 'FAILED') {
        return res.status(409).json({ error: `payout already ${po.status.toLowerCase()} — it cannot be approved again` });
      }
      const u = await q('SELECT * FROM users WHERE phone=$1', [phone]);
      // Checker must be an active member of the group — and never the maker.
      const cm = u.length ? await q(`SELECT id FROM memberships WHERE user_id=$1 AND group_id=$2 AND status='ACTIVE'`, [u[0].id, po.group_id]) : [];
      if (!cm.length) return res.status(403).json({ error: 'checker must be an active member of the group' });
      if (po.initiated_by && u[0].id === po.initiated_by) return res.status(403).json({ error: 'self-approve blocked — a different person must approve (maker ≠ checker)' });
      // Re-check the shortfall at approval time (contributions may have been disputed).
      const pot = await collectedPot(po.cycle_id);
      if (po.amount > pot) return res.status(409).json({ error: `shortfall at approval: pot is ₦${pot.toLocaleString()}, payout ₦${po.amount.toLocaleString()} — blocked` });
      // The winner's account must be on file — the checker may correct it here.
      const bCode = String(bank_code || po.bank_code || '').trim();
      const bAcct = String(bank_account_number || po.bank_account_number || '').trim();
      const bName = String(bank_account_name || po.bank_account_name || '').trim();
      if (!bCode || !/^\d{6,11}$/.test(bAcct)) {
        return res.status(422).json({ error: "The winner's bank details are missing — add them before approving." });
      }
      const ben = await q('SELECT u.name, u.id FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.id=$1', [po.beneficiary_id]);
      await q(`UPDATE payouts SET status='PROCESSING', approved_by=$1, processed_at=NOW(),
                  bank_code=$2, bank_account_number=$3, bank_account_name=$4 WHERE id=$5`,
        [u[0].id, bCode, bAcct, bName || null, po.id]);
      await q(`INSERT INTO ledger_entries (id, group_id, debit_acct, credit_acct, amount, type, ref_id, idempotency_key, status, hash)
        VALUES ($1,$2,$3,$4,$5,'payout',$6,$7,'CONFIRMED',$8) ON CONFLICT (idempotency_key) DO NOTHING`,
        [`le-${Date.now()}p`, po.group_id, `pot:${po.group_id}`, `member:${po.beneficiary_id}`, po.amount, po.id, `payout:${po.id}`, `h${Date.now()}p`]);
      await q(`INSERT INTO audit_log (id, actor_id, action, entity, entity_id) VALUES ($1,$2,'payout.approve','payout',$3)`, [`al-${Date.now()}`, u[0].id, po.id]);
      // Direct Transfer fees are still sitting in the pool's BANK account.
      // They were never the pool's money — say so loudly while the treasurer
      // is sending the pot out, so both transfers go together.
      const feeDue = await feesHeldInPool(po.group_id);
      await notifyGroup(po.group_id, 'payout', '💸 Payout approved — send the transfer',
        `₦${po.amount.toLocaleString()} to ${ben.length ? ben[0].name : 'the beneficiary'} is approved and already out of the pool balance. ` +
        `Send it from the pool account to ${bName || 'the winner'} · ${bAcct}.` +
        (feeDue > 0 ? ` Also send ₦${feeDue.toLocaleString()} of AJOCREDIT fees to the company account.` : ''));
      res.json({ ok: true, status: 'PROCESSING', payout_id: po.id, amount: po.amount,
        beneficiary: ben.length ? ben[0].name : null,
        bank: { bank_code: bCode, account_number: bAcct, account_name: bName || null },
        fee_due_to_company: feeDue,
        pool_balance_reduced: true,
        note: 'the pot is already deducted from the pool balance — mark it PAID once the transfer lands' });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });
  // PROCESSING → PAID. The money reached the winner's bank account: the cycle
  // closes and the next one opens. A payout already PAID can never be paid
  // again — that is the double-payout guard.
  app.post('/api/payouts/:id/paid', auth, async (req, res) => {
    const { admin_phone, transfer_reference } = req.body || {};
    const id = req.params.id;
    const ap = await bindPhone(req, admin_phone);
    if (ap) return res.status(ap.status).json({ error: ap.error });
    const phone = normPhone(admin_phone);
    if (!phone) return res.status(400).json({ error: 'admin_phone required' });
    try {
      const p = await q('SELECT * FROM payouts WHERE id=$1', [id]);
      if (!p.length) return res.status(404).json({ error: 'payout not found' });
      const po = p[0];
      const u = await q('SELECT * FROM users WHERE phone=$1', [phone]);
      if (!u.length || !(await isTreasurer(u[0].id, po.group_id))) {
        return res.status(403).json({ error: 'only the group admin or treasurer can mark a payout paid' });
      }
      if (po.status === 'PAID') return res.status(409).json({ error: 'payout already paid — a second payout is blocked' });
      if (po.status !== 'PROCESSING') return res.status(409).json({ error: `payout is ${String(po.status).toLowerCase()}, not PROCESSING` });
      const pot = await collectedPot(po.cycle_id);
      if (po.amount > pot) return res.status(409).json({ error: `shortfall at payment: pot is ₦${pot.toLocaleString()}, payout ₦${po.amount.toLocaleString()} — blocked` });
      const ben = await q('SELECT u.name, u.id FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.id=$1', [po.beneficiary_id]);
      await q(`UPDATE payouts SET status='PAID', executed_at=NOW(), transfer_reference=$1 WHERE id=$2`,
        [String(transfer_reference || '').slice(0, 80) || null, po.id]);
      await q(`INSERT INTO audit_log (id, actor_id, action, entity, entity_id) VALUES ($1,$2,'payout.paid','payout',$3)`,
        [`al-${Date.now()}`, u[0].id, po.id]);
      // The pot has landed: close this cycle and open the next one.
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
      res.json({ ok: true, status: 'PAID', payout_id: po.id, amount: po.amount,
        beneficiary: ben.length ? ben[0].name : null, next_cycle_id: ncid });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });
  // PROCESSING → FAILED: the transfer did not go through. The pot goes straight
  // back into the pool balance (poolBalance only subtracts PROCESSING/PAID) and
  // the same payout can be approved again — the cycle is never closed twice.
  app.post('/api/payouts/:id/fail', auth, async (req, res) => {
    const { admin_phone, reason } = req.body || {};
    const id = req.params.id;
    const ap = await bindPhone(req, admin_phone);
    if (ap) return res.status(ap.status).json({ error: ap.error });
    const phone = normPhone(admin_phone);
    if (!phone) return res.status(400).json({ error: 'admin_phone required' });
    const why = String(reason || '').trim();
    if (why.length < 3) return res.status(400).json({ error: 'a reason is required — why did the transfer fail?' });
    try {
      const p = await q('SELECT * FROM payouts WHERE id=$1', [id]);
      if (!p.length) return res.status(404).json({ error: 'payout not found' });
      const po = p[0];
      const u = await q('SELECT * FROM users WHERE phone=$1', [phone]);
      if (!u.length || !(await isTreasurer(u[0].id, po.group_id))) {
        return res.status(403).json({ error: 'only the group admin or treasurer can fail a payout' });
      }
      if (po.status === 'PAID') return res.status(409).json({ error: 'payout already paid — it cannot be failed' });
      if (po.status !== 'PROCESSING') return res.status(409).json({ error: `payout is ${String(po.status).toLowerCase()}, not PROCESSING` });
      await q(`UPDATE payouts SET status='FAILED', failure_reason=$1 WHERE id=$2`, [why.slice(0, 300), po.id]);
      await q(`INSERT INTO audit_log (id, actor_id, action, entity, entity_id, detail) VALUES ($1,$2,'payout.failed','payout',$3,$4)`,
        [`al-${Date.now()}`, u[0].id, po.id, JSON.stringify({ reason: why.slice(0, 300) })]);
      await notifyGroup(po.group_id, 'payout', '⚠️ Payout failed — pot restored',
        `₦${po.amount.toLocaleString()} to the beneficiary did not go out (${why.slice(0, 80)}). The money is back in the pool balance and can be approved again.`);
      res.json({ ok: true, status: 'FAILED', payout_id: po.id, note: 'the pot is back in the pool balance' });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });
  // The treasurer sends the ajo fees from the pool bank account to FIDELITY
  // (that is the only place they can physically be: Direct Transfer put them in
  // the pool). This records that it was done — the platform never moves money
  // out of a group's bank account by itself.
  app.post('/api/groups/:id/fees/remitted', auth, async (req, res) => {
    const gid = req.params.id;
    const { admin_phone, amount, reference } = req.body || {};
    const ap = await bindPhone(req, admin_phone);
    if (ap) return res.status(ap.status).json({ error: ap.error });
    const phone = normPhone(admin_phone);
    if (!phone) return res.status(400).json({ error: 'admin_phone required' });
    try {
      const u = await q('SELECT * FROM users WHERE phone=$1', [phone]);
      if (!u.length || !(await isTreasurer(u[0].id, gid))) {
        return res.status(403).json({ error: 'only the group admin or treasurer can record a fee remittance' });
      }
      const due = await feesHeldInPool(gid);
      if (due <= 0) return res.status(409).json({ error: 'no AJOCREDIT fees are owed from this pool' });
      const amt = Number.isFinite(+amount) && +amount > 0 ? Math.min(Math.round(+amount * 100) / 100, due) : due;
      await q(`INSERT INTO fee_remittances (id, group_id, amount, reference, status, detail) VALUES ($1,$2,$3,$4,'CONFIRMED',$5)`,
        [`fr-${Date.now()}`, gid, amt, String(reference || '').slice(0, 80) || null, 'recorded by treasurer']);
      await q(`INSERT INTO audit_log (id, actor_id, action, entity, entity_id, detail) VALUES ($1,$2,'fees.remitted','group',$3,$4)`,
        [`al-${Date.now()}`, u[0].id, gid, JSON.stringify({ amount: amt })]);
      res.json({ ok: true, remitted: amt, still_due: await feesHeldInPool(gid) });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });
  // ---------------- Direct Transfer: receipt upload + treasurer review ----------------
  // A plain bank transfer proves nothing on its own. The member uploads the
  // receipt, the claim sits at PENDING, and NOTHING enters the pool balance
  // until a treasurer confirms it. Rejected claims free the member to upload
  // again; a confirmed claim becomes an ordinary CONFIRMED contribution.
  const RECEIPT_MAX_BYTES = 4 * 1024 * 1024;
  // Only a real screenshot/photo counts: PNG, JPEG, GIF or WebP magic bytes.
  function receiptMagic(b) {
    if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
    if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
    if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'image/gif';
    if (b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
    return null;
  }
  // Returns { dataUrl, hash, mime } or null when it is not an acceptable receipt.
  function parseReceipt(raw) {
    const s = String(raw || '').trim();
    if (!s) return null;
    const m = s.match(/^data:image\/[a-z0-9.+-]+;base64,([\s\S]+)$/i);
    const b64 = (m ? m[1] : s).replace(/\s+/g, '');
    if (b64.length < 16 || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) return null;
    const bytes = Buffer.from(b64, 'base64');
    if (!bytes.length || bytes.length > RECEIPT_MAX_BYTES) return null;
    const mime = receiptMagic(bytes);
    if (!mime) return null;
    return {
      dataUrl: `data:${mime};base64,${b64}`,
      hash: crypto.createHash('sha256').update(bytes).digest('hex'),
      mime,
    };
  }

  // The member says "I transferred" — this records the claim as PENDING.
  app.post('/api/claims', auth, async (req, res) => {
    const { membership_id, cycle_id, amount, receipt, bank_reference } = req.body || {};
    if (!membership_id || !cycle_id || !amount) {
      return res.status(400).json({ error: 'membership_id, cycle_id, amount and receipt are required' });
    }
    const mb = await bindMember(req, membership_id);
    if (mb) return res.status(mb.status).json({ error: mb.error });
    const amt = Math.round(Number(amount));
    if (!Number.isFinite(amt) || amt <= 0 || amt > 10000000) {
      return res.status(400).json({ error: 'amount must be between ₦1 and ₦10,000,000' });
    }
    const img = parseReceipt(receipt);
    if (!img) return res.status(400).json({ error: 'Attach the transfer receipt as an image (PNG or JPG screenshot).' });
    try {
      const mem = await q(`SELECT m.*, cy.group_id AS gid FROM memberships m, cycles cy
        WHERE m.id=$1 AND cy.id=$2 AND m.group_id=cy.group_id`, [membership_id, cycle_id]);
      if (!mem.length) return res.status(404).json({ error: 'that membership and cycle do not belong together' });
      if (mem[0].status !== 'ACTIVE') return res.status(403).json({ error: 'only active members can claim a transfer' });
      const gid = mem[0].gid;
      const pr = await q('SELECT * FROM group_pools WHERE group_id=$1', [gid]);
      if (!pr.length || !pr[0].verified || !pr[0].account_number) {
        return res.status(422).json({ error: 'This group has no verified pool account yet, so a direct transfer cannot be tracked. Ask the admin to save and verify it first.' });
      }
      // One receipt proves one payment — the same picture is never accepted twice.
      const dup = await q('SELECT id, status FROM transfer_claims WHERE receipt_hash=$1', [img.hash]);
      if (dup.length) return res.status(409).json({ error: 'That receipt image has already been used. Each transfer needs its own receipt.' });
      const { fee, total } = feeFor(amt);
      const reference = `TRF-${Date.now()}`;
      const cid = `ct-${Date.now()}`;
      const claimId = `tc-${Date.now()}-${crypto.randomBytes(2).toString('hex')}`;
      // The unique partial index (one PENDING claim per member per cycle) is
      // what actually enforces "no second upload while one is open".
      const ins = await q(`INSERT INTO transfer_claims
          (id, membership_id, group_id, cycle_id, amount, fee, total, channel,
           bank_reference, receipt, receipt_hash, contribution_id, status)
        VALUES ($1,$2,$3,$4,$5,$6,$7,'direct_transfer',$8,$9,$10,$11,'PENDING')
        RETURNING id, status, created_at`,
        [claimId, membership_id, gid, cycle_id, amt, fee, total,
          String(bank_reference || '').trim().slice(0, 60) || null, img.dataUrl, img.hash, cid]);
      // The contribution exists but is PENDING: pool_balance only counts
      // CONFIRMED rows, so an unreviewed claim can never reach the pot.
      await q(`INSERT INTO contributions (id, membership_id, cycle_id, amount, fee, total, method, reference, status)
        VALUES ($1,$2,$3,$4,$5,$6,'direct_transfer',$7,'PENDING') ON CONFLICT (reference) DO NOTHING`,
        [cid, membership_id, cycle_id, amt, fee, total, reference]);
      const plan = await routingPlan(gid, amt, fee, 'bank', 'direct_transfer');
      await recordPaymentTx(plan, gid, membership_id, reference, 'bank', 'AWAITING_REVIEW');
      await q(`INSERT INTO audit_log (id, actor_id, action, entity, entity_id) VALUES ($1,$2,'claim.submit','transfer_claim',$3)`,
        [`al-${Date.now()}`, membership_id, ins[0].id]);
      const reviewers = await q(`SELECT user_id FROM memberships WHERE group_id=$1 AND role IN ('admin','treasurer') AND status='ACTIVE'`, [gid]);
      const payer = await q('SELECT u.name FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.id=$1', [membership_id]);
      for (const rv of reviewers) await notifyUser(rv.user_id, 'claim_pending', 'Transfer receipt waiting 🧾',
        `${payer.length ? payer[0].name : 'A member'} claims ₦${amt.toLocaleString()} by direct transfer. Review it before it counts.`);
      res.json({ ok: true, id: ins[0].id, status: 'PENDING', reference, amount: amt, fee, total,
        channel: 'direct_transfer', receipt_accepted: true,
        note: 'Waiting for the treasurer — this is NOT in the pool balance yet.' });
    } catch (e) {
      if (e && e.code === '23505') {
        return res.status(409).json({ error: 'You already have an open receipt claim for this cycle. Wait for the treasurer to confirm or reject it.' });
      }
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // The treasurer's review queue: receipt image, amount, member, date.
  app.get('/api/claims/pending/:groupId', auth, async (req, res) => {
    const gid = req.params.groupId;
    const tb = await bindTreasurer(req, gid);
    if (tb) return res.status(tb.status).json({ error: tb.error });
    try {
      const rows = await q(`
        SELECT tc.id, tc.amount, tc.fee, tc.total, tc.bank_reference, tc.receipt, tc.status,
               tc.created_at, tc.membership_id, tc.cycle_id, tc.channel,
               u.name AS member_name, u.phone AS member_phone, cy.seq AS cycle_seq
          FROM transfer_claims tc
          JOIN memberships m ON m.id = tc.membership_id
          JOIN users u ON u.id = m.user_id
          JOIN cycles cy ON cy.id = tc.cycle_id
         WHERE tc.group_id = $1 AND tc.status = 'PENDING'
         ORDER BY tc.created_at DESC
         LIMIT 100`, [gid]);
      const counts = {};
      for (const d of await q(`SELECT status, COUNT(*)::int AS n FROM transfer_claims WHERE group_id=$1 GROUP BY status`, [gid])) {
        counts[d.status] = d.n;
      }
      res.json({ ok: true, claims: rows, counts });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  // A member's own claim history (including why one was rejected).
  app.get('/api/claims/mine/:membershipId', auth, async (req, res) => {
    const mb = await bindMember(req, req.params.membershipId);
    if (mb) return res.status(mb.status).json({ error: mb.error });
    try {
      const rows = await q(`SELECT id, cycle_id, amount, fee, total, status, channel, reject_reason, created_at, reviewed_at
        FROM transfer_claims WHERE membership_id=$1 ORDER BY created_at DESC LIMIT 50`, [req.params.membershipId]);
      res.json({ ok: true, claims: rows });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  // Treasurer confirms: only now does the money reach the pool balance.
  app.post('/api/claims/:id/confirm', auth, async (req, res) => {
    const claimed = (req.body || {}).admin_phone || (req.body || {}).treasurer_phone;
    const phone = normPhone(claimed);
    if (!phone) return res.status(400).json({ error: 'admin_phone required' });
    const bindErr = await bindPhone(req, claimed);
    if (bindErr) return res.status(bindErr.status).json({ error: bindErr.error });
    try {
      const cl = await q('SELECT * FROM transfer_claims WHERE id=$1', [req.params.id]);
      if (!cl.length) return res.status(404).json({ error: 'claim not found' });
      const c = cl[0];
      const u = await q('SELECT * FROM users WHERE phone=$1', [phone]);
      if (!u.length || !(await isTreasurer(u[0].id, c.group_id))) {
        return res.status(403).json({ error: 'only the group treasurer or admin can confirm a payment' });
      }
      if (c.status !== 'PENDING') return res.status(409).json({ error: `claim already ${String(c.status).toLowerCase()}` });
      const cref = c.contribution_id
        ? await q('SELECT reference FROM contributions WHERE id=$1', [c.contribution_id])
        : [];
      const ref = cref.length ? cref[0].reference : c.id;
      await q(`UPDATE transfer_claims SET status='CONFIRMED', reviewed_by=$1, reviewed_at=NOW(), reject_reason=NULL WHERE id=$2`,
        [u[0].id, c.id]);
      // Only CONFIRMED contributions ever enter pool_balance.
      await q(`UPDATE contributions SET status='CONFIRMED' WHERE id=$1 AND status='PENDING'`, [c.contribution_id]);
      const h = crypto.createHash('sha256').update('claim:' + c.id).digest('hex').slice(0, 16);
      const h2 = crypto.createHash('sha256').update('claimfee:' + c.id).digest('hex').slice(0, 16);
      await q(`INSERT INTO ledger_entries (id, group_id, debit_acct, credit_acct, amount, type, ref_id, idempotency_key, status, hash)
        VALUES ($1,$2,$3,$4,$5,'contribution',$6,$7,'CONFIRMED',$8) ON CONFLICT (idempotency_key) DO NOTHING`,
        [`le-${Date.now()}c`, c.group_id, 'psp:direct_transfer', `pot:${c.group_id}`, Number(c.amount), ref, `webhook:${ref}`, h]);
      if (Number(c.fee) > 0) {
        await q(`INSERT INTO ledger_entries (id, group_id, debit_acct, credit_acct, amount, type, ref_id, idempotency_key, status, hash)
          VALUES ($1,$2,$3,$4,$5,'fee',$6,$7,'CONFIRMED',$8) ON CONFLICT (idempotency_key) DO NOTHING`,
          [`le-${Date.now()}cf`, c.group_id, `member:${c.membership_id}`, 'revenue:ajocredit-fees', Number(c.fee), ref, `webhook:${ref}:fee`, h2]);
      }
      try { await confirmPaymentTx(ref, 'bank'); }
      catch (e) { console.log('claim transaction confirm failed: ' + e.message); }
      await q(`INSERT INTO audit_log (id, actor_id, action, entity, entity_id) VALUES ($1,$2,'claim.confirm','transfer_claim',$3)`,
        [`al-${Date.now()}`, u[0].id, c.id]);
      await announceContribution({ group_id: c.group_id, cycle_id: c.cycle_id, membership_id: c.membership_id, pot: Number(c.amount) }, ref);
      res.json({ ok: true, status: 'CONFIRMED', claim_id: c.id, amount: Number(c.amount), fee: Number(c.fee),
        entered_pool: true, note: 'Now counted in the group pool balance.' });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  // Treasurer rejects: with a reason, and the member is free to upload again.
  app.post('/api/claims/:id/reject', auth, async (req, res) => {
    const { admin_phone, treasurer_phone, reason } = req.body || {};
    const claimed = admin_phone || treasurer_phone;
    const phone = normPhone(claimed);
    if (!phone) return res.status(400).json({ error: 'admin_phone required' });
    const why = String(reason || '').trim();
    if (why.length < 3) return res.status(400).json({ error: 'a rejection reason is required so the member knows what to fix' });
    const bindErr = await bindPhone(req, claimed);
    if (bindErr) return res.status(bindErr.status).json({ error: bindErr.error });
    try {
      const cl = await q('SELECT * FROM transfer_claims WHERE id=$1', [req.params.id]);
      if (!cl.length) return res.status(404).json({ error: 'claim not found' });
      const c = cl[0];
      const u = await q('SELECT * FROM users WHERE phone=$1', [phone]);
      if (!u.length || !(await isTreasurer(u[0].id, c.group_id))) {
        return res.status(403).json({ error: 'only the group treasurer or admin can reject a payment' });
      }
      if (c.status !== 'PENDING') return res.status(409).json({ error: `claim already ${String(c.status).toLowerCase()}` });
      const cref = c.contribution_id
        ? await q('SELECT reference FROM contributions WHERE id=$1', [c.contribution_id])
        : [];
      const ref = cref.length ? cref[0].reference : c.id;
      await q(`UPDATE transfer_claims SET status='REJECTED', reject_reason=$1, reviewed_by=$2, reviewed_at=NOW() WHERE id=$3`,
        [why.slice(0, 300), u[0].id, c.id]);
      // The money never entered, but the row must not linger as PENDING either.
      await q(`UPDATE contributions SET status='REJECTED' WHERE id=$1 AND status='PENDING'`, [c.contribution_id]);
      await q(`UPDATE transactions SET status='REJECTED' WHERE reference=$1`, [ref]);
      await q(`INSERT INTO audit_log (id, actor_id, action, entity, entity_id, detail) VALUES ($1,$2,'claim.reject','transfer_claim',$3,$4)`,
        [`al-${Date.now()}`, u[0].id, c.id, JSON.stringify({ reason: why.slice(0, 300) })]);
      const owner = c.membership_id ? await q('SELECT user_id FROM memberships WHERE id=$1', [c.membership_id]) : [];
      if (owner.length) {
        await notifyUser(owner[0].user_id, 'claim_rejected', 'Receipt rejected ❌',
          `Your ₦${Number(c.amount).toLocaleString()} transfer receipt was not accepted: ${why.slice(0, 120)} You can upload a corrected receipt now.`);
      }
      res.json({ ok: true, status: 'REJECTED', claim_id: c.id, reason: why.slice(0, 300),
        note: 'The open slot is free again — the member can upload a corrected receipt.' });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  // Appoint (or remove) a treasurer: someone other than the admin who can
  // review receipts and mark payouts. Groups default to "the admin is the
  // treasurer" until one is appointed.
  app.post('/api/groups/:id/treasurer', auth, async (req, res) => {
    const gid = req.params.id;
    const b = req.body || {};
    const claimed = b.admin_phone;
    const bindErr = await bindPhone(req, claimed);
    if (bindErr) return res.status(bindErr.status).json({ error: bindErr.error });
    try {
      let actor = null;
      if (req.user && (await isAdmin(req.user, gid))) actor = req.user;
      if (!actor) {
        const p = normPhone(claimed);
        const u = p ? await q('SELECT id FROM users WHERE phone=$1', [p]) : [];
        if (u.length && (await isAdmin(u[0].id, gid))) actor = u[0].id;
      }
      if (!actor) return res.status(403).json({ error: 'only a group admin can appoint a treasurer' });
      const mid = String(b.membership_id || '').trim();
      if (!mid) return res.status(400).json({ error: 'membership_id required' });
      const target = await q(`SELECT id, role FROM memberships WHERE id=$1 AND group_id=$2`, [mid, gid]);
      if (!target.length) return res.status(404).json({ error: 'member not found in this group' });
      const action = b.action === 'remove' ? 'remove' : 'add';
      const role = action === 'remove' ? 'member' : 'treasurer';
      await q(`UPDATE memberships SET role=$1 WHERE id=$2`, [role, mid]);
      await q(`INSERT INTO audit_log (id, actor_id, action, entity, entity_id) VALUES ($1,$2,$3,'membership',$4)`,
        [`al-${Date.now()}`, actor, 'treasurer.' + action, mid]);
      res.json({ ok: true, membership_id: mid, role });
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
