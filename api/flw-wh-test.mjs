(async () => {
  const b = 'http://localhost:4000';
  const evt = { status: 'successful', data: { tx_ref: 'AJO-WH-TEST-1', status: 'successful', meta: { group_id: 'g-aj4821', membership_id: 'm-bola', cycle_id: 'c-aj4821-1', pot: 5000, fee: 75 } } };
  const good = await (await fetch(b + '/webhooks/flutterwave', { method: 'POST', headers: { 'Content-Type': 'application/json', 'verif-hash': 'dc64d608867ac894e8391705a66bfaeb1f42a7e8fd15aa6d' }, body: JSON.stringify(evt) })).json();
  console.log('GOOD-HASH:', JSON.stringify(good));
  const bad = await fetch(b + '/webhooks/flutterwave', { method: 'POST', headers: { 'Content-Type': 'application/json', 'verif-hash': 'wrong' }, body: JSON.stringify(evt) });
  console.log('BAD-HASH:', bad.status);
  const st = await (await fetch(b + '/api/payments/status/AJO-WH-TEST-1')).json();
  console.log('STATUS-POST:', JSON.stringify(st));
})();
