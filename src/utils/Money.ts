/** Convert a major-unit amount to integer minor units (satang/cents). */
export function toMinorUnits(amount: number): number {
  return Math.round(amount * 100);
}
