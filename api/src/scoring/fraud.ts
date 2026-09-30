// Fraud/Risk indicator — SEPARATE from Score. Credit Behaviour ≠ Fraud Risk.
// Perfect payer on cloned device keeps Score but trips Fraud=High + freezes passport sharing.
export type FraudBand = "Low" | "Medium" | "High";

export interface FraudSignals {
  accountsOnDevice: number;
  deviceReuseCount: number;
  simSwapLast30d: boolean;
  loginAnomaly: boolean;
  payoutVelocityPerDay: number;
}

export function fraudBand(s: FraudSignals): FraudBand {
  let points = 0;
  if (s.accountsOnDevice >= 3) points += 3;
  else if (s.accountsOnDevice === 2) points += 1;
  if (s.deviceReuseCount >= 5) points += 2;
  if (s.simSwapLast30d) points += 2;
  if (s.loginAnomaly) points += 1;
  if (s.payoutVelocityPerDay >= 5) points += 2;
  if (points >= 3) return "High";
  if (points >= 1) return "Medium";
  return "Low";
}

export function passportShareBlocked(band: FraudBand): boolean {
  return band === "High";
}
