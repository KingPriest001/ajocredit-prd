(async () => {
  const r = await fetch('http://localhost:4000/api/groups', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Test Group', amount: 5000, size: 10, frequency: 'Weekly', payout_mode: 'random', admin_phone: '+2348099999999', admin_name: 'Test Admin' }) });
  console.log('CREATE:', await r.text());
})();
