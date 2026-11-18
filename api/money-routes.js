// AJOCREDIT - company account, group pools, transactions and the split-payment
// wiring. The rules live in api/money.js; this file is the plumbing.

const crypto = require('crypto');
const money = require('./money');

// The company account that receives EVERY fee: ZENONMAG CONCEPTS VENTURES at
// FIDELITY BANK 5601861011. No personal account exists anywhere in this code —
// COMPANY_* env vars (.env / Render) win so the live fee account is enforced
// on every boot, and the admin panel can still edit it between restarts.
const DEFAULT_COMPANY_ACCOUNT = {
  id: 'main',
  bank_name: process.env.COMPANY_BANK || 'FIDELITY BANK',
  account_number: process.env.COMPANY_ACCOUNT || '5601861011',
  account_name: process.env.COMPANY_NAME || 'ZENONMAG CONCEPTS VENTURES',
  bank_code: process.env.COMPANY_BANK_CODE || '070', // FIDELITY BANK (NIBSS)
};

async function installSchema(deps) {
  const exec = deps.exec;
  const q = deps.q;

  await exec(`
    CREATE TABLE IF NOT EXISTS company_account (
      id TEXT PRIMARY KEY,
      bank_name TEXT,
      account_number TEXT,
      account_name TEXT,
      bank_code TEXT,
      paystack_subaccount_code TEXT,
      flutterwave_subaccount_id TEXT,
      transfer_enabled BOOLEAN NOT NULL DEFAULT FALSE,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS group_pools (
      group_id TEXT PRIMARY KEY,
      bank_name TEXT,
      account_number TEXT,
      account_name TEXT,
      bank_code TEXT,
      paystack_subaccount_code TEXT,
      flutterwave_subaccount_id TEXT,
      transfer_enabled BOOLEAN NOT NULL DEFAULT FALSE,
      split_enabled BOOLEAN NOT NULL DEFAULT FALSE,
      verified BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS transactions (
      id TEXT PRIMARY KEY,
      transaction_id TEXT,
      group_id TEXT,
      member_id TEXT,
      contribution_amount NUMERIC NOT NULL DEFAULT 0,
      fee_amount NUMERIC NOT NULL DEFAULT 0,
      total_amount NUMERIC NOT NULL DEFAULT 0,
      contribution_destination TEXT,
      fee_destination TEXT,
      gateway TEXT,
      mode TEXT,
      status TEXT NOT NULL DEFAULT 'PENDING',
      reference TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS transactions_group_idx ON transactions (group_id);
    CREATE INDEX IF NOT EXISTS transactions_created_idx ON transactions (created_at DESC);

    CREATE TABLE IF NOT EXISTS paystack_splits (
      id TEXT PRIMARY KEY,
      group_id TEXT NOT NULL,
      ratio_key TEXT NOT NULL,
      split_code TEXT NOT NULL,
      tier_index INT NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS paystack_splits_key_idx ON paystack_splits (group_id, ratio_key);
  `);

  // The company account is seeded once. When COMPANY_* env vars are set (the
  // launch .env / Render), they are re-applied on every boot so the fee
  // account can never drift away from the company's FIDELITY BANK account.
  const envForced = !!process.env.COMPANY_ACCOUNT;
  await q(
    `INSERT INTO company_account (id, bank_name, account_number, account_name, bank_code)
     VALUES ($1,$2,$3,$4,$5) ON CONFLICT (id) DO UPDATE SET
       bank_name=EXCLUDED.bank_name, account_number=EXCLUDED.account_number,
       account_name=EXCLUDED.account_name, bank_code=EXCLUDED.bank_code, updated_at=NOW()
     WHERE $6::boolean`,
    [DEFAULT_COMPANY_ACCOUNT.id, DEFAULT_COMPANY_ACCOUNT.bank_name,
      DEFAULT_COMPANY_ACCOUNT.account_number, DEFAULT_COMPANY_ACCOUNT.account_name,
      DEFAULT_COMPANY_ACCOUNT.bank_code, envForced]
  );
}

// Every group gets its own pool wallet the moment the group is created.
async function ensurePool(ctx, groupId) {
  const { q } = ctx;
  const ex = await q('SELECT group_id FROM group_pools WHERE group_id=$1', [groupId]);
  if (ex.length) return ex[0];
  await q(
    `INSERT INTO group_pools (group_id) VALUES ($1) ON CONFLICT (group_id) DO NOTHING`,
    [groupId]
  );
  return { group_id: groupId };
}

// The money a group has collected - contributions only. Never the fees: a
// group admin must not see the company's money.
async function poolBalance(ctx, groupId) {
  const { q } = ctx;
  const rows = await q(
    `SELECT COALESCE(SUM(amount),0)::float AS collected,
            COALESCE(SUM(fee),0)::float AS fees_booked,
            COUNT(*)::int AS payments
       FROM contributions
      WHERE status='CONFIRMED'
        AND cycle_id IN (SELECT id FROM cycles WHERE group_id=$1)`,
    [groupId]
  );
  const r = rows.length ? rows[0] : { collected: 0, fees_booked: 0, payments: 0 };
  return {
    group_id: groupId,
    pool_balance: Number(r.collected) || 0,
    payments: r.payments || 0,
    // The fee total is the company's, so the group is told nothing about it.
    note: 'This is the group pool only. AJOCREDIT fees belong to the company and are not shown here.',
  };
}

function installRoutes(ctx) {
  const { app, q, exec, requireAdmin } = ctx;
  const authUser = ctx.requireSession;

  // ---- company account (admin) --------------------------------------------
  app.get('/api/admin/company-account', requireAdmin, async (req, res) => {
    try {
      const r = await q("SELECT * FROM company_account WHERE id='main'");
      const row = r.length ? r[0] : null;
      res.json({
        ok: true,
        company_account: row,
        // Which gateway the fees go through, and whether it can split.
        payment_gateway: process.env.PAYMENT_GATEWAY || null,
        gateways: {
          paystack: {
            configured: !!process.env.PAYSTACK_SECRET_KEY,
            live: String(process.env.PAYSTACK_PUBLIC_KEY || '').startsWith('pk_live_'),
            disabled: String(process.env.PAYMENT_GATEWAY || '').toUpperCase() === 'FLUTTERWAVE_LIVE_ONLY',
            subaccount_code: row ? row.paystack_subaccount_code : null,
            transfer: row ? !!row.transfer_enabled : false,
          },
          flutterwave: {
            configured: !!process.env.FLUTTERWAVE_SECRET_KEY,
            subaccount_id: row ? row.flutterwave_subaccount_id : null,
            transfer: row ? !!row.transfer_enabled : false,
          },
        },
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.put('/api/admin/company-account', requireAdmin, async (req, res) => {
    try {
      const b = req.body || {};
      await q("UPDATE company_account SET bank_name=$1, account_number=$2, account_name=$3, bank_code=$4, updated_at=NOW() WHERE id='main'",
        [b.bank_name || null, b.account_number || null, b.account_name || null, b.bank_code || null]);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Register the gateway subaccount the fees are split to.
  app.post('/api/admin/company-account/subaccount', requireAdmin, async (req, res) => {
    try {
      const b = req.body || {};
      const gateway = b.gateway === 'flutterwave' ? 'flutterwave' : 'paystack';
      if (gateway === 'paystack') {
        await q("UPDATE company_account SET paystack_subaccount_code=$1, transfer_enabled=$2, updated_at=NOW() WHERE id='main'",
          [b.code || null, b.transfer ? true : false]);
      } else {
        await q("UPDATE company_account SET flutterwave_subaccount_id=$1, transfer_enabled=$2, updated_at=NOW() WHERE id='main'",
          [b.code || null, b.transfer ? true : false]);
      }
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ---- group pool (the group's own admin) --------------------------------
  app.get('/api/groups/:id/pool', authUser, async (req, res) => {
    try {
      const pool = await q('SELECT * FROM group_pools WHERE group_id=$1', [req.params.id]);
      const bal = await poolBalance(ctx, req.params.id);
      // Only the company's own money stays hidden: the fee total is never sent.
      res.json({
        ok: true,
        pool: pool.length ? {
          group_id: pool[0].group_id,
          bank_name: pool[0].bank_name,
          account_number: pool[0].account_number,
          account_name: pool[0].account_name,
          bank_code: pool[0].bank_code,
          verified: pool[0].verified,
          split_enabled: pool[0].split_enabled,
          paystack_subaccount_code: pool[0].paystack_subaccount_code,
          flutterwave_subaccount_id: pool[0].flutterwave_subaccount_id,
        } : null,
        balance: bal,
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/groups/:id/pool', authUser, async (req, res) => {
    try {
      const b = req.body || {};
      const gid = req.params.id;
      // The group admin is the only one who may set the pool account.
      const u = await q('SELECT id, phone, name FROM users WHERE id=$1', [req.user]);
      if (!u.length) return res.status(404).json({ error: 'Account not found.' });
      const isAdmin = await q(
        `SELECT id FROM memberships WHERE user_id=$1 AND group_id=$2 AND role='admin' AND status='ACTIVE'`,
        [req.user, gid]);
      if (!isAdmin.length) {
        // Fall back to the phone check, like the payout destination does.
        const ab = await ctx.bindPhone(req, b.admin_phone);
        if (ab) return res.status(ab.status).json({ error: ab.error });
      }
      await ctx.ensurePool(ctx, gid);
      await q(
        `UPDATE group_pools SET bank_name=$1, account_number=$2, account_name=$3, bank_code=$4,
           verified=$5, updated_at=NOW() WHERE group_id=$6`,
        [b.bank_name || null, b.account_number || null, b.account_name || null, b.bank_code || null,
          b.verified === true ? true : false, gid]
      );
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Register the group's gateway subaccount and turn the split on.
  app.post('/api/groups/:id/pool/subaccount', authUser, async (req, res) => {
    try {
      const b = req.body || {};
      const gid = req.params.id;
      const isAdmin = await q(
        `SELECT id FROM memberships WHERE user_id=$1 AND group_id=$2 AND role='admin' AND status='ACTIVE'`,
        [req.user, gid]);
      if (!isAdmin.length) return res.status(403).json({ error: 'Only the group admin can do this.' });
      await ctx.ensurePool(ctx, gid);
      const gateway = b.gateway === 'flutterwave' ? 'flutterwave' : 'paystack';
      if (gateway === 'paystack') {
        await q('UPDATE group_pools SET paystack_subaccount_code=$1, split_enabled=$2, updated_at=NOW() WHERE group_id=$3',
          [b.code || null, b.split ? true : false, gid]);
      } else {
        await q('UPDATE group_pools SET flutterwave_subaccount_id=$1, split_enabled=$2, updated_at=NOW() WHERE group_id=$3',
          [b.code || null, b.split ? true : false, gid]);
      }
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ---- transactions (admin) ----------------------------------------------
  app.get('/api/admin/transactions', requireAdmin, async (req, res) => {
    try {
      const f = req.query || {};
      const where = [];
      const params = [];
      if (f.group_id) { params.push(f.group_id); where.push(`group_id=$${params.length}`); }
      if (f.type === 'contribution') { where.push(`contribution_amount > 0`); }
      if (f.type === 'fee') { where.push(`fee_amount > 0`); }
      if (f.status) { params.push(f.status); where.push(`status=$${params.length}`); }
      if (f.gateway) { params.push(f.gateway); where.push(`gateway=$${params.length}`); }
      const rows = await q(
        `SELECT * FROM transactions
          ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
          ORDER BY created_at DESC LIMIT 500`, params);
      // Totals never count a failed payment (FAILED / SPLIT_FAILED): money that
      // was not taken - or could not be split - must not inflate what was
      // actually collected. The rows above still show every attempt.
      const totalWhere = [...where, `status NOT LIKE '%FAILED%'`];
      const totals = await q(
        `SELECT COALESCE(SUM(contribution_amount),0)::float AS contributions,
                COALESCE(SUM(fee_amount),0)::float AS fees,
                COALESCE(SUM(total_amount),0)::float AS total,
                COUNT(*)::int AS count
           FROM transactions
          ${totalWhere.length ? 'WHERE ' + totalWhere.join(' AND ') : ''}`, params);
      res.json({ ok: true, transactions: rows, totals: totals.length ? totals[0] : null });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // The fees queue: what the company has collected, and what is still owed.
  app.get('/api/admin/fees', requireAdmin, async (req, res) => {
    try {
      const company = await q("SELECT * FROM company_account WHERE id='main'");
      const r = await q(
        `SELECT COALESCE(SUM(fee_amount) FILTER (WHERE status NOT LIKE '%FAILED%'),0)::float AS collected,
                COUNT(*) FILTER (WHERE status NOT LIKE '%FAILED%')::int AS payments,
                COALESCE(SUM(fee_amount) FILTER (WHERE status='PENDING'),0)::float AS pending,
                COALESCE(SUM(fee_amount) FILTER (WHERE status LIKE '%FAILED%'),0)::float AS failed
           FROM transactions`);
      const byGroup = await q(
        `SELECT group_id, COALESCE(SUM(fee_amount) FILTER (WHERE status NOT LIKE '%FAILED%'),0)::float AS fees,
                COUNT(*) FILTER (WHERE status NOT LIKE '%FAILED%')::int AS payments
           FROM transactions GROUP BY group_id ORDER BY fees DESC LIMIT 50`);
      res.json({
        ok: true,
        company_account: company.length ? company[0] : null,
        fees: r.length ? r[0] : { collected: 0, payments: 0, pending: 0, failed: 0 },
        by_group: byGroup,
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // A group admin sees their own pool, and never the company's fees.
  app.get('/api/groups/:id/transactions', authUser, async (req, res) => {
    try {
      const gid = req.params.id;
      const rows = await q(
        `SELECT reference, contribution_amount, total_amount, gateway, status, created_at
           FROM transactions WHERE group_id=$1 ORDER BY created_at DESC LIMIT 100`, [gid]);
      res.json({ ok: true, transactions: rows });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
}

module.exports = { installSchema, installRoutes, ensurePool, poolBalance, DEFAULT_COMPANY_ACCOUNT };
