import fs from 'fs';
const env = {};
fs.readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n').forEach((l) => {
  const m = l.match(/^\s*([A-Z0-9_]+)=(.*)\s*$/);
  if (m) env[m[1]] = m[2].trim();
});
const H = { Authorization: `Bearer ${env.FLUTTERWAVE_SECRET_KEY}`, 'Content-Type': 'application/json' };
const banks = await (await fetch('https://api.flutterwave.com/v3/banks/NG', { headers: H })).json();
console.log('BANKS:', Array.isArray(banks.data) ? `${banks.data.length} banks` : JSON.stringify(banks).slice(0, 200));
const opay = (banks.data || []).find((b) => /opay/i.test(b.name));
console.log('OPAY:', opay ? `${opay.name} code=${opay.code}` : 'not found');
if (opay) {
  const r = await (await fetch('https://api.flutterwave.com/v3/accounts/resolve', {
    method: 'POST', headers: H, body: JSON.stringify({ account_number: '8060247444', account_bank: opay.code }),
  })).json();
  console.log('RESOLVE:', JSON.stringify(r).slice(0, 200));
}
