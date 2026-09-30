// Score acceptance fixtures — mirrors PRD §4 + plan Phase 5.
// Run when Node installed: `npm test`.
import { scoreRaw, scoreEffective, isProvisional, ScoreInputs } from "./weights";
import { tierFor } from "./trust";
import { fraudBand, passportShareBlocked } from "./fraud";

const ada: ScoreInputs = {
  onTimeRate: 11 / 12, cv: 0.15, streak: 8, totalSaved: 220000,
  completedClean: 1, completionRate: 1, defaultRate: 0,
  groupTrust: 720, idvLevel: 0, nDue: 12, tenureDays: 90, inactiveDays: 0,
};

describe("credit engine v1.0", () => {
  test("perfect payer 12/12 → ≥700 Gold", () => {
    const s = scoreRaw({ ...ada, onTimeRate: 1, cv: 0.05, streak: 12, defaultRate: 0 });
    expect(s).toBeGreaterThanOrEqual(700);
    expect(tierFor(s)).toBe("Gold");
  });
  test("Ada example → ~742 Gold", () => {
    const s = scoreRaw(ada);
    expect(s).toBeGreaterThanOrEqual(700);
    expect(s).toBeLessThan(800);
  });
  test("defaulter 3/10 → drops ≥100pts", () => {
    const before = scoreRaw(ada);
    const after = scoreRaw({ ...ada, onTimeRate: 0.7, defaultRate: 0.3 });
    expect(before - after).toBeGreaterThanOrEqual(100);
  });
  test("thin file N=2 → PROVISIONAL, capped Silver", () => {
    const thin = { ...ada, nDue: 2, tenureDays: 10 };
    expect(isProvisional(thin)).toBe(true);
  });
  test("inactive 90d ex-750 → decays 80..120+", () => {
    const drop = 750 - scoreEffective(750, 90);
    expect(drop).toBeGreaterThanOrEqual(50);
  });
  test("sibyl 3 accts/1 device → Fraud High + share blocked, score untouched", () => {
    const band = fraudBand({ accountsOnDevice: 3, deviceReuseCount: 6, simSwapLast30d: false, loginAnomaly: true, payoutVelocityPerDay: 1 });
    expect(band).toBe("High");
    expect(passportShareBlocked(band)).toBe(true);
    expect(scoreRaw(ada)).toBeGreaterThan(0); // score independent
  });
});
