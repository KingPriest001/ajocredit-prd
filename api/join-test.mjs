(async () => {
  const b = 'http://localhost:4000';
  const j = async (m, p, body) => (await fetch(b + p, { method: m, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })).json();
  console.log('LOOKUP:', JSON.stringify(await j('GET', '/api/groups/by-code/AJ-4821')).slice(0, 160));
  console.log('JOIN:', JSON.stringify(await j('POST', '/api/groups/g-aj4821/join', { phone: '+2348090000001', name: 'Join Test' })));
  console.log('JOIN-DUP:', JSON.stringify(await j('POST', '/api/groups/g-aj4821/join', { phone: '+2348090000001', name: 'Join Test' })));
})();
