// AJOCREDIT Credit Scoring Methodology v1 — model_version "1.0.0"
// Canonical spec: companion "Credit Scoring Methodology (v1 Draft)".
// Gamified, user-facing reputation score ONLY — NOT an underwriting model (see §8 of that doc).
// Total = components (max 1000) − penalties (floor 0). "What moves your score" panel shows
// period-over-period DELTAS (e.g. this month), not lifetime maxima.

export const MODEL_VERSION = "1.0.0";

export const TIERS = [
  { name: "Bronze", min: 0, max: 349, powerMin: 0, powerMax: 150000 },
  { name: "Silver", min: 350, max: 599, powerMin: 150000, powerMax: 750000 },
  { name: "Gold", min: 600, max: 799, powerMin: 750000, powerMax: 2000000 },
  { name: "Platinum", min: 800, max: 1000, powerMin: 2000000, powerMax: 5000000 },
] as const;
// ₦ ceilings are PLACEHOLDER calibration values owned by Risk/Finance — revisit with real default data.

export type TierName = (typeof TIERS)[number]["name"];

export function tierFor(score: number): TierName {
  for (const t of TIERS) if (score >= t.min && score <= t.max) return t.name;
  return "Bronze";
}

// Linear interpolation of Credit Power within a tier.
// Example: 520 (Silver 350–599) → 150000 + (520−350)/(599−350) × 600000 ≈ ₦559,600.
// (UI mock shows ₦450,000 at 520 — placeholder, reconcile with Risk before build.)
export function creditPower(score: number): number {
  const t = TIERS.find((x) => score >= x.min && score <= x.max) ?? TIERS[0];
  const frac = (score - t.min) / Math.max(1, t.max - t.min);
  return Math.round(t.powerMin + frac * (t.powerMax - t.powerMin));
}

export interface MethodologyInputs {
  onTimePayments: number;
  totalDuePayments: number;
  recent3OnTime?: number; // subset of onTime in most recent 3 cycles (1.5× weight)
  completedCycles: number;
  cumulativeNaira: number;
  monthsOnPlatform: number;
  distinctGroupsCompleted: number;
  peerEndorsements: number;
  phoneVerified: boolean;
  dobAdded: boolean;
  selfieDone: boolean;
  bvnOrNinLinked: boolean;
  lateCount: number; // occurrences (each −20, decays after 6 months if not repeated)
  openDisputesAgainstUser: number; // each −50, reversed if resolved in favor
  defaults: number; // mid-cycle exit/default, each −150
  fraudConfirmed?: boolean; // hard tier cap: Bronze for 12 months (manual override, not formula)
}

// 4.1 Payment Consistency (max 400). Simplified recency: recent-3 subset weighted 1.5×,
// payments older than 12 months 0.5× (approximated here via inputs; full impl windows by date).
export function consistencyPoints(i: MethodologyInputs): number {
  if (i.totalDuePayments <= 0) return 0;
  const recent = i.recent3OnTime ?? 0;
  const older = Math.max(0, i.onTimePayments - recent);
  const weighted = recent * 1.5 + older;
  const denom = i.totalDuePayments + recent * 0.5;
  return Math.round(Math.min(1, weighted / Math.max(1, denom)) * 400);
}

// 4.2 Contribution History (max 250)
export function historyPoints(i: MethodologyInputs): number {
  return Math.min(250, i.completedCycles * 4 + i.cumulativeNaira / 50000);
}

// 4.3 Tenure (max 150, caps at 25 months — tenure alone never passes Silver)
export function tenurePoints(i: MethodologyInputs): number {
  return Math.min(150, i.monthsOnPlatform * 6);
}

// 4.4 Group Diversity & Social Trust (max 100; endorsements are confirmations, not reviews)
export function diversityPoints(i: MethodologyInputs): number {
  return Math.min(60, i.distinctGroupsCompleted * 20) + Math.min(40, i.peerEndorsements * 5);
}

// 4.5 Profile & Verification Strength (max 100 — maps 1:1 to Profile Strength UI)
export function profilePoints(i: MethodologyInputs): number {
  return (i.phoneVerified ? 25 : 0) + (i.dobAdded ? 25 : 0) + (i.selfieDone ? 30 : 0) + (i.bvnOrNinLinked ? 20 : 0);
}

export function penaltyPoints(i: MethodologyInputs): number {
  return i.lateCount * 20 + i.openDisputesAgainstUser * 50 + i.defaults * 150;
  // NOTE: post-payout default (−300) is an OPEN product decision — see docs/ALIGNMENT-3DOCS.md.
}

export interface ScoreBreakdown {
  user_id: string;
  score: number;
  tier: TierName;
  points_to_next_tier: number;
  credit_power_naira: number;
  model_version: string;
  calculated_at: string;
  components: Record<string, { points: number; max: number; delta_30d: number }>;
  penalties: { late_payments: { points: number; count_30d: number }; disputes_open: { points: number; count: number }; defaults: { points: number; count: number } };
}

export function scoreBreakdown(user_id: string, i: MethodologyInputs, deltas = { consistency: 60, history: 40, tenure: 20 }): ScoreBreakdown {
  // Cold start: brand-new user starts at 250 (low Bronze) from profile points only — never penalized for no history.
  const isCold = i.totalDuePayments === 0 && i.completedCycles === 0;
  const comp = {
    payment_consistency: { points: consistencyPoints(i), max: 400, delta_30d: deltas.consistency },
    contribution_history: { points: Math.round(historyPoints(i)), max: 250, delta_30d: deltas.history },
    tenure: { points: tenurePoints(i), max: 150, delta_30d: deltas.tenure },
    diversity_trust: { points: diversityPoints(i), max: 100, delta_30d: 0 },
    profile_strength: { points: profilePoints(i), max: 100, delta_30d: 0 },
  };
  const raw = comp.payment_consistency.points + comp.contribution_history.points + comp.tenure.points + comp.diversity_trust.points + comp.profile_strength.points;
  const score = isCold ? 250 : Math.max(0, raw - penaltyPoints(i));
  const tier = i.fraudConfirmed ? "Bronze" : tierFor(score); // fraud: hard Bronze cap 12 months (manual override)
  const next = TIERS[TIERS.findIndex((t) => t.name === tier) + 1];
  return {
    user_id, score, tier,
    points_to_next_tier: next ? next.min - score : 0,
    credit_power_naira: creditPower(score),
    model_version: MODEL_VERSION,
    calculated_at: new Date().toISOString(),
    components: comp,
    penalties: {
      late_payments: { points: -i.lateCount * 20, count_30d: i.lateCount },
      disputes_open: { points: -i.openDisputesAgainstUser * 50, count: i.openDisputesAgainstUser },
      defaults: { points: -i.defaults * 150, count: i.defaults },
    },
  };
}
