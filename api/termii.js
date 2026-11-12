// api/termii.js — Termii client for AJOCREDIT.
//   sendSms()      — raw SMS (notifications, welcome, password reset)
//   generateOtp()  — Termii In-App Token: Termii generates the code, we get pin_id
//   verifyOtp()    — Termii Verify API: authoritative check of a code we sent
//
// Every credential comes from the environment; nothing is hardcoded here. The OTP
// is never written to the console and never returned to the caller as a log line.
const crypto = require('crypto');
const DEFAULT_BASE = 'https://v4.api.termii.com';

function cfg() {
  return {
    base: (process.env.TERMII_BASE_URL || DEFAULT_BASE).replace(/\/$/, ''),
    key: process.env.TERMII_API_KEY,
    from: process.env.TERMII_SENDER_ID || 'Ajocredit',
  };
}

// True when Termii is usable. Never throws, never logs the key.
function configured() {
  const { key } = cfg();
  return !!key && key !== 'REPLACE_ME' && key !== 'xxx';
}

async function post(path, body) {
  const { base } = cfg();
  const r = await fetch(base + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const body2 = await r.json().catch(() => ({}));
  return { status: r.status, ok: r.ok, body: body2 || {} };
}

// Raw SMS. Returns { delivered, detail }. A send is only "delivered" when Termii
// accepted it (message_id present, no error text) - a rejected send must never be
// reported as success, that is how users get silently locked out.
async function sendSms(phone, text) {
  const { key, from } = cfg();
  if (!configured()) return { delivered: false, detail: 'termii key not configured' };
  try {
    const r = await post('/api/sms/send', {
      api_key: key,
      to: String(phone).replace(/^\+/, ''),
      from,
      sms: String(text),
      type: 'plain',
      channel: 'generic',
    });
    const b = r.body || {};
    const delivered = r.ok && !!b.message_id && !/NOT_APPROVED|Validation|error/i.test(String(b.message || ''));
    return { delivered, detail: b.message_id ? 'ok' : (b.message || b.error || `http ${r.status}`) };
  } catch (e) {
    return { delivered: false, detail: e.message };
  }
}

// Which OTP source to use.
//   'termii' (default) — Termii generates the code and its Verify API validates it.
//                        Needs the OTP/Verify product active on the Termii account.
//   'local'            — we generate the 6-digit code ourselves and validate it
//                        against the salted hash we store in the database. Used when
//                        the Termii OTP product is unavailable ("Country Inactive").
//                        Delivery still goes over Termii SMS, so an approved sender
//                        ID is required either way.
function otpMode() {
  const m = String(process.env.TERMII_OTP_MODE || 'termii').toLowerCase();
  return m === 'local' ? 'local' : 'termii';
}

// Termii In-App Token. Termii generates the numeric code and keeps it; we get the
// pin_id so we can later validate the code through the Verify API. The plaintext
// code is returned to the caller only so it can be put into the message - it must
// not be stored or logged.
async function generateOtp(phoneDigits, opts) {
  const o = opts || {};
  const { key } = cfg();
  if (otpMode() === 'local') {
    // Local mode: a cryptographically random 6-digit code. It is hashed before it
    // is stored, so the plain code only ever exists in this request's memory.
    const otp = String(crypto.randomInt(100000, 1000000));
    return { ok: true, otp, pinId: null, detail: 'local' };
  }
  if (!configured()) return { ok: false, detail: 'termii key not configured' };
  try {
    const r = await post('/api/sms/otp/generate', {
      api_key: key,
      pin_type: 'NUMERIC',
      phone_number: String(phoneDigits).replace(/^\+/, ''),
      pin_attempts: o.attempts || 3,
      pin_time_to_live: o.ttlMinutes || 5,
      pin_length: o.length || 6,
    });
    const b = r.body || {};
    const otp = b.otp ? String(b.otp) : null;
    if (r.ok && otp && b.pin_id) return { ok: true, otp, pinId: String(b.pin_id), detail: 'ok' };
    return { ok: false, detail: (b.message || b.error || `http ${r.status}`) };
  } catch (e) {
    return { ok: false, detail: e.message };
  }
}

// Termii Verify API - the authoritative check on a code the member received.
async function verifyOtp(pinId, pin) {
  const { key } = cfg();
  if (otpMode() === 'local') return { ok: true, detail: 'local mode' };
  if (!configured()) return { ok: false, detail: 'termii key not configured' };
  try {
    const r = await post('/api/sms/otp/verify', {
      // The live Termii API wants the token reference as "pinId" (camelCase) even
      // though the docs say "pin_id" - sending only pin_id comes back "Pin ID is
      // required". We send both; Termii ignores the extra key.
      api_key: key,
      pinId: String(pinId),
      pin_id: String(pinId),
      pin: String(pin),
    });
    const b = r.body || {};
    // Termii answers { verified: true } on success and { error: true, message } on failure.
    if (b.verified === true) return { ok: true, detail: 'verified' };
    if (b.error === true || (typeof b.error === 'string' && b.error)) {
      return { ok: false, detail: b.message || b.error || `http ${r.status}` };
    }
    const blob = `${b.status || ''} ${b.message || ''} ${b.error || ''}`.toLowerCase();
    const rejected = /invalid|incorrect|expired|wrong|not found|not_found|failed|error|unauthorized|already been verified/.test(blob);
    return { ok: !!r.ok && !rejected, detail: b.message || b.status || b.error || `http ${r.status}` };
  } catch (e) {
    return { ok: false, detail: e.message };
  }
}

module.exports = { sendSms, generateOtp, verifyOtp, configured, otpMode, senderId: () => cfg().from };
