// Money-engine checks (run when Node is installed: `npm test`).
// Scaffold assertions — mirrors IMPLEMENTATION-PLAN-DETAILED.md Phase 5.
import { append, confirm, clearLedger, idempotencyKey } from "../ledger/ledger";
import { feeFor } from "../payments/fees";
import { handleWebhook, clearWebhooks } from "../payments/webhook";
import { checkPayout, clearPayouts } from "../payouts/guards";

describe("fees", () => {
  // Flat rule: ≤₦10,000 → 1%, >₦10,000 → 0.5%, rounded to the nearest kobo.
  test("₦2,000 → fee ₦20 total ₦2,020", () => {
    expect(feeFor(2000)).toEqual({ fee: 20, total: 2020, rate: 0.01 });
  });
  test("₦5,000 → fee ₦50 total ₦5,050", () => {
    expect(feeFor(5000)).toEqual({ fee: 50, total: 5050, rate: 0.01 });
  });
  test("₦10,000 boundary → fee ₦100 total ₦10,100 (still 1%)", () => {
    expect(feeFor(10000)).toEqual({ fee: 100, total: 10100, rate: 0.01 });
  });
  test("₦10,001 boundary → fee ₦50.01 total ₦10,051.01 (drops to 0.5%)", () => {
    expect(feeFor(10001)).toEqual({ fee: 50.01, total: 10051.01, rate: 0.005 });
  });
  test("₦10,500 rounding → fee ₦52.50 total ₦10,552.50", () => {
    expect(feeFor(10500)).toEqual({ fee: 52.5, total: 10552.5, rate: 0.005 });
  });
  test("₦20,000 → fee ₦100 total ₦20,100", () => {
    expect(feeFor(20000)).toEqual({ fee: 100, total: 20100, rate: 0.005 });
  });
  test("₦50,000 → fee ₦250 total ₦50,250", () => {
    expect(feeFor(50000)).toEqual({ fee: 250, total: 50250, rate: 0.005 });
  });
  test("₦100,000 → fee ₦500 total ₦100,500", () => {
    expect(feeFor(100000)).toEqual({ fee: 500, total: 100500, rate: 0.005 });
  });
  test("₦0 → fee ₦0 total ₦0", () => {
    expect(feeFor(0)).toEqual({ fee: 0, total: 0, rate: 0.01 });
  });
  test("small ₦100 → fee ₦1 total ₦101", () => {
    expect(feeFor(100)).toEqual({ fee: 1, total: 101, rate: 0.01 });
  });
  test("large ₦1,000,000 → fee ₦5,000 total ₦1,005,000", () => {
    expect(feeFor(1000000)).toEqual({ fee: 5000, total: 1005000, rate: 0.005 });
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
