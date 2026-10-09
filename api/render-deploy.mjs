// Creates the ajocredit-api Web Service on Render via REST API. Run: node render-deploy.mjs
// Reads secrets from ../.env (never committed). Safe to re-run: skips if service exists.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const here = path.dirname(fileURLToPath(import.meta.url));
const env = {};
fs.readFileSync(path.join(here, '..', '.env'), 'utf8').split('\n').forEach((l) => {
  const m = l.match(/^\s*([A-Z0-9_]+)=(.*)\s*$/);
  if (m) env[m[1]] = m[2].trim();
});
const RENDER_KEY = process.env.RENDER_API_KEY;
if (!RENDER_KEY) { console.error('Set RENDER_API_KEY env first'); process.exit(1); }
const H = { Authorization: `Bearer ${RENDER_KEY}`, 'Content-Type': 'application/json' };
const NEON_POOLED = 'postgresql://neondb_owner:npg_YxzUFv73HBOK@ep-crimson-pine-b79z8eyt-pooler.c-13.us-east-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require';

const existing = await (await fetch('https://api.render.com/v1/services?type=web_service&limit=20', { headers: H })).json();
const found = (Array.isArray(existing) ? existing : []).find((s) => s?.service?.name === 'ajocredit-api');
if (found) { console.log('EXISTS:', found.service.id, found.service.serviceDetails?.url); process.exit(0); }

const body = {
  type: 'web_service',
  name: 'ajocredit-api',
  ownerId: 'tea-db41622j9qps73fp36dg',
  repo: 'https://github.com/KingPriest001/ajocredit-prd',
  branch: 'main',
  serviceDetails: {
    runtime: 'node',
    region: 'oregon',
    plan: 'free',
    envSpecificDetails: {
      buildCommand: 'cd api && npm install',
      startCommand: 'cd api && node server.js',
    },
    envVars: [
    { key: 'USE_EXTERNAL_DB', value: '1' },
    { key: 'DATABASE_URL', value: NEON_POOLED },
    { key: 'PAYSTACK_PUBLIC_KEY', value: env.PAYSTACK_PUBLIC_KEY },
    { key: 'PAYSTACK_SECRET_KEY', value: env.PAYSTACK_SECRET_KEY },
    { key: 'TERMII_API_KEY', value: env.TERMII_API_KEY },
    { key: 'PAYMENTS_MODE', value: 'direct' },
    ],
  },
};
const r = await fetch('https://api.render.com/v1/services', { method: 'POST', headers: H, body: JSON.stringify(body) });
const j = await r.json();
if (!r.ok) { console.error('CREATE-FAIL:', JSON.stringify(j).slice(0, 500)); process.exit(1); }
console.log('CREATED:', j.service?.id, j.service?.serviceDetails?.url);
