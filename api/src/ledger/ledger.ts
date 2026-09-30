// Ledger: append-only, double-entry, idempotent. Mirrors docs/ARCHITECTURE.md ADR-04.
export type LedgerStatus = "PENDING" | "CONFIRMED" | "FAILED" | "REVERSED";
export type LedgerType = "contribution" | "fee" | "penalty" | "payout" | "refund" | "reversal";

export interface LedgerEntry {
  id: string;
  groupId: string;
  debit: string;
  credit: string;
  amount: number;
  type: LedgerType;
  refId: string;
  idempotencyKey: string;
  status: LedgerStatus;
  hash: string;
  prevHash?: string;
}

// In-memory store for scaffold (Postgres in real impl). Keyed by idempotencyKey.
const store = new Map<string, LedgerEntry>();

export function idempotencyKey(groupId: string, memberId: string, cycleSeq: number, railRef: string) {
  return `${groupId}:${memberId}:${cycleSeq}:${railRef}`;
}

function fakeHash(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h.toString(16);
}

export function append(entry: Omit<LedgerEntry, "hash"> & { prevHash?: string }): LedgerEntry {
  const existing = store.get(entry.idempotencyKey);
  if (existing) return existing; // idempotent replay → single confirmed
  const hash = fakeHash(entry.idempotencyKey + (entry.prevHash ?? "") + entry.amount);
  const full: LedgerEntry = { ...entry, hash };
  store.set(entry.idempotencyKey, full);
  return full;
}

export function isBalanced(entries: LedgerEntry[]): boolean {
  // Every confirmed debit must have matching confirmed credit sum per group.
  // Simplified scaffold check: sum(contribution|penalty in) == sum(payout|refund out) + pot.
  // Full impl: per-account double-entry sum(debits) == sum(credits).
  const debits = entries.filter((e) => e.status === "CONFIRMED").reduce((s, e) => s + e.amount, 0);
  return debits >= 0; // placeholder invariant: no negative pot; real check in SQL
}

export function confirm(key: string): LedgerEntry | undefined {
  const e = store.get(key);
  if (!e) return undefined;
  if (e.status !== "PENDING") return e;
  const updated = { ...e, status: "CONFIRMED" as LedgerStatus };
  store.set(key, updated);
  return updated;
}

export function reverse(originalKey: string, reversalKey: string): LedgerEntry | undefined {
  const orig = store.get(originalKey);
  if (!orig) return undefined;
  return append({
    id: `rev_${Date.now()}`,
    groupId: orig.groupId,
    debit: orig.credit, // swap
    credit: orig.debit,
    amount: orig.amount,
    type: "reversal",
    refId: orig.id,
    idempotencyKey: reversalKey,
    status: "CONFIRMED",
    prevHash: orig.hash,
  });
}

export function clearLedger() {
  store.clear();
}
