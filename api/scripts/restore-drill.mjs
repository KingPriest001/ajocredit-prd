// Restore drill: rebuilds a database from a backups/*.json snapshot into a fresh dir,
// then verifies row counts match the snapshot. Run: node scripts/restore-drill.mjs [backup-file]
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const here = path.dirname(fileURLToPath(import.meta.url));
const file = process.argv[2] || fs.readdirSync(path.join(here, '..', '..', 'backups')).filter((f) => f.endsWith('.json')).sort().pop();
if (!file) { console.error('No backup found in backups/'); process.exit(1); }
const snap = JSON.parse(fs.readFileSync(path.join(here, '..', '..', 'backups', path.basename(file)), 'utf8'));
const { PGlite } = await import('@electric-sql/pglite');
const db = new PGlite(path.join(here, '..', '.pglite-restore-test'));
await db.waitReady;
const schema = fs.readFileSync(path.join(here, '..', '..', 'db', 'init.sql'), 'utf8').replace(/CREATE EXTENSION[^;]+;/, '');
const schemaOnly = schema.split(/(?=^INSERT INTO)/m)[0];
await db.exec(schemaOnly + `
ALTER TABLE groups ADD COLUMN IF NOT EXISTS dest_bank_code TEXT;
ALTER TABLE groups ADD COLUMN IF NOT EXISTS dest_account_number TEXT;
ALTER TABLE groups ADD COLUMN IF NOT EXISTS dest_account_name TEXT;
ALTER TABLE groups ADD COLUMN IF NOT EXISTS dest_verified BOOLEAN NOT NULL DEFAULT FALSE;`);
let ok = true;
for (const [table, rows] of Object.entries(snap.tables)) {
  if (!Array.isArray(rows) || !rows.length) continue;
  const cols = Object.keys(rows[0]);
  for (const r of rows) {
    await db.query(`INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(',')}) ON CONFLICT DO NOTHING`, cols.map((c) => (typeof r[c] === 'object' && r[c] !== null ? JSON.stringify(r[c]) : r[c])));
  }
  const got = (await db.query(`SELECT COUNT(*) c FROM ${table}`)).rows[0].c;
  const match = Number(got) === rows.length;
  if (!match) ok = false;
  console.log(`${match ? 'RESTORE-OK' : 'RESTORE-MISMATCH'} ${table}: snapshot=${rows.length} restored=${got}`);
}
console.log(ok ? 'DRILL-PASS: restore reproduces the backup' : 'DRILL-FAIL');
process.exit(ok ? 0 : 1);
