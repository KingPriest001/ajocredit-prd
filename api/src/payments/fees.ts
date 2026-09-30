// Fees: member-paid, contribution intact. Tiers are assumptions (see PRD §3).
// <₦10k 1.5% · ₦10k–100k 1.0% · >₦100k 0.75%. Mandatory pre-pay display.
export function feeFor(amount: number): { fee: number; total: number } {
  let rate = 0.01;
  if (amount < 10000) rate = 0.015;
  else if (amount > 100000) rate = 0.0075;
  const fee = Math.round(amount * rate);
  return { fee, total: amount + fee };
}

export function feeBreakdown(amount: number): string {
  const { fee, total } = feeFor(amount);
  return `Pot ₦${amount.toLocaleString()} + Fee ₦${fee.toLocaleString()} = ₦${total.toLocaleString()}`;
}

// Example: feeFor(20000) → { fee: 200, total: 20200 }
