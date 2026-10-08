(async () => {
  const b = 'http://localhost:4000';
  const j = async (m, p, body) => (await fetch(b + p, { method: m, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })).json();
  console.log('MEMBERS:', JSON.stringify(await j('GET', '/api/groups/g-aj4821/members')).slice(0, 120));
  console.log('APPEAL:', JSON.stringify(await j('POST', '/api/disputes/d-231/appeal')));
  console.log('EXIT:', JSON.stringify(await j('POST', '/api/exits', { group_id: 'g-aj4821', user_id: 'u-bola', kind: 'pre' })));
  console.log('PASSPORT:', JSON.stringify(await j('GET', '/api/passport/AJ-774821')));
})();
