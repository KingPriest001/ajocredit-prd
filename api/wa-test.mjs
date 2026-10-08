const msg = (text) => ({ entry: [{ changes: [{ value: { messages: [{ from: '2348031', text: { body: text } }] } }] }] });
(async () => {
  for (const t of ['hello', 'when is payout?', 'my score?', 'I want to join', 'talk to human']) {
    const r = await fetch('http://localhost:4000/webhooks/whatsapp', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(msg(t)) });
    const j = await r.json();
    console.log(JSON.stringify(t), '->', j.reply.slice(0, 80));
  }
})();
