/** A valid Thai tax ID: 12 digits plus the check digit from the documented formula (11 - sum(d_i x (14 - i), i = 1..12) mod 11) mod 10. */
export function taxIdOf(first12: string): string {
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(first12[i]) * (13 - i);
  return `${first12}${(11 - (sum % 11)) % 10}`;
}
