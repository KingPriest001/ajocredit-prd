// Trust indices: ITI (person) + GTI (group). Mirrors PRD §4.
// ITI = 1000*(0.5*onTime + 0.2*completion + 0.15*(1-disputeLoss) + 0.15*vouch)
// GTI = 1000*(0.3*onTime + 0.25*(1-default) + 0.15*completion + 0.15*governance + 0.15*reserve)
const c01 = (x: number) => Math.min(1, Math.max(0, x));

export function individualTrust(o: { onTimeRate: number; completionRate: number; disputeLossRate: number; vouchNet: number }): number {
  const vouch = Math.min(1, Math.max(0, 0.5 + 0.1 * o.vouchNet));
  return Math.round(1000 * (0.5 * o.onTimeRate + 0.2 * o.completionRate + 0.15 * (1 - o.disputeLossRate) + 0.15 * vouch));
}

export function groupTrust(o: { onTime: number; defaultRate: number; completionHist: number; governance: number; reserve: number }): number {
  return Math.round(
    1000 * (0.3 * o.onTime + 0.25 * (1 - o.defaultRate) + 0.15 * o.completionHist + 0.15 * o.governance + 0.15 * o.reserve),
  );
}

export function tierFor(score: number): "Bronze" | "Silver" | "Gold" | "Platinum" {
  if (score >= 800) return "Platinum";
  if (score >= 600) return "Gold";
  if (score >= 400) return "Silver";
  return "Bronze";
}

export { c01 };
