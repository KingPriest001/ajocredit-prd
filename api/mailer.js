// api/mailer.js — transactional email for AJOCREDIT.
//
// Scope (MVP): a welcome email after a verified sign-up, and a password-reset
// notice. Nothing else.
//
// Delivery uses Resend when RESEND_API_KEY and RESEND_FROM are set in the
// environment. There is no email provider configured on the account today, so
// until one is, every message is recorded in the email_log table and reported as
// "not configured" - the app keeps working and nothing is silently dropped.
//
// Rules: never throws, never logs an API key, never emails or logs an OTP code
// (the code goes to the member by SMS, which is the strong factor).
const RESEND_URL = 'https://api.resend.com/emails';

function cfg() {
  return {
    key: process.env.RESEND_API_KEY,
    from: process.env.RESEND_FROM,
  };
}

// True when a real email provider is configured.
function configured() {
  const { key, from } = cfg();
  return !!key && key !== 'REPLACE_ME' && !!from;
}

async function post(url, headers, body) {
  const r = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, ok: r.ok, body: j || {} };
}

// Send one email. `record` is a callback the API passes in so an undelivered
// message can be written to email_log without this module needing the database.
async function sendEmail({ to, subject, text, html, kind, record }) {
  if (!to) return { sent: false, detail: 'no email address on file' };
  const { key, from } = cfg();
  if (!configured()) {
    if (record) await record({ to, kind: kind || 'general', subject, body: text, status: 'not_configured', detail: 'RESEND_API_KEY / RESEND_FROM not set' });
    return { sent: false, detail: 'email provider not configured' };
  }
  try {
    const r = await post(RESEND_URL, { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      { from, to: [to], subject, text, html: html || text });
    if (r.ok) {
      if (record) await record({ to, kind: kind || 'general', subject, body: text, status: 'sent', detail: r.body && r.body.id ? r.body.id : '' });
      return { sent: true, detail: 'sent' };
    }
    const detail = (r.body && (r.body.message || r.body.error)) || `http ${r.status}`;
    if (record) await record({ to, kind: kind || 'general', subject, body: text, status: 'failed', detail });
    return { sent: false, detail };
  } catch (e) {
    if (record) await record({ to, kind: kind || 'general', subject, body: text, status: 'failed', detail: e.message });
    return { sent: false, detail: e.message };
  }
}

function greeting(name) {
  return name ? `Hi ${String(name).split(' ')[0]},` : 'Hi,';
}

// Welcome email, sent once, right after a member's phone is verified and their
// account is created.
function welcomeEmail({ name, email, ajocreditId, record }) {
  const subject = 'Welcome to AJOCREDIT';
  const text = [
    `${greeting(name)}`,
    '',
    'Your AJOCREDIT account is ready.',
    '',
    `Your AJOCREDIT ID: ${ajocreditId || '—'}`,
    'Your score starts at 250 (Bronze). Pay your contributions on time and it grows.',
    '',
    'Open the app to create a group or join one with an invite code.',
    '',
    'Ajocredit is a product of Zenonmag Concepts Ventures.',
    'Contact: Plot 79, Apo Resettlement Zone A, Abuja, ajocredit.app@gmail.com, +234 907 3892 436',
  ].join('\n');
  return sendEmail({ to: email, subject, text, kind: 'welcome', record });
}

// Password-reset notice. The reset code is NOT included - it goes to the member
// by SMS on their phone number. This email only tells them the request happened
// and how to get help if it wasn't them.
function passwordResetEmail({ name, email, phone, record }) {
  const subject = 'AJOCREDIT access reset requested';
  const masked = phone ? String(phone).replace(/^(?=\+?234.{4}).+(?=.{2})$/, '$1****') : 'your number';
  const text = [
    `${greeting(name)}`,
    '',
    'We received a request to reset access to your AJOCREDIT account.',
    `A 6-digit code was sent by SMS to ${masked}. Enter it in the app to set a new password.`,
    '',
    "If this wasn't you, ignore this email and contact us - we will check your account.",
    '',
    'Ajocredit is a product of Zenonmag Concepts Ventures.',
    'Contact: Plot 79, Apo Resettlement Zone A, Abuja, ajocredit.app@gmail.com, +234 907 3892 436',
  ].join('\n');
  return sendEmail({ to: email, subject, text, kind: 'password_reset', record });
}

module.exports = { sendEmail, welcomeEmail, passwordResetEmail, configured };
