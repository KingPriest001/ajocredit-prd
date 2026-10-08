// Starts embedded Postgres, loads db/init.sql, verifies seed. Run: node db-start.mjs
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import EmbeddedPostgres from 'embedded-postgres';

const here = path.dirname(fileURLToPath(import.meta.url));
const pg = new EmbeddedPostgres({
  databaseDir: path.join(here, '.pgdata'),
  port: 5432,
  user: 'postgres',
  password: 'postgres',
  persistent: true,
});

try {
  console.log('Starting embedded Postgres...');
  await pg.initialise();
  await pg.start();
  console.log('Postgres up on :5432');
  const client = pg.getPgClient();
  await client.connect();
  const exists = await client.query('SELECT 1 FROM pg_database WHERE datname=$1', ['ajocredit']);
  if (exists.rows.length === 0) { await client.query('CREATE DATABASE ajocredit'); console.log('Created database ajocredit'); }
  await client.end();
  const seed = pg.getPgClient();
  seed.database = 'ajocredit';
  await seed.connect();
  const sql = fs.readFileSync(path.join(here, '..', 'db', 'init.sql'), 'utf8');
  await seed.query(sql);
  const check = await seed.query('SELECT (SELECT COUNT(*) FROM users) users, (SELECT COUNT(*) FROM groups) groups, (SELECT COUNT(*) FROM ledger_entries) ledger');
  console.log('Seed check:', check.rows[0]);
  await seed.end();
  console.log('DB-READY (leaving server running; Ctrl+C to stop)');
  setInterval(() => {}, 1000000);
} catch (e) { console.error('DB-FAIL:', e.message); process.exit(1); }
