(async () => {
  const b = 'http://localhost:4000';
  const j = async (m, p, body) => (await fetch(b + p, { method: m, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })).json();
  console.log('BAD-NAME:', JSON.stringify(await j('POST', '/api/groups', { name: 'AB', amount: 5000, admin_phone: '08031234567', admin_name: 'T' })));
  console.log('BAD-PHONE:', JSON.stringify(await j('POST', '/api/groups', { name: 'Valid Name', amount: 5000, admin_phone: '123', admin_name: 'Tunde' })));
  const g = await j('POST', '/api/groups', { name: 'E2E Test Group', amount: 5000, size: 10, frequency: 'Weekly', payout_mode: 'random', admin_phone: '08031234567', admin_name: 'E2E Admin' });
  console.log('CREATE:', g.invite_code, g.group_id);
  const jn = await j('POST', `/api/groups/${g.group_id}/join`, { phone: '08039876543', name: 'E2E Joiner' });
  console.log('JOIN:', JSON.stringify(jn));
  const rq = await j('GET', `/api/groups/${g.group_id}/requests?admin_phone=08031234567`);
  console.log('REQUESTS:', JSON.stringify(rq).slice(0, 160));
  const mid = rq[0].id;
  console.log('APPROVE:', JSON.stringify(await j('POST', `/api/memberships/${mid}/decision`, { admin_phone: '08031234567', decision: 'approve' })));
  console.log('NONADMIN:', JSON.stringify(await j('GET', `/api/groups/${g.group_id}/requests?admin_phone=08039876543`)));
})().catch((e) => console.log('E2E-FAIL:', e.message));
