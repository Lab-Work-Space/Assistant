import { ChannelType, PermissionFlagsBits, type Client, type Guild, type PermissionOverwriteOptions } from 'discord.js';
import type { ResolvedOp } from './perm-limits.js';
import { bitsOf } from './perm-ops.js';
import type { PermWriter } from './perm-world.js';

/**
 * THE executor (Gate 1 C14). This is the only module that calls the Discord write APIs for roles, members' roles, channel overwrites and
 * channel creation (a static test fails on any call site elsewhere). It runs only from a confirmed card (admin/console.ts -> perm-service.ts),
 * through Praw's own client, after perm-limits.ts has re-validated every op against live data.
 * Not PermOp kinds, so never called anywhere: deleting roles or channels, moving or renaming channels, and syncing an existing channel.
 */

const CHANNEL_TYPE = { text: ChannelType.GuildText, voice: ChannelType.GuildVoice, forum: ChannelType.GuildForum } as const;

/** Every defined bit set to true (allow), false (deny) or null (neutral), so `edit` leaves exactly the overwrite that was asked for. */
function optionsOf(allow: bigint, deny: bigint): PermissionOverwriteOptions {
  const out: Record<string, boolean | null> = {};
  for (const [name, bit] of Object.entries(PermissionFlagsBits)) out[name] = (allow & bit) === bit ? true : (deny & bit) === bit ? false : null;
  return out as PermissionOverwriteOptions;
}

export function createDiscordPermWriter(o: { client: () => Client | undefined; guildId: string }): PermWriter {
  const guild = async (): Promise<Guild> => {
    const c = o.client();
    if (!c) throw new Error('the praw client is offline');
    return c.guilds.cache.get(o.guildId) ?? (await c.guilds.fetch(o.guildId));
  };
  const guildChannel = async (g: Guild, id: string) => {
    const ch = await g.channels.fetch(id, { force: true });
    if (!ch || ch.isThread() || !('permissionOverwrites' in ch)) throw new Error(`channel ${id} cannot hold overwrites`);
    return ch;
  };
  const targetOf = async (g: Guild, t: { type: 'role' | 'member'; id: string }) => {
    const x = t.type === 'role' ? await g.roles.fetch(t.id) : await g.members.fetch({ user: t.id, force: true });
    if (!x) throw new Error(`${t.type} ${t.id} not found`);
    return x;
  };
  return {
    async assignRole(memberId, roleId, reason) {
      const m = await (await guild()).members.fetch({ user: memberId, force: true });
      await m.roles.add(roleId, reason);
    },
    async removeRole(memberId, roleId, reason) {
      const m = await (await guild()).members.fetch({ user: memberId, force: true });
      await m.roles.remove(roleId, reason);
    },
    async setOverwrite(channelId, target, allow, deny, reason) {
      const g = await guild();
      const ch = await guildChannel(g, channelId);
      await ch.permissionOverwrites.edit(await targetOf(g, target), optionsOf(allow, deny), { reason });
    },
    async clearOverwrite(channelId, target, reason) {
      const g = await guild();
      const ch = await guildChannel(g, channelId);
      await ch.permissionOverwrites.delete(await targetOf(g, target), reason);
    },
    async createChannel(opts, reason) {
      const g = await guild();
      const made = await g.channels.create({ name: opts.name, type: CHANNEL_TYPE[opts.type], ...(opts.parentId ? { parent: opts.parentId } : {}), reason });
      if (opts.sync && opts.parentId) await made.lockPermissions(); // a channel made a moment ago, never an existing one
      return made.id;
    },
    async createRole(opts, reason) {
      const r = await (await guild()).roles.create({ name: opts.name, colors: { primaryColor: opts.color }, hoist: opts.hoist, permissions: opts.permissions, mentionable: false, reason });
      return r.id;
    },
    async editRolePermissions(roleId, permissions, reason) {
      const g = await guild();
      const r = await g.roles.fetch(roleId);
      if (!r) throw new Error(`role ${roleId} not found`);
      await r.setPermissions(permissions, reason);
    },
  };
}

export interface ApplyReport {
  applied: number;
  total: number;
  ok: boolean;
  lines: string[];
}

/**
 * Runs the resolved ops one after the other and STOPS at the first failure (Gate 1 C21): no silent continue. `audit` is called after each op
 * with its outcome. The text of a Discord error is never shown (only its numeric code).
 */
export async function executeOps(
  resolved: readonly ResolvedOp[], writer: PermWriter, reason: string,
  audit: (op: ResolvedOp, outcome: string) => Promise<void>,
): Promise<ApplyReport> {
  const lines: string[] = [];
  let applied = 0;
  for (const r of resolved) {
    const { op } = r;
    try {
      switch (op.kind) {
        case 'role.assign': await writer.assignRole(op.member, op.role, reason); break;
        case 'role.remove': await writer.removeRole(op.member, op.role, reason); break;
        case 'overwrite.set': await writer.setOverwrite(op.channel, op.target, bitsOf(op.allow), bitsOf(op.deny), reason); break;
        case 'overwrite.clear': await writer.clearOverwrite(op.channel, op.target, reason); break;
        case 'channel.create': await writer.createChannel({ name: op.name.trim(), parentId: op.category, type: op.type, sync: op.sync }, reason); break;
        case 'role.create': await writer.createRole({ name: op.name.trim(), color: op.color, hoist: op.hoist, permissions: bitsOf(op.permissions) }, reason); break;
        case 'role.edit.permissions': await writer.editRolePermissions(op.role, bitsOf(op.permissions), reason); break;
      }
      applied++;
      lines.push(`done: ${r.item.label}`);
      await audit(r, 'ok');
    } catch (e) {
      const code = (e as { code?: unknown }).code;
      const why = typeof code === 'number' ? `Discord error ${code}` : 'error';
      lines.push(`FAILED: ${r.item.label} (${why}). The remaining ${resolved.length - applied - 1} operation(s) were not run.`);
      await audit(r, `failed ${why}`);
      return { applied, total: resolved.length, ok: false, lines };
    }
  }
  return { applied, total: resolved.length, ok: true, lines };
}
