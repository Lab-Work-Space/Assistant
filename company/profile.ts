import { z } from 'zod';

/**
 * RF20: `company.profile` holds the legal details the business documents print (name, address, tax ID). Only the owner (a member who holds the
 * Founder role right now, OD-2) sets it, through /settings; it is never a `config_propose` key and no model path writes it. A tax ID is 13 digits
 * with the Thai checksum. Customer and supplier data comes from each request, never from here.
 */

/** Thai national / juristic person ID: the 13th digit is (11 - (sum of digit i times (14 - i), i = 1..12) mod 11) mod 10. */
export function thaiTaxIdOk(id: string): boolean {
  if (!/^\d{13}$/.test(id)) return false;
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(id[i]) * (13 - i);
  return (11 - (sum % 11)) % 10 === Number(id[12]);
}

const NO_CONTROL = /^[^\p{Cc}]*$/u;
const text = (max: number) => z.string().trim().min(1).max(max).regex(NO_CONTROL, 'no control characters');

export const CompanyProfileSchema = z.object({
  name: text(200),
  address: text(400),
  // Optional until the company registers: tax_invoice and withholding_tax_cert refuse without it (tools/plugins/docs/index.ts).
  taxId: z.string().refine(thaiTaxIdOk, 'must be 13 digits with a valid Thai tax ID check digit').optional(),
  /** 00000 = head office. */
  branch: z.string().regex(/^\d{5}$/, 'must be 5 digits, 00000 for the head office').optional(),
  phone: z.string().regex(/^[0-9+\-() ]{3,30}$/, 'digits, + - ( ) and spaces only').optional(),
  email: z.string().max(100).regex(/^[^\s@<>"']+@[^\s@<>"']+$/, 'not an email address').optional(),
}).strict();
export type CompanyProfile = z.infer<typeof CompanyProfileSchema>;
