(async () => {
  const b = 'http://localhost:4000';
  const j = async (m, p, body) => (await fetch(b + p, { method: m, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })).json();
  const init = await j('POST', '/api/payments/init', { group_id: 'g-aj4821', membership_id: 'm-bola', cycle_id: 'c-aj4821-1', amount: 5000, email: 'test@ajocredit.ng' });
  console.log('INIT:', init.provider, '| link:', (init.link || '').slice(0, 60), '| ref:', init.reference, '| total:', init.total);
  if (init.link) {
    console.log('STATUS-PRE:', JSON.stringify(await j('GET', `/api/payments/status/${init.reference}`)));
  }
})();
