import fs from 'fs';
const env = {};
fs.readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n').forEach((l) => {
  const m = l.match(/^\s*([A-Z0-9_]+)=(.*)\s*$/);
  if (m) env[m[1]] = m[2].trim();
});
const base = (env.TERMII_BASE_URL || 'https://v4.api.termii.com').replace(/\/$/, '');
const key = env.TERMII_API_KEY;
const probes = [
  ['GET', '/api/get-balance?api_key=KEY'],
  ['GET', '/api/balance?api_key=KEY'],
  ['GET', '/api/insight/balance?api_key=KEY'],
];
for (const [m, p] of probes) {
  const url = base + p.replace('KEY', key);
  try {
    const r = await fetch(url, { method: m });
    const t = await r.text();
    console.log(r.status, p.split('?')[0], '->', t.slice(0, 160));
    if (r.ok && !t.includes('Not Found')) break;
  } catch (e) { console.log('ERR', p.split('?')[0], e.message); }
}
