(async () => {
  const send = await fetch('http://localhost:4000/api/otp/send', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone: '2349073892436' }) });
  console.log('SEND:', await send.text());
})();
