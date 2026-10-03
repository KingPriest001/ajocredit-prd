// Score acceptance fixtures — Credit Scoring Methodology v1 (model_version 1.0.0).
// Run when Node installed: `npm test`.
import { scoreBreakdown, creditPower, tierFor as tierForM, MethodologyInputs } from "./methodology";
import { tierFor } from "./trust";
import { fraudBand, passportShareBlocked } from "./fraud";

const ada: MethodologyInputs = {
  onTimePayments: 11, totalDuePayments: 12, recent3OnTime: 3,
  completedCycles: 12, cumulativeNaira: 220000, monthsOnPlatform: 4,
  distinctGroupsCompleted: 1, peerEndorsements: 4,
  phoneVerified: true, dobAdded: true, selfieDone: true, bvnOrNinLinked: false,
  lateCount: 1, openDisputesAgainstUser: 0, defaults: 0,
};

describe("methodology v1 (additive, max 1000)", () => {
  test("tiers: 349 Bronze / 350 Silver / 600 Gold / 800 Platinum", () => {
    expect(tierFor(349)).toBe("Bronze");
    expect(tierFor(350)).toBe("Silver");
    expect(tierForM(599)).toBe("Silver");
    expect(tierFor(600)).toBe("Gold");
    expect(tierFor(800)).toBe("Platinum");
  });
  test("520 Silver → 80 pts to Gold; power ≈ ₦559,600", () => {
    expect(tierFor(520)).toBe("Silver");
    expect(600 - 520).toBe(80);
    const p = creditPower(520);
    expect(p).toBeGreaterThanOrEqual(559000);
    expect(p).toBeLessThanOrEqual(560000);
  });
  test("Ada breakdown: score in Silver/Gold, deltas drive UI panel", () => {
    const b = scoreBreakdown("AJ-774821", ada);
    expect(b.model_version).toBe("1.0.0");
    expect(b.score).toBeGreaterThan(0);
    expect(b.components.payment_consistency.delta_30d).toBe(60);
    expect(b.penalties.late_payments.points).toBe(-20);
  });
  test("late −20 each; open dispute −50; default −150", () => {
    const clean = scoreBreakdown("AJ-x", { ...ada, lateCount: 0 });
    const hit = scoreBreakdown("AJ-x", { ...ada, lateCount: 1, openDisputesAgainstUser: 1, defaults: 1 });
    expect(clean.score - hit.score).toBe(20 + 50 + 150);
  });
  test("cold start → 250 low Bronze, never negative", () => {
    const b = scoreBreakdown("AJ-new", {
      onTimePayments: 0, totalDuePayments: 0, completedCycles: 0, cumulativeNaira: 0,
      monthsOnPlatform: 0, distinctGroupsCompleted: 0, peerEndorsements: 0,
      phoneVerified: true, dobAdded: false, selfieDone: false, bvnOrNinLinked: false,
      lateCount: 0, openDisputesAgainstUser: 0, defaults: 0,
    });
    expect(b.score).toBe(250);
    expect(b.tier).toBe("Bronze");
  });
  test("fraud confirmed → hard Bronze cap, passport share blocked", () => {
    const b = scoreBreakdown("AJ-x", { ...ada, fraudConfirmed: true });
    expect(b.tier).toBe("Bronze");
    expect(passportShareBlocked(fraudBand({ accountsOnDevice: 3, deviceReuseCount: 6, simSwapLast30d: false, loginAnomaly: true, payoutVelocityPerDay: 1 }))).toBe(true);
  });
});
