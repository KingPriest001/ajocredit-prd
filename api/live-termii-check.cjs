// Validate api/termii.js against the REAL Termii API (live key from .env).
// No SMS is sent: this exercises generateOtp() + verifyOtp() only.
const path = require('path');
require('fs').readFileSync(path.join(__dirname, '..', '.env'), 'utf8').split('\n').forEach((l) => {
  const m = l.match(/^\s*([A-Z0-9_]+)=(.*)\s*$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
});
const termii = require(path.join(__dirname, 'termii.js'));

let pass = 0, fail = 0;
const ok = (n, c, extra) => { c ? (pass++, console.log('PASS ' + n + (extra ? ' :: ' + extra : ''))) : (fail++, console.log('FAIL ' + n + (extra ? ' :: ' + extra : ''))); };

(async () => {
  ok('module reports Termii configured', termii.configured());
  ok('sender id is what we expect', termii.senderId() === 'Ajocredit', termii.senderId());

  // 1. generate a real code
  const g = await termii.generateOtp('2348030000001', { length: 6, ttlMinutes: 5, attempts: 3 });
  ok('generateOtp -> ok', g.ok, g.detail);
  ok('generateOtp -> 6-digit otp', !!g.otp && /^\d{6}$/.test(g.otp));
  ok('generateOtp -> pinId returned', !!g.pinId);

  if (!g.ok) { console.log('\nRESULT ' + pass + ' passed, ' + fail + ' failed'); process.exit(1); }

  // 2. wrong pin must be rejected
  const bad = await termii.verifyOtp(g.pinId, '000000');
  ok('verifyOtp wrong pin -> rejected', !bad.ok, bad.detail);

  // 3. correct pin must be accepted (real Termii)
  const good = await termii.verifyOtp(g.pinId, g.otp);
  ok('verifyOtp correct pin -> verified', good.ok, good.detail);

  // 4. reuse of a consumed token must be rejected
  const again = await termii.verifyOtp(g.pinId, g.otp);
  ok('verifyOtp reuse -> rejected', !again.ok, again.detail);

  console.log('\nRESULT ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
