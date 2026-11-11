// Sets/updates the AJOCREDIT API's Render env vars. Run: node render-env.mjs
// Reads secrets from ../.env (never committed).
//
// IMPORTANT: Render REPLACES the whole envVars array on PATCH. A naive update that
// only lists the variables it manages silently DELETES every other live variable
// (FLUTTERWAVE_SECRET_KEY, FLW_WEBHOOK_HASH, WHATSAPP_*, REQUIRE_AUTH, ...), which
// would break live payments and auth. So we read the current set first and merge.
import fs from 'fs';
const env = {};
fs.readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n').forEach((l) => {
  const m = l.match(/^\s*([A-Z0-9_]+)=(.*)\s*$/);
  if (m) env[m[1]] = m[2].trim();
});
const KEY = process.env.RENDER_API_KEY;
if (!KEY) { console.error('Set RENDER_API_KEY env first'); process.exit(1); }
const H = { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };
const SERVICE = 'srv-db44g5e0tbcc73d3d7tg';

// The variables this script owns. Everything else already on the service is preserved.
const managed = {
  USE_EXTERNAL_DB: '1',
  NODE_OPTIONS: '--max-old-space-size=384',
  DATABASE_URL: process.env.NEON_POOLED_URL || env.DATABASE_URL || '',
  PAYSTACK_PUBLIC_KEY: env.PAYSTACK_PUBLIC_KEY,
  PAYSTACK_SECRET_KEY: env.PAYSTACK_SECRET_KEY,
  TERMII_API_KEY: env.TERMII_API_KEY,
  PAYMENTS_MODE: 'direct',
};

const cur = await (await fetch(`https://api.render.com/v1/services/${SERVICE}`, { headers: H })).json();
const existing = cur?.serviceDetails?.envVars || [];
const merged = [...existing];
for (const [k, v] of Object.entries(managed)) {
  if (!v) { console.warn(`skip ${k} - no value available`); continue; }
  const i = merged.findIndex((e) => e.key === k);
  if (i >= 0) merged[i] = { key: k, value: v };
  else merged.push({ key: k, value: v });
}
console.log(`env vars: ${existing.length} -> ${merged.length}`);
console.log('keys now on the service:', merged.map((e) => e.key).join(', '));
const r = await fetch(`https://api.render.com/v1/services/${SERVICE}`, {
  method: 'PATCH', headers: H, body: JSON.stringify({ serviceDetails: { envVars: merged } }),
});
console.log('STATUS:', r.status);
console.log((await r.text()).slice(0, 300));
