// Nightly backup: dumps all tables to backups/ajocredit-YYYYMMDD.json (gitignored).
// Run: node scripts/backup.js (add to Task Scheduler for nightly runs).
const fs = require('fs');
const path = require('path');
(async () => {
  const { PGlite } = await import('@electric-sql/pglite');
  const db = new PGlite(path.join(__dirname, '..', '.pglite-data'));
  await db.waitReady;
  const tables = ['users', 'groups', 'memberships', 'cycles', 'contributions', 'payouts', 'ledger_entries', 'score_history', 'disputes', 'consents', 'notifications', 'referrals', 'audit_log', 'devices'];
  const out = { exported_at: new Date().toISOString(), tables: {} };
  for (const t of tables) {
    try { out.tables[t] = (await db.query(`SELECT * FROM ${t}`)).rows; }
    catch (e) { out.tables[t] = { error: e.message }; }
  }
  const dir = path.join(__dirname, '..', '..', 'backups');
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, `ajocredit-${new Date().toISOString().slice(0, 10)}.json`);
  fs.writeFileSync(f, JSON.stringify(out));
  console.log('BACKUP-OK', f, Object.entries(out.tables).map(([k, v]) => `${k}:${v.length ?? 0}`).join(' '));
  process.exit(0);
})().catch((e) => { console.error('BACKUP-FAIL:', e.message); process.exit(1); });
