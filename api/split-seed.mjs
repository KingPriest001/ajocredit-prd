// Acceptance fixture: seed the transactions ledger with Contribution vs Fee
// split rows, built by the REAL money module (money.plan -> assertNoMixing ->
// recordTransaction) so the admin Transactions page can be exercised without
// a live gateway round-trip. Run with the API stopped (PGlite is single
// process): node split-seed.mjs
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { PGlite } = await import('@electric-sql/pglite');
const money = require('./money.js');
const moneyRoutes = require('./money-routes.js');

const db = new PGlite(path.join(__dirname, '.pglite-data'));
await db.waitReady;
const exec = (sql) => db.exec(sql);
const q = async (t, p) => (await db.query(t, p)).rows;
const ctx = { q };

// Same schema the API installs on boot (idempotent).
const initSql = fs.readFileSync(path.join(__dirname, '..', 'db', 'init.sql'), 'utf8')
  .replace(/CREATE EXTENSION[^;]+;/, '');
await exec(initSql);
await moneyRoutes.installSchema({ exec, q });

// The fee rule, mirroring server.js feeFor(): 1% up to and including 10,000,
// 0.5% above, rounded to 2 decimal places.
function feeFor(amount) {
  const rate = amount <= 10000 ? 0.01 : 0.005;
  const fee = Math.round(amount * rate * 100) / 100;
  return { fee, total: Math.round((amount + fee) * 100) / 100, rate };
}

// The group's own pool account (MUST differ from the company account - the
// production assertNoMixing check below enforces it).
await q(
  `INSERT INTO group_pools (group_id, bank_name, account_number, account_name, bank_code, verified)
   VALUES ('g-aj4821','ZENITH','9876543210','Aunty Bola Market Women','057',TRUE)
   ON CONFLICT (group_id) DO UPDATE SET bank_name='ZENITH', account_number='9876543210',
     account_name='Aunty Bola Market Women', bank_code='057', verified=TRUE, updated_at=NOW()`
);

const fixtures = [
  { ref: 'AJO-ACC-1', amount: 5000,  gateway: 'paystack',    status: 'CONFIRMED' },
  { ref: 'AJO-ACC-2', amount: 10000, gateway: 'paystack',    status: 'CONFIRMED' }, // 1% boundary
  { ref: 'AJO-ACC-3', amount: 25000, gateway: 'flutterwave', status: 'CONFIRMED' }, // 0.5%
  { ref: 'AJO-ACC-4', amount: 15000, gateway: 'flutterwave', status: 'CONFIRMED' }, // 0.5%
  { ref: 'AJO-ACC-5', amount: 2000,  gateway: 'paystack',    status: 'PENDING'   },
  { ref: 'AJO-ACC-6', amount: 500,   gateway: 'paystack',    status: 'FAILED'    },
];

await exec(`DELETE FROM transactions WHERE reference LIKE 'AJO-ACC-%'`);

for (const f of fixtures) {
  const { fee, total } = feeFor(f.amount);
  // Real routing decision: company account vs group pool, custody/two_step/split.
  const plan = await money.plan(ctx, { groupId: 'g-aj4821', amount: f.amount, fee, gateway: f.gateway });
  money.assertNoMixing(plan);
  await money.recordTransaction(ctx, {
    reference: f.ref, transaction_id: 'TX-' + f.ref, group_id: 'g-aj4821', member_id: 'm-bola',
    contribution_amount: f.amount, fee_amount: fee, total_amount: total,
    contribution_destination: plan.pool ? plan.pool.label : 'pool:unconfigured',
    fee_destination: plan.company ? plan.company.label : 'company:unconfigured',
    gateway: f.gateway, mode: plan.mode, status: f.status,
  });
  console.log(`seeded ${f.ref}: contribution ${f.amount} fee ${fee} total ${total} (${plan.mode}) -> pool ${plan.pool && plan.pool.label} / company ${plan.company && plan.company.label}`);
}

// Confirmed contributions so the group pool balance is non-zero on the pool UI.
await exec(`DELETE FROM contributions WHERE reference LIKE 'AJO-ACC-%'`);
for (const [ref, amount] of [['AJO-ACC-2', 10000], ['AJO-ACC-3', 25000]]) {
  const { fee, total } = feeFor(amount);
  await q(
    `INSERT INTO contributions (id, membership_id, cycle_id, amount, fee, total, method, reference, status)
     VALUES ($1,'m-bola','c-aj4821-1',$2,$3,$4,'transfer',$5,'CONFIRMED') ON CONFLICT (reference) DO NOTHING`,
    [`ct-${ref.toLowerCase()}`, amount, fee, total, ref]
  );
}

const rows = await q(`SELECT reference, contribution_amount, fee_amount, total_amount, status FROM transactions WHERE reference LIKE 'AJO-ACC-%' ORDER BY created_at`);
console.table(rows);
const bal = await moneyRoutes.poolBalance(ctx, 'g-aj4821');
console.log('pool balance:', bal);
const company = await q(`SELECT bank_name, account_number, account_name FROM company_account WHERE id='main'`);
console.log('company account:', company[0]);
await db.close();
console.log('SEED DONE');
