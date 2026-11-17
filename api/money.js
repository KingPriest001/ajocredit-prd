// AJOCREDIT - money routing.
//
// Two streams of money that must NEVER mix:
//
//   CONTRIBUTION  the member's contribution  ->  the group's pool account
//   FEE           the contribution fee       ->  the AJOCREDIT company account
//
// Everything that moves money goes through here. The rules are:
//
//   * A fee never goes to a group pool and a contribution never goes to the
//     company account. assertNoMixing() checks this on every payment.
//   * The ledger always books the two legs separately, whatever happens at the
//     gateway.
//   * If a split was attempted and the gateway refused it, the whole payment
//     fails and the contribution is NOT marked paid. We never take money and
//     then lose track of where it went.
//   * Splitting is opt-in per group. A group with no verified pool subaccount
//     keeps today's behaviour: the gateway holds the money (custody mode) and
//     the ledger splits it. Nothing changes for a group that has not been set
//     up deliberately.

const crypto = require('crypto');

// The fee rates the app charges. The percentage split is built from the real
// fee/total (splitShares), so these tiers exist only to label a payment's
// ratio for Paystack split reuse - they must mirror feeFor() exactly.
const FEE_TIERS = [
  { max: 10000, rate: 0.01 },
  { max: Infinity, rate: 0.005 },
];

function feeTierIndex(rate) {
  for (let i = 0; i < FEE_TIERS.length; i++) if (FEE_TIERS[i].rate === rate) return i;
  return FEE_TIERS.length - 1;
}

// Which tier an amount falls in. It must match the app's feeFor() exactly:
// up to and including 10,000 -> 1%, above 10,000 -> 0.5%.
function tierIndexForAmount(amount) {
  const a = Number(amount) || 0;
  if (a <= 10000) return 0;
  return 1;
}

// The percentage split between the group pool and the company, from the real
// amounts. Both shares always add up to 100.
function splitShares(amount, fee) {
  const total = Number(amount) + Number(fee);
  if (!total) return { groupShare: 100, companyShare: 0 };
  const company = (Number(fee) / total) * 100;
  return {
    groupShare: Number((100 - company).toFixed(4)),
    companyShare: Number(company.toFixed(4)),
  };
}

// A short, human-readable label for where money went. This is what the
// transactions table stores, so an admin can read it without a lookup.
function destinationLabel(kind, account) {
  if (!account) return kind === 'fee' ? 'company:unconfigured' : 'pool:unconfigured';
  const bank = account.bank_name || account.bank_code || 'bank';
  const acct = account.account_number ? '••' + String(account.account_number).slice(-4) : '••••';
  return `${kind}:${bank}/${acct}`;
}

// The two destinations for one payment. Returns null when the money cannot be
// routed safely - in that case the caller must not take the payment.
async function destinations(ctx, groupId) {
  const { q } = ctx;
  const company = await q("SELECT * FROM company_account WHERE id='main'");
  const pool = groupId ? await q('SELECT * FROM group_pools WHERE group_id=$1', [groupId]) : [];
  return {
    company: company.length ? company[0] : null,
    pool: pool.length ? pool[0] : null,
  };
}

// Decide how this payment is split.
//
//   split     both destinations have a verified subaccount on the gateway -
//             the payment itself is split, so the money lands in two places
//   two_step  the gateway cannot split inline but both destinations can be
//             reached by transfer - charge the total, then move each leg
//   custody   nothing is configured - the gateway holds the money (today's
//             behaviour) and the ledger splits it. Safe, and the default.
async function plan(ctx, opts) {
  const { groupId, amount, fee, gateway } = opts;
  const { company, pool } = await destinations(ctx, groupId);
  const shares = splitShares(amount, fee);

  const companySub = company ? (gateway === 'paystack' ? company.paystack_subaccount_code : company.flutterwave_subaccount_id) : null;
  const poolSub = pool ? (gateway === 'paystack' ? pool.paystack_subaccount_code : pool.flutterwave_subaccount_id) : null;

  const base = {
    gateway,
    amount: Number(amount) || 0,
    fee: Number(fee) || 0,
    total: (Number(amount) || 0) + (Number(fee) || 0),
    groupShare: shares.groupShare,
    companyShare: shares.companyShare,
    company: company ? {
      id: company.id,
      bank_name: company.bank_name,
      account_number: company.account_number,
      account_name: company.account_name,
      bank_code: company.bank_code,
      subaccount: companySub,
      label: destinationLabel('company', company),
    } : null,
    pool: pool ? {
      group_id: pool.group_id,
      bank_name: pool.bank_name,
      account_number: pool.account_number,
      account_name: pool.account_name,
      bank_code: pool.bank_code,
      subaccount: poolSub,
      label: destinationLabel('pool', pool),
    } : null,
  };

  if (company && pool && companySub && poolSub && pool.split_enabled) {
    return Object.assign(base, { mode: 'split', reason: 'both destinations have a verified subaccount' });
  }
  if (company && pool && company.transfer_enabled && pool.transfer_enabled) {
    return Object.assign(base, { mode: 'two_step', reason: 'no subaccounts - the fee is transferred after the charge' });
  }
  return Object.assign(base, {
    mode: 'custody',
    reason: 'no split configured for this group - the gateway holds the money and the ledger splits it',
  });
}

// The safety rail. Throws if the two legs could ever end up in the same place.
function assertNoMixing(p) {
  if (!p) throw new Error('no money routing plan');
  if (p.mode === 'custody') return true;
  if (!p.company || !p.pool) throw new Error('a split needs both a company account and a group pool');
  if (!p.company.account_number || !p.pool.account_number) throw new Error('a split needs both account numbers');
  if (String(p.company.account_number) === String(p.pool.account_number)) {
    throw new Error('the company account and the group pool are the same account - refusing to split');
  }
  if (p.company.subaccount && p.pool.subaccount && p.company.subaccount === p.pool.subaccount) {
    throw new Error('the company and the group pool use the same gateway subaccount - refusing to split');
  }
  const sum = Number(p.groupShare) + Number(p.companyShare);
  if (Math.abs(sum - 100) > 0.01) throw new Error('the split shares do not add up to 100');
  return true;
}

// The Paystack pieces. A Paystack split is created once per (group, fee tier)
// and reused for every payment in that tier.
function paystackSplitName(groupId, tierIndex) {
  return `AJOCREDIT pool ${groupId} tier ${tierIndex + 1}`;
}

function paystackSubaccounts(p) {
  // The settlement account comes first, then the beneficiaries.
  const out = [{ subaccount_code: p.company.subaccount, share: p.companyShare }];
  if (p.pool.subaccount) out.push({ subaccount_code: p.pool.subaccount, share: p.groupShare });
  return out;
}

// What to put on a Paystack transaction init.
function paystackInit(p, splitCode) {
  if (p.mode !== 'split' || !splitCode) return null;
  return { split_code: splitCode, subaccount: p.company.subaccount };
}

// What to put on a Flutterwave payment init.
function flutterwaveInit(p) {
  if (p.mode !== 'split') return null;
  const out = [];
  if (p.company.subaccount) out.push({ id: Number(p.company.subaccount), type: 'account', share: p.companyShare });
  if (p.pool.subaccount) out.push({ id: Number(p.pool.subaccount), type: 'account', share: p.groupShare });
  if (!out.length) return null;
  return { subaccounts: out };
}

// ------------------------------------------------------------------ ledger --
// The transactions table: one row per payment, showing exactly where each
// naira went. This is the reconciliation sheet.
async function recordTransaction(ctx, row) {
  const { q } = ctx;
  const id = row.id || `tx-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  await q(
    `INSERT INTO transactions (id, transaction_id, group_id, member_id, contribution_amount, fee_amount,
       total_amount, contribution_destination, fee_destination, gateway, mode, status, reference, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,NOW())`,
    [
      id, row.transaction_id || null, row.group_id || null, row.member_id || null,
      Number(row.contribution_amount) || 0, Number(row.fee_amount) || 0,
      Number(row.total_amount) || 0,
      row.contribution_destination || null, row.fee_destination || null,
      row.gateway || null, row.mode || null, row.status || 'PENDING',
      row.reference || null,
    ]
  );
  return id;
}

module.exports = {
  FEE_TIERS, feeTierIndex, tierIndexForAmount, splitShares, destinationLabel,
  destinations, plan, assertNoMixing,
  paystackSplitName, paystackSubaccounts, paystackInit, flutterwaveInit,
  recordTransaction,
};
