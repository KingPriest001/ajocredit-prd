const r = await fetch('https://api.render.com/v1/services/srv-db44g5e0tbcc73d3d7tg/events?limit=8', { headers: { Authorization: 'Bearer rnd_nlTyt9tXgbTN0qttHVMAoU6LuWQ5' } });
const j = await r.json();
j.forEach((e) => console.log(e.event.timestamp, '|', e.event.type, '|', JSON.stringify(e.event.details).slice(0, 200)));
