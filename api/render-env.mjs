import fs from 'fs';
const env = {};
fs.readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n').forEach((l) => {
  const m = l.match(/^\s*([A-Z0-9_]+)=(.*)\s*$/);
  if (m) env[m[1]] = m[2].trim();
});
const vars = [
  ['USE_EXTERNAL_DB', '1'],
  ['NODE_OPTIONS', '--max-old-space-size=384'],
  ['DATABASE_URL', 'postgresql://neondb_owner:npg_YxzUFv73HBOK@ep-crimson-pine-b79z8eyt-pooler.c-13.us-east-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require'],
  ['PAYSTACK_PUBLIC_KEY', env.PAYSTACK_PUBLIC_KEY],
  ['PAYSTACK_SECRET_KEY', env.PAYSTACK_SECRET_KEY],
  ['TERMII_API_KEY', env.TERMII_API_KEY],
  ['PAYMENTS_MODE', 'direct'],
].map(([key, value]) => ({ key, value }));
const r = await fetch('https://api.render.com/v1/services/srv-db44g5e0tbcc73d3d7tg', {
  method: 'PATCH',
  headers: { Authorization: `Bearer ${process.env.RENDER_API_KEY}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ serviceDetails: { envVars: vars } }),
});
console.log('STATUS:', r.status);
const t = await r.text();
console.log(t.slice(0, 200));
