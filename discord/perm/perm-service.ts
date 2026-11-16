import { canonical } from '../../config/store.js';
import type { PermPort } from '../../admin/console.js';
import type { AuditFn } from '../../governance/audit.js';
import { bitNames } from './perm-bits.js';
import { executeOps } from './perm-apply.js';
import { checkPermOps, permsProblem, type PermConsts } from './perm-limits.js';
import { PermProposal, type PermOp } from './perm-ops.js';
import type { PermWorld, PermWriter } from './perm-world.js';

export interface PermServiceDeps {
  world: PermWorld;
  writer: PermWriter;
  consts: () => PermConsts;
  /** Phase 2 (S4/S5): the executor widens the power-bit set and requires its role strictly below every privileged role. */
  readiness?: { power?: bigint; belowAllPrivileged?: boolean };
  /** Gate 1 C21: the boot permission check again for every bot, on fresh data; returns the clients it disabled. */
  recheck: () => Promise<{ dept: string; warnings: string[] }[]>;
  /** Posts the "client disabled" alert to #bot-log as hq (or logs it when hq is down). */
  alert: (dept: string, warnings: string[]) => Promise<void>;
  audit: AuditFn;
  log: { error(o: unknown, m?: string): void };
}

const READ_MAX = 12_000;
const clean = (s: string) => s.replace(/[\u0000-\u001f\u007f\u2028\u2029\p{Cf}]/gu, '?').slice(0, 64);
const TYPE_NAME: Record<number, string> = { 0: 'text', 2: 'voice', 4: 'category', 5: 'announcement', 13: 'stage', 15: 'forum', 16: 'media' };

/**
 * The permission operations behind `perm_propose` (spec B). It owns three things: the readiness check (C17/C20: the constants are real, the
 * hierarchy is right, Manage Roles/Channels sit only on Praw's integration role), the propose-time validation, and the apply: re-validate
 * against live data, compare each target's snapshot, execute through perm-apply.ts, stop at the first failure, then re-check every bot.
 */
export class PermService implements PermPort {
  constructor(private readonly d: PermServiceDeps) {}

  /** Fresh on every call: null when permission ops may run, else why they are off. */
  async readiness(): Promise<string | null> {
    try {
      return await permsProblem(this.d.world, this.d.consts(), this.d.readiness ?? {});
    } catch (err) {
      this.d.log.error({ err: err instanceof Error ? err.name : 'error' }, 'permission readiness check failed');
      return 'the readiness check could not be completed';
    }
  }

  /** True when the owner constants are completely empty: the feature was never set up, so no alert at boot. */
  unconfigured(): boolean {
    const c = this.d.consts();
    return !c.founderRoleId && c.privilegedRoleIds.length === 0 && c.deniedCategoryIds.length === 0;
  }

  async propose(rawOps: unknown): ReturnType<PermPort['propose']> {
    const parsed = PermProposal.safeParse({ ops: rawOps });
    if (!parsed.success) return { ok: false, error: `invalid operations: ${parsed.error.issues.slice(0, 5).map((i) => `${i.path.join('.')}: ${i.message}`).join('; ').slice(0, 500)}` };
    const checked = await checkPermOps(parsed.data.ops, this.d.world, this.d.consts());
    if (!checked.ok) return { ok: false, error: checked.error };
    return {
      ok: true, payload: { ops: parsed.data.ops }, snapshot: { snaps: checked.resolved.map((r) => r.snap) },
      items: checked.resolved.map((r) => ({ ...r.item, risk: true })),
    };
  }

  async apply(payload: unknown, snapshot: unknown, who: { userId: string; cardId: string; via?: 'praw' | 'panel' | 'dashboard' }): ReturnType<PermPort['apply']> {
    const parsed = PermProposal.safeParse({ ops: (payload as { ops?: unknown } | null)?.ops });
    if (!parsed.success) return { kind: 'refused', why: 'the stored operations are no longer valid' };
    const problem = await this.readiness();
    if (problem) return { kind: 'refused', why: `permission operations are off: ${problem}` };
    const checked = await checkPermOps(parsed.data.ops, this.d.world, this.d.consts());
    if (!checked.ok) return { kind: 'refused', why: checked.error };
    // C7: the live state of every target must still be what the proposal was built on.
    const stored = (snapshot as { snaps?: unknown[] } | null)?.snaps ?? [];
    const stale = checked.resolved.findIndex((r, i) => canonical(r.snap) !== canonical(stored[i]));
    if (stale >= 0) return { kind: 'refused', why: `the state of operation ${stale + 1} changed since the proposal; ask again` };
    const actor = `user:${who.userId} via ${who.via ?? 'praw'}`;
    const report = await executeOps(checked.resolved, this.d.writer, `Praw admin console: ${who.userId} card ${who.cardId.slice(0, 8)}`, (r, outcome) =>
      this.d.audit({ actor, action: `perm.${r.op.kind}`, tool: targetOf(r.op), outcome: `${outcome} card:${who.cardId} old=${r.item.old} new=${r.item.neu}` }));
    // C21: after every apply (also a partial one) all bots are re-checked on fresh data; an unsafe one is disabled and alerted.
    const lines = [...report.lines];
    try {
      for (const x of await this.d.recheck()) {
        lines.push(`Live re-check: the ${x.dept} bot was turned off (${x.warnings.join('; ').slice(0, 300)}).`);
        await this.d.alert(x.dept, x.warnings).catch((err: unknown) => this.d.log.error({ err: err instanceof Error ? err.name : 'error' }, 'disabled alert failed'));
      }
    } catch (err) {
      this.d.log.error({ err: err instanceof Error ? err.name : 'error' }, 'live re-check failed');
      lines.push('Live re-check could not be completed; run /healthz and check the bots.');
    }
    return { kind: 'done', ok: report.ok, applied: report.applied, total: report.total, lines };
  }

  /** `discord_read`: roles or channels (with overwrite summaries) as JSON. Denied channels, protected categories and their children are omitted (C10). */
  async read(kind: 'roles' | 'channels'): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
    const c = this.d.consts();
    const denied = new Set([...c.deniedChannelIds, ...c.deniedCategoryIds]);
    if (kind === 'roles') {
      const [roles, me] = await Promise.all([this.d.world.roles(), this.d.world.me()]);
      if (!roles || !me) return { ok: false, error: 'the roles could not be read' };
      const priv = new Set([c.founderRoleId, c.botAdminRoleId, ...c.privilegedRoleIds].filter(Boolean));
      const out = roles.sort((a, b) => b.position - a.position).map((r) => ({
        id: r.id, name: clean(r.name), position: r.position, managed: r.managed,
        protected: r.id === this.d.world.guildId || r.managed || priv.has(r.id) || r.position >= me.topPosition,
        permissions: bitNames(r.permissions),
      }));
      return { ok: true, text: cap(JSON.stringify(out)) };
    }
    const chans = await this.d.world.channels();
    if (!chans) return { ok: false, error: 'the channels could not be read' };
    const out = chans.filter((ch) => !denied.has(ch.id) && !(ch.parentId && denied.has(ch.parentId))).map((ch) => ({
      id: ch.id, name: clean(ch.name), type: TYPE_NAME[ch.type] ?? String(ch.type), category: ch.parentId,
      overwrites: ch.overwrites.slice(0, 25).map((o) => ({ target: `${o.type}:${o.id}`, allow: bitNames(o.allow), deny: bitNames(o.deny) })),
    }));
    return { ok: true, text: cap(JSON.stringify(out)) };
  }
}

const cap = (s: string): string => (s.length > READ_MAX ? `${s.slice(0, READ_MAX)} ...(truncated; ask for a narrower view)` : s);

const targetOf = (op: PermOp): string => {
  switch (op.kind) {
    case 'role.assign': case 'role.remove': return `${op.member}:${op.role}`;
    case 'overwrite.set': case 'overwrite.clear': return `${op.channel}:${op.target.type}:${op.target.id}`;
    case 'channel.create': return op.category ?? 'top';
    case 'role.create': return 'new role';
    case 'role.edit.permissions': return op.role;
  }
};
