// Payout guards: quorum + balanced ledger + maker-checker + idempotency.
// Batches 10:00/15:00 WAT. SLA <24h. Shortfall → blocked unless rules allow partial.
export interface PayoutRequest {
  groupId: string;
  cycleId: string;
  beneficiaryId: string;
  amount: number;
  potCollected: number;
  quorumMet: boolean;
  ledgerBalanced: boolean;
  initiatedBy: string;
  approvedBy: string;
  idempotencyKey: string;
}

const usedKeys = new Set<string>();

export function checkPayout(r: PayoutRequest): { ok: boolean; reason?: string } {
  if (usedKeys.has(r.idempotencyKey)) return { ok: false, reason: "duplicate-payout-blocked" };
  if (!r.quorumMet) return { ok: false, reason: "shortfall-quorum-not-met" };
  if (!r.ledgerBalanced) return { ok: false, reason: "ledger-unbalanced" };
  if (r.potCollected < r.amount) return { ok: false, reason: "insufficient-pot" };
  if (r.initiatedBy === r.approvedBy) return { ok: false, reason: "maker-checker-violation" };
  usedKeys.add(r.idempotencyKey);
  return { ok: true };
}

export function clearPayouts() {
  usedKeys.clear();
}
