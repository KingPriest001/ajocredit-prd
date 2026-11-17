// Fees: member-paid, contribution intact. Flat two-rate rule (see PRD §3).
// ≤₦10,000 → 1% · >₦10,000 → 0.5%. Exactly ₦10,000 is 1%, ₦10,001+ is 0.5%.
// Rounded to the nearest kobo (2 decimal places). Mandatory pre-pay display.
export function feeFor(amount: number): { fee: number; total: number; rate: number } {
  const rate = amount <= 10000 ? 0.01 : 0.005;
  const fee = Math.round(amount * rate * 100) / 100;
  return { fee, total: Math.round((amount + fee) * 100) / 100, rate };
}

export function feeBreakdown(amount: number): string {
  const { fee, total, rate } = feeFor(amount);
  return `Pot ₦${amount.toLocaleString()} + Fee ${rate * 100}% ₦${fee.toLocaleString()} = ₦${total.toLocaleString()}`;
}

// Example: feeFor(20000) → { fee: 100, total: 20100, rate: 0.005 }
// Example: feeFor(10000) → { fee: 100, total: 10100, rate: 0.01 }
// Example: feeFor(10500) → { fee: 52.5, total: 10552.5, rate: 0.005 }
