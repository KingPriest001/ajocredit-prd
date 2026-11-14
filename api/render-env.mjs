// Sets/updates the AJOCREDIT API's Render env vars. Run: node render-env.mjs
// Reads secrets from ../.env (never committed).
//
// IMPORTANT: Render REPLACES the whole envVars array on PATCH. A naive update that
// only lists the variables it manages silently DELETES every other live variable
// (FLUTTERWAVE_SECRET_KEY, FLW_WEBHOOK_HASH, WHATSAPP_*, REQUIRE_AUTH, ...), which
// would break live payments and auth. So we read the current set first and merge.
import fs from 'fs';
import crypto from 'crypto';
const env = {};
fs.readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n').forEach((l) => {
  const m = l.match(/^\s*([A-Z0-9_]+)=(.*)\s*$/);
  if (m) env[m[1]] = m[2].trim();
});
const KEY = process.env.RENDER_API_KEY;
if (!KEY) { console.error('Set RENDER_API_KEY env first'); process.exit(1); }
const H = { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };
const SERVICE = 'srv-db44g5e0tbcc73d3d7tg';

// Read what is already on the service first - Render replaces the whole array on
// PATCH, so anything we do not carry over is deleted.
const cur = await (await fetch(`https://api.render.com/v1/services/${SERVICE}`, { headers: H })).json();
const existing = cur?.serviceDetails?.envVars || [];
const liveToken = existing.find((e) => e.key === 'AGENT_ADMIN_TOKEN')?.value || '';

// The variables this script owns. Everything else already on the service is preserved.
// Any of them can be overridden from the shell, e.g.
//   $env:REQUIRE_AUTH='1'; $env:APP_UPDATE_ROLLOUT='25'; node render-env.mjs
const managed = {
  USE_EXTERNAL_DB: '1',
  NODE_OPTIONS: '--max-old-space-size=384',
  DATABASE_URL: process.env.NEON_POOLED_URL || env.DATABASE_URL || '',
  PAYSTACK_PUBLIC_KEY: env.PAYSTACK_PUBLIC_KEY,
  PAYSTACK_SECRET_KEY: env.PAYSTACK_SECRET_KEY,
  TERMII_API_KEY: env.TERMII_API_KEY,
  // SMS sender: "OE Alert" until Termii approves the "AJOCREDIT" sender ID.
  TERMII_SENDER_ID: process.env.TERMII_SENDER_ID || 'OE Alert',
  TERMII_CHANNEL: process.env.TERMII_CHANNEL || 'dnd',
  TERMII_OTP_MODE: process.env.TERMII_OTP_MODE || 'auto',
  // Transactional email (welcome + password reset). Skipped when not set locally.
  RESEND_API_KEY: env.RESEND_API_KEY,
  RESEND_FROM: env.RESEND_FROM,
  // Lock the API: 1 = only a signed-in member can call it.
  REQUIRE_AUTH: process.env.REQUIRE_AUTH || '0',
  // Web-bundle rollout: ramp 5 -> 25 -> 50 -> 100. ROLLBACK=1 sends every
  // device back to the last known good bundle.
  APP_UPDATE_ROLLOUT: process.env.APP_UPDATE_ROLLOUT || '5',
  APP_UPDATE_ROLLBACK: process.env.APP_UPDATE_ROLLBACK || '0',
  APP_BUNDLE_MANIFEST: process.env.APP_BUNDLE_MANIFEST || 'https://kingpriest001.github.io/ajocredit-prd/bundle.json',
  // The agent admin panel stays switched off until this is set. If the service
  // does not have one yet we make a long random one and print it, so it can be
  // pasted into the panel's "Admin Key" box.
  AGENT_ADMIN_TOKEN: process.env.AGENT_ADMIN_TOKEN || env.AGENT_ADMIN_TOKEN || liveToken || crypto.randomBytes(24).toString('hex'),
  AGENT_SITE_URL: process.env.AGENT_SITE_URL || 'https://ajocredit.pages.dev',
  PAYMENTS_MODE: 'direct',
};

const merged = [...existing];
for (const [k, v] of Object.entries(managed)) {
  if (!v) { console.warn(`skip ${k} - no value available`); continue; }
  const i = merged.findIndex((e) => e.key === k);
  if (i >= 0) merged[i] = { key: k, value: v };
  else merged.push({ key: k, value: v });
}
console.log(`env vars: ${existing.length} -> ${merged.length}`);
console.log('keys now on the service:', merged.map((e) => e.key).join(', '));
console.log('');
console.log('=== AGENT ADMIN KEY ===');
console.log('Paste this into the "Admin Key" box on https://ajocredit.pages.dev/admin/agents.html');
console.log(managed.AGENT_ADMIN_TOKEN);
console.log('=======================');
const r = await fetch(`https://api.render.com/v1/services/${SERVICE}`, {
  method: 'PATCH', headers: H, body: JSON.stringify({ serviceDetails: { envVars: merged } }),
});
console.log('STATUS:', r.status);
console.log((await r.text()).slice(0, 300));
