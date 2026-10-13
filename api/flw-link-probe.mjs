import fs from 'fs';
const env = {};
fs.readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n').forEach((l) => {
  const m = l.match(/^\s*([A-Z0-9_]+)=(.*)\s*$/);
  if (m) env[m[1]] = m[2].trim();
});
const H = { Authorization: `Bearer ${env.FLUTTERWAVE_SECRET_KEY}`, 'Content-Type': 'application/json' };
for (const u of ['https://api.flutterwave.com/v3/payment-links', 'https://api.flutterwave.com/v3/payments']) {
  try {
    const r = await fetch(u, { method: 'POST', headers: H, body: JSON.stringify({ tx_ref: 'PROBE-1', amount: 100, currency: 'NGN', redirect_url: 'https://example.com', customer: { email: 't@t.ng' } }) });
    const t = await r.text();
    console.log(r.status, u, '->', t.slice(0, 200));
  } catch (e) { console.log('ERR', u, e.message); }
}
