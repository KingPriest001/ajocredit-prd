import fs from 'fs';
const env = {};
fs.readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n').forEach((l) => {
  const m = l.match(/^\s*([A-Z0-9_]+)=(.*)\s*$/);
  if (m) env[m[1]] = m[2].trim();
});
const H = { Authorization: `Bearer ${env.FLUTTERWAVE_SECRET_KEY}`, 'Content-Type': 'application/json' };
for (const [acct, bank, label] of [['0690000032', '044', 'test-access'], ['8060247444', '100004', 'real-opay']]) {
  const r = await (await fetch('https://api.flutterwave.com/v3/accounts/resolve', {
    method: 'POST', headers: H, body: JSON.stringify({ account_number: acct, account_bank: bank }),
  })).json();
  console.log(label, '->', JSON.stringify(r).slice(0, 160));
}
