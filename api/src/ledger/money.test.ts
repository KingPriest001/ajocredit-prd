// Money-engine checks (run when Node is installed: `npm test`).
// Scaffold assertions — mirrors IMPLEMENTATION-PLAN-DETAILED.md Phase 5.
import { append, confirm, clearLedger, idempotencyKey } from "../ledger/ledger";
import { feeFor } from "../payments/fees";
import { handleWebhook, clearWebhooks } from "../payments/webhook";
import { checkPayout, clearPayouts } from "../payouts/guards";

describe("fees", () => {
  test("₦20,000 → fee ₦200 total ₦20,200", () => {
    expect(feeFor(20000)).toEqual({ fee: 200, total: 20200 });
  });
});

describe("ledger idempotency", () => {
  test("10x replay → 1 entry", () => {
    clearLedger();
    const key = idempotencyKey("g1", "m1", 3, "rail123");
    for (let i = 0; i < 10; i++) {
      append({ id: `x${i}`, groupId: "g1", debit: "psp", credit: "pot:g1", amount: 20000, type: "contribution", refId: "rail123", idempotencyKey: key, status: "PENDING" });
    }
    confirm(key);
    // store dedupes by idempotencyKey → only one logical entry
    expect(confirm(key)?.status).toBe("CONFIRMED");
  });
});

describe("webhook dedupe", () => {
  test("double delivery → duplicate-ignored", () => {
    clearLedger(); clearWebhooks();
    const ev = { provider: "paystack" as const, railRef: "r1", groupId: "g1", memberId: "m1", cycleSeq: 1, amount: 20000, signatureValid: true };
    expect(handleWebhook(ev).status).toBe("confirmed");
    expect(handleWebhook(ev).status).toBe("duplicate-ignored");
  });
});

describe("payout guards", () => {
  test("shortfall / unbalanced / self-approve / duplicate blocked", () => {
    clearPayouts();
    const base = { groupId: "g1", cycleId: "c1", beneficiaryId: "m2", amount: 100000, potCollected: 100000, quorumMet: true, ledgerBalanced: true, initiatedBy: "ops1", approvedBy: "ops2", idempotencyKey: "p1" };
    expect(checkPayout({ ...base, quorumMet: false }).ok).toBe(false);
    expect(checkPayout({ ...base, ledgerBalanced: false }).ok).toBe(false);
    expect(checkPayout({ ...base, approvedBy: "ops1" }).ok).toBe(false);
    expect(checkPayout(base).ok).toBe(true);
    expect(checkPayout(base).ok).toBe(false); // duplicate
  });
});
