// One-shot schema migration to managed Postgres. Run with DATABASE_URL set (use DIRECT URL, not pooled).
// Usage: $env:DATABASE_URL="<direct-url>"; node api/migrate-neon.mjs
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import pg from 'pg';
const here = path.dirname(fileURLToPath(import.meta.url));
const sql = fs.readFileSync(path.join(here, '..', 'db', 'init.sql'), 'utf8').replace(/CREATE EXTENSION[^;]+;/, '');
const alter = `ALTER TABLE groups ADD COLUMN IF NOT EXISTS dest_bank_code TEXT;
ALTER TABLE groups ADD COLUMN IF NOT EXISTS dest_account_number TEXT;
ALTER TABLE groups ADD COLUMN IF NOT EXISTS dest_account_name TEXT;
ALTER TABLE groups ADD COLUMN IF NOT EXISTS dest_verified BOOLEAN NOT NULL DEFAULT FALSE;`;
const client = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
await client.connect();
await client.query(sql);
await client.query(alter);
const tables = ['users', 'groups', 'memberships', 'cycles', 'contributions', 'ledger_entries', 'disputes', 'notifications'];
for (const t of tables) {
  const r = await client.query(`SELECT COUNT(*) c FROM ${t}`);
  console.log(t, r.rows[0].c);
}
await client.end();
console.log('MIGRATE-OK');
