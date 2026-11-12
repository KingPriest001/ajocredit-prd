// config/termii.js - the single place our Termii message wording lives.
//
// The DND route on the Termii account is registered against this exact template.
// Termii and the telcos block any variation of it, so the wording must not be
// reworded - only the one-time code changes.
const OTP_MESSAGE_TEMPLATE =
  'Your ZENONMAG-AJOCREDIT verification code is {otp}. This code expires in 10 minutes. Do not share with anyone.';

// The verification message we send over SMS. `otp` is the 6-digit code.
function buildOtpMessage(otp) {
  return OTP_MESSAGE_TEMPLATE.replace('{otp}', String(otp));
}

module.exports = { buildOtpMessage, OTP_MESSAGE_TEMPLATE };
