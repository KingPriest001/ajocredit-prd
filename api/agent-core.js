// AJOCREDIT Agent Module
//
// Agents bring Ajo groups to AJOCREDIT and earn a commission. An agent is ALSO
// a member - same phone, same login - they just have an agent record next to
// their user record.
//
// Rules that are not negotiable (see the Agent Code of Conduct):
//   * An agent NEVER collects cash. The API never exposes a way to take money
//     from a member; money only moves through the normal contribution routes.
//   * An agent NEVER sees a member's wallet balance. The agent endpoints
//     return counts, group names and commission totals - never balances.
//   * A corporate agent cannot open the dashboard until an admin approves it.
//
// Commission:
//   * N500 "signup" commission, created when a member joins through an agent
//     link. It stays PENDING until that member makes their first contribution,
//     then it is released (EARNED).
//   * 1% of that member's FIRST contribution, and nothing after that.
//
// WHY ONLY THE FIRST CONTRIBUTION: AJOCREDIT collects an average fee of about
// 1% on every contribution (1.5% under N10,000, 1% between N10,000 and
// N100,000, 0.75% above). A percentage that kept running for 12 months would
// hand the agent the whole fee and leave AJOCREDIT nothing, so the percentage
// is a one-time bonus on the first contribution and the N500 is the standing
// reward for bringing an active member.

const crypto = require('crypto');

// Agent code prefixes. Individual = ZEN-AG-####, corporate = ZEN-CORP-####.
const IND_PREFIX = 'ZEN-AG';
const CORP_PREFIX = 'ZEN-CORP';

const SIGNUP_COMMISSION = 500;
const FIRST_CONTRIBUTION_RATE = 0.01;
const SUB_AGENT_RATE = 0.005;

const STATUS = {
  ACTIVE: 'ACTIVE',
  PENDING: 'PENDING',
  NEEDS_INFO: 'NEEDS_INFO',
  REJECTED: 'REJECTED',
  SUSPENDED: 'SUSPENDED',
};

// Agent statuses that may open the dashboard.
const CAN_WORK = [STATUS.ACTIVE];

function isAgentType(t) {
  return t === 'individual' || t === 'corporate';
}

// The agent code is shown to members on the join page, so it must be
// unguessable enough not to be brute-forced, but short enough to read aloud
// on the phone. We use 4 digits from a 10-digit alphabet (no 0/O confusion
// handled by using digits only) plus a checksum character.
function agentCodeFor(type) {
  const prefix = type === 'corporate' ? CORP_PREFIX : IND_PREFIX;
  const body = crypto.randomInt(0, 10000).toString().padStart(4, '0');
  return `${prefix}-${body}`;
}

function normaliseCode(code) {
  return String(code || '').trim().toUpperCase().replace(/\s+/g, '');
}

// Accept "ZEN-AG-4821", "zen ag 4821", "ZENAG4821".
function parseCode(code) {
  const c = normaliseCode(code).replace(/^ZEN[- ]?AG[- ]?/i, 'ZEN-AG-').replace(/^ZEN[- ]?CORP[- ]?/i, 'ZEN-CORP-');
  const m = c.match(/^(ZEN-(?:AG|CORP))-?(\d{4})$/);
  if (!m) return null;
  return { prefix: m[1], body: m[2], code: `${m[1]}-${m[2]}` };
}

function agentTypeFromCode(code) {
  const p = parseCode(code);
  if (!p) return null;
  return p.prefix === 'ZEN-CORP' ? 'corporate' : 'individual';
}

function money(n) {
  return Math.round(Number(n) || 0);
}

// What an agent earns, in the words we show to members and agents.
const COMMISSION_EXPLAINER =
  'Every member you refer earns you N500 when they make their first contribution - plus 1% of that first contribution. That is the whole reward: one N500 and one percentage, paid once. You do not earn a percentage on what they contribute later.';

module.exports = {
  STATUS,
  CAN_WORK,
  SIGNUP_COMMISSION,
  FIRST_CONTRIBUTION_RATE,
  SUB_AGENT_RATE,
  IND_PREFIX,
  CORP_PREFIX,
  isAgentType,
  agentCodeFor,
  normaliseCode,
  parseCode,
  agentTypeFromCode,
  money,
  COMMISSION_EXPLAINER,
};
