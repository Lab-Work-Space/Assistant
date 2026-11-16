import { PermissionFlagsBits } from 'discord.js';
import { z } from 'zod';
import { orBits } from './perm-bits.js';

const snowflake = z.string().regex(/^\d{17,20}$/, 'must be a Discord id (digits only)');
const MAX64 = (1n << 64n) - 1n;

/** Gate 1 C15: permission bits travel as decimal strings (a JSON number cannot hold 64 bits). Non-digits, negatives and > 64 bits are refused. */
export const BitString = z.string().regex(/^\d{1,20}$/, 'must be a non-negative decimal integer string').refine((s) => BigInt(s) <= MAX64, 'must fit in 64 bits');
export const bitsOf = (s: string): bigint => BigInt(s);

/** Every bit discord.js defines: a deny overwrite may name any of them (denying is never the risk), an unknown bit is refused. */
export const ALL_DEFINED_BITS: bigint = orBits(Object.values(PermissionFlagsBits));

const Target = z.object({ type: z.enum(['role', 'member']), id: snowflake }).strict();
const name = z.string().min(1).max(100);

/** The permission operations Praw may propose (spec B). `delete`, move, rename and sync of existing channels are not kinds, on purpose. */
export const PermOp = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('role.assign'), member: snowflake, role: snowflake }).strict(),
  z.object({ kind: z.literal('role.remove'), member: snowflake, role: snowflake }).strict(),
  z.object({ kind: z.literal('overwrite.set'), channel: snowflake, target: Target, allow: BitString, deny: BitString }).strict(),
  z.object({ kind: z.literal('overwrite.clear'), channel: snowflake, target: Target }).strict(),
  z.object({ kind: z.literal('channel.create'), name, category: snowflake.nullable(), type: z.enum(['text', 'voice', 'forum']), sync: z.boolean() }).strict(),
  z.object({ kind: z.literal('role.create'), name, color: z.number().int().min(0).max(0xffffff), hoist: z.boolean(), permissions: BitString }).strict(),
  z.object({ kind: z.literal('role.edit.permissions'), role: snowflake, permissions: BitString }).strict(),
]);
export type PermOp = z.infer<typeof PermOp>;

/** Gate 1 C21: at most 20 ops per proposal. */
export const PERM_BATCH_MAX = 20;
export const PermProposal = z.object({ ops: z.array(PermOp).min(1).max(PERM_BATCH_MAX), note: z.string().max(300).optional() }).strict();
