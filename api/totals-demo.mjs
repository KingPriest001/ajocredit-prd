// One-off proof: totals must count CONFIRMED and PENDING, but NEVER
// FAILED / SPLIT_FAILED. Run with the API stopped (PGlite is single-process).
import path from 'path';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { PGlite } = await import('@electric-sql/pglite');
const db = new PGlite(path.join(__dirname, '..', 'api', '.pglite-data'));
await db.waitReady;
const q = async (t, p) => (await db.query(t, p)).rows;

await db.exec(`DELETE FROM transactions WHERE reference LIKE 'DEMO-%'`);
const rows = [
  // reference, contribution, fee, total, status
  ['DEMO-OK-500',   500, 5, 505, 'CONFIRMED'],
  ['DEMO-FAIL-500', 500, 5, 505, 'FAILED'],
  ['DEMO-SPLITFAIL-500', 500, 5, 505, 'SPLIT_FAILED'],
];
for (const [ref, amt, fee, tot, st] of rows) {
  await q(
    `INSERT INTO transactions (id, transaction_id, group_id, member_id, contribution_amount,
       fee_amount, total_amount, contribution_destination, fee_destination, gateway, mode, status, reference, created_at)
     VALUES ($1,$1,'g-demo','m-demo',$2,$3,$4,'pool:custody/••0000','company:FIDELITY/••6011','flutterwave','split',$5,$1,NOW())
     ON CONFLICT (id) DO NOTHING`,
    [ref, amt, fee, tot, st]
  );
}
const all = await q(`SELECT reference, contribution_amount, fee_amount, total_amount, status FROM transactions WHERE reference LIKE 'DEMO-%' ORDER BY created_at`);
console.table(all);
await db.close();
console.log('DEMO ROWS SEEDED');
