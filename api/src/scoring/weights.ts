// AJOCREDIT weights v1.0 — mirrors AJOCREDIT-PRD-Refined.md §4
// Score = round(1000 * Σ w*n). Thin-file: N_due<3 or tenure<21d → PROVISIONAL (cap Silver).
export const WEIGHTS_V1 = {
  version: "v1.0",
  onTime: 0.35, consistency: 0.20, value: 0.10,
  completed: 0.15, defaults: 0.10, groupRep: 0.05, idv: 0.05,
  capTotal: 5000000, halfLifeDays: 90, inactivityGraceDays: 60, inactivityHalfLifeDays: 180,
} as const;

export type ScoreInputs = {
  onTimeRate: number; cv: number; streak: number;
  totalSaved: number; completedClean: number; completionRate: number;
  defaultRate: number; groupTrust: number; idvLevel: 0 | 1 | 2;
  nDue: number; tenureDays: number; inactiveDays: number;
};

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

export function normalize(i: ScoreInputs) {
  const n1 = clamp01(i.onTimeRate);
  const n2 = 0.6 * (1 - Math.min(i.cv, 1)) + 0.4 * Math.min(i.streak / 12, 1);
  const n3 = Math.min(Math.log10(1 + i.totalSaved) / Math.log10(1 + WEIGHTS_V1.capTotal), 1);
  const n4 = Math.min(i.completedClean / 5, 1) * clamp01(i.completionRate);
  const n5 = Math.max(1 - 2 * i.defaultRate, 0);
  const n6 = clamp01(i.groupTrust / 1000);
  const n7 = ({ 0: 0.4, 1: 0.8, 2: 1.0 } as const)[i.idvLevel];
  return { n1, n2, n3, n4, n5, n6, n7 };
}

export function scoreRaw(i: ScoreInputs) {
  const { n1, n2, n3, n4, n5, n6, n7 } = normalize(i);
  const w = WEIGHTS_V1;
  return Math.round(1000 * (w.onTime * n1 + w.consistency * n2 + w.value * n3 + w.completed * n4 + w.defaults * n5 + w.groupRep * n6 + w.idv * n7));
}

export function scoreEffective(raw: number, inactiveDays: number) {
  if (inactiveDays <= WEIGHTS_V1.inactivityGraceDays) return raw;
  return Math.round(raw * Math.pow(0.5, inactiveDays / WEIGHTS_V1.inactivityHalfLifeDays));
}

export function isProvisional(i: ScoreInputs) {
  return i.nDue < 3 || i.tenureDays < 21;
}

// Example Ada: 11/12 on-time, CV 0.15, streak 8, ₦220k, 1/1 groups, 0 defaults, GTI 720, L0 → ~742 Gold
