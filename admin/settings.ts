import { DEPT_IDS } from '../core/env.js';
import { LIMIT_KEYS } from '../discord/commands/limits.js';
import { PermOp } from '../discord/perm/perm-ops.js';
import { AdminOp } from './ops.js';
import { serverActions } from './server-actions.js';
import type { AuditFn } from '../governance/audit.js';
import type { AdminConsole, Proposed, Proposer } from './console.js';

/**
 * The adapter between the two settings front ends (the Discord panel, the local dashboard) and the admin console (Gate 1 S37c, S37d, S46).
 *
 * Both front ends render their forms from the SAME action list and turn a submission into the SAME structured op (`AdminOp`, `PermOp`,
 * `config_propose` change, or a server-management op), which only the console may turn into a card. This module owns no write path.
 *
 * Server management (channels, members, moderation, server/events, welcome, AutoMod) is a separate family. Until the branch that implements
 * it registers a handler with `registerFamily('server', ...)` and replaces the stub actions with `addActions(...)`, those sections answer
 * "available after server management is enabled" and never build or propose anything.
 */

export type Kind = 'config' | 'admin_op' | 'perm' | 'server';
export const SERVER_OFF = 'available after server management is enabled';

export interface ActionField {
  id: string;
  label: string;
  style: 'short' | 'paragraph';
  required: boolean;
  maxLength: number;
  /** Shown as placeholder text on the dashboard. */
  hint?: string;
}

export type Built = { ok: true; kind: Kind; raw: unknown; note?: string; /** S18/S37d: user ids the admin typed into the form; they count as named targets for ban and kick. */ named?: string[] };
export type BuildResult = Built | { ok: false; error: string };

export type SectionId = 'holidays' | 'budget' | 'bots' | 'channels' | 'welcome' | 'automod' | 'permissions' | 'server' | 'moderation';
export const SECTIONS: readonly { id: SectionId; label: string; th: string; family: Kind }[] = [
  { id: 'holidays', label: 'Holidays and off days', th: 'วันหยุด', family: 'admin_op' },
  { id: 'budget', label: 'Budget and limits', th: 'งบและลิมิต', family: 'admin_op' },
  { id: 'bots', label: 'Bots: enable, disable, model', th: 'บอท', family: 'admin_op' },
  { id: 'channels', label: 'Channel mapping', th: 'แมปช่อง', family: 'admin_op' },
  { id: 'welcome', label: 'Welcome and default roles', th: 'ต้อนรับและ role เริ่มต้น', family: 'server' },
  { id: 'automod', label: 'AutoMod rules', th: 'AutoMod', family: 'server' },
  { id: 'permissions', label: 'Channel permissions', th: 'สิทธิ์ช่อง', family: 'perm' },
  { id: 'server', label: 'Server settings and events', th: 'ตั้งค่าเซิร์ฟเวอร์และอีเวนต์', family: 'server' },
  { id: 'moderation', label: 'Moderation shortcuts', th: 'ลงโทษด่วน', family: 'server' },
];

export interface SettingsAction {
  id: string;
  section: SectionId;
  family: Kind;
  label: string;
  /** At most 5 (a Discord modal). Empty for a stub. */
  fields: ActionField[];
  /** Parses the raw field texts into a structured op; code only, never a model. */
  build(values: Record<string, string>): BuildResult;
}

const ID = /^\d{17,20}$/;
const f = (id: string, label: string, maxLength: number, o: Partial<ActionField> = {}): ActionField => ({ id, label, style: 'short', required: true, maxLength, ...o });
const bad = (error: string): BuildResult => ({ ok: false, error });
const t = (v: Record<string, string>, k: string): string => (v[k] ?? '').trim();

const YES = new Set(['yes', 'y', 'true', 'on', '1', 'เปิด', 'ใช่']);
const NO = new Set(['no', 'n', 'false', 'off', '0', 'ปิด', 'ไม่']);
function bool(s: string): boolean | null {
  const x = s.trim().toLowerCase();
  return YES.has(x) ? true : NO.has(x) ? false : null;
}
const NUM = /^\d{1,15}(\.\d{1,6})?$/;
function num(s: string): number | null {
  return NUM.test(s) ? Number(s) : null;
}
const oneOf = <T extends string>(s: string, set: readonly T[]): T | null => (set as readonly string[]).includes(s) ? (s as T) : null;

/** Checks the built op against the real schema before it is returned, so a bad field is refused here with a readable reason. */
function op(raw: unknown): BuildResult {
  const r = AdminOp.safeParse(raw);
  return r.success ? { ok: true, kind: 'admin_op', raw: r.data } : bad('Some value is not valid. Check the fields and try again.');
}
function perm(raw: unknown): BuildResult {
  const r = PermOp.safeParse(raw);
  return r.success ? { ok: true, kind: 'perm', raw: [r.data] } : bad('Some value is not valid. Check the fields and try again.');
}

const DEPT_HINT = DEPT_IDS.join(', ');
const LIMIT_NAMES = Object.keys(LIMIT_KEYS);

export function builtinActions(): SettingsAction[] {
  const idField = (id: string, label: string) => f(id, label, 20, { hint: 'Discord id (digits)' });
  const stub = (id: string, section: SectionId, label: string): SettingsAction => ({ id, section, family: 'server', label, fields: [], build: () => bad(SERVER_OFF) });
  return [
    { id: 'holiday_add', section: 'holidays', family: 'admin_op', label: 'Add a holiday', fields: [f('date', 'Date YYYY-MM-DD', 10), f('name', 'Name (optional)', 60, { required: false })],
      build: (v) => op({ op: 'holiday_add', date: t(v, 'date'), ...(t(v, 'name') ? { name: t(v, 'name') } : {}) }) },
    { id: 'holiday_remove', section: 'holidays', family: 'admin_op', label: 'Remove a holiday', fields: [f('date', 'Date YYYY-MM-DD', 10)],
      build: (v) => op({ op: 'holiday_remove', date: t(v, 'date') }) },
    { id: 'holiday_weekdays', section: 'holidays', family: 'admin_op', label: 'Weekly off days', fields: [f('days', 'Days (mon..sun, comma separated, or none)', 60)],
      build: (v) => op({ op: 'holiday_weekdays', days: t(v, 'days') }) },
    { id: 'budget_set', section: 'budget', family: 'admin_op', label: 'Set a budget (USD)', fields: [f('scope', 'Scope: daily, bot or task', 10), f('usd', 'USD', 16)],
      build: (v) => { const scope = oneOf(t(v, 'scope'), ['daily', 'bot', 'task'] as const); const usd = num(t(v, 'usd')); return scope && usd !== null ? op({ op: 'budget_set', scope, usd }) : bad('Scope must be daily, bot or task, and the amount a plain number.'); } },
    { id: 'limits_set', section: 'budget', family: 'admin_op', label: 'Set a limit', fields: [f('limit', 'Limit name', 40, { hint: LIMIT_NAMES.join(', ') }), f('value', 'Value', 16)],
      build: (v) => { const value = num(t(v, 'value')); return LIMIT_NAMES.includes(t(v, 'limit')) && value !== null ? op({ op: 'limits_set', limit: t(v, 'limit'), value }) : bad('Unknown limit, or the value is not a plain number.'); } },
    { id: 'approval_set', section: 'budget', family: 'admin_op', label: 'Approval threshold (USD)', fields: [f('usd', 'USD', 16)],
      build: (v) => { const usd = num(t(v, 'usd')); return usd !== null ? op({ op: 'approval_set', usd }) : bad('The amount must be a plain number.'); } },
    { id: 'bot_toggle', section: 'bots', family: 'admin_op', label: 'Enable or disable a bot', fields: [f('dept', 'Department', 16, { hint: DEPT_HINT }), f('enabled', 'on or off', 8)],
      build: (v) => { const dept = oneOf(t(v, 'dept'), DEPT_IDS); const enabled = bool(t(v, 'enabled')); return dept && enabled !== null ? op({ op: 'bot_toggle', dept, enabled }) : bad('Pick a known department and on or off.'); } },
    { id: 'bot_model', section: 'bots', family: 'admin_op', label: 'Set a bot model', fields: [f('dept', 'Department', 16, { hint: DEPT_HINT }), f('provider', 'Provider id', 64), f('model', 'Model id', 128)],
      build: (v) => { const dept = oneOf(t(v, 'dept'), DEPT_IDS); return dept ? op({ op: 'bot_model', dept, provider: t(v, 'provider'), model: t(v, 'model') }) : bad('Pick a known department.'); } },
    { id: 'channel_map', section: 'channels', family: 'admin_op', label: 'Map a channel to a department', fields: [idField('channel', 'Channel id'), f('dept', 'Department', 16, { hint: DEPT_HINT }), f('work', 'Work channel? yes or no', 4, { required: false })],
      build: (v) => { const dept = oneOf(t(v, 'dept'), DEPT_IDS); const work = t(v, 'work') ? bool(t(v, 'work')) : false; return dept && work !== null && ID.test(t(v, 'channel')) ? op({ op: 'channel_map', channel: t(v, 'channel'), dept, work }) : bad('Give a channel id, a known department, and yes or no.'); } },
    { id: 'channel_unmap', section: 'channels', family: 'admin_op', label: 'Remove a channel mapping', fields: [idField('channel', 'Channel id')],
      build: (v) => (ID.test(t(v, 'channel')) ? op({ op: 'channel_unmap', channel: t(v, 'channel') }) : bad('Give a channel id (digits).')) },
    { id: 'perm_role_assign', section: 'permissions', family: 'perm', label: 'Give a role to a member', fields: [idField('member', 'Member id'), idField('role', 'Role id')],
      build: (v) => perm({ kind: 'role.assign', member: t(v, 'member'), role: t(v, 'role') }) },
    { id: 'perm_role_remove', section: 'permissions', family: 'perm', label: 'Take a role from a member', fields: [idField('member', 'Member id'), idField('role', 'Role id')],
      build: (v) => perm({ kind: 'role.remove', member: t(v, 'member'), role: t(v, 'role') }) },
    { id: 'perm_channel_create', section: 'permissions', family: 'perm', label: 'Create a channel', fields: [f('name', 'Name', 100), { ...idField('category', 'Category id (empty = none)'), required: false }, f('type', 'text, voice or forum', 8), f('sync', 'Sync with the category? yes or no', 4)],
      build: (v) => { const type = oneOf(t(v, 'type'), ['text', 'voice', 'forum'] as const); const sync = bool(t(v, 'sync')); return type && sync !== null ? perm({ kind: 'channel.create', name: t(v, 'name'), category: t(v, 'category') || null, type, sync }) : bad('Type must be text, voice or forum, and sync yes or no.'); } },
    { id: 'perm_overwrite_clear', section: 'permissions', family: 'perm', label: 'Clear a channel overwrite', fields: [idField('channel', 'Channel id'), f('targetType', 'role or member', 6), idField('target', 'Role or member id')],
      build: (v) => { const type = oneOf(t(v, 'targetType'), ['role', 'member'] as const); return type ? perm({ kind: 'overwrite.clear', channel: t(v, 'channel'), target: { type, id: t(v, 'target') } }) : bad('Target type must be role or member.'); } },
    { id: 'perm_overwrite_set', section: 'permissions', family: 'perm', label: 'Set a channel overwrite', fields: [idField('channel', 'Channel id'), f('targetType', 'role or member', 6), idField('target', 'Role or member id'), f('allow', 'Allow bits (decimal)', 20, { hint: '0' }), f('deny', 'Deny bits (decimal)', 20, { hint: '0' })],
      build: (v) => { const type = oneOf(t(v, 'targetType'), ['role', 'member'] as const); return type ? perm({ kind: 'overwrite.set', channel: t(v, 'channel'), target: { type, id: t(v, 'target') }, allow: t(v, 'allow'), deny: t(v, 'deny') }) : bad('Target type must be role or member.'); } },
    // Server-management sections: stubs, replaced via addActions() once the server family is registered.
    stub('welcome_set', 'welcome', 'Welcome message and default roles'),
    stub('automod_rule', 'automod', 'AutoMod rule'),
    stub('server_settings', 'server', 'Server settings'),
    stub('server_event', 'server', 'Scheduled event'),
    stub('mod_timeout', 'moderation', 'Timeout a member'),
    stub('mod_kick', 'moderation', 'Kick a member'),
    stub('mod_ban', 'moderation', 'Ban a member'),
  ];
}

export interface FamilyHandler {
  /** Null when the family may run, else why it is off. */
  available(): Promise<string | null>;
  propose(who: Proposer, kind: Kind, raw: unknown, note?: string): Promise<Proposed>;
}

export interface RegistryOptions {
  /** Gate 1 C11 / S37d: takes one proposal slot from the per-admin window shared with the model path; false = over the cap. */
  takeSlot?: (userId: string) => boolean;
  audit?: AuditFn;
}

export const CAP_TEXT = 'You reached the limit of admin proposals for 10 minutes. Try again later.';

export class SettingsRegistry {
  private readonly actions = new Map<string, SettingsAction>();
  private readonly families = new Map<string, FamilyHandler>();

  constructor(private readonly o: RegistryOptions = {}) {
    this.addActions(builtinActions());
  }

  /** Adds or replaces actions by id (the server-management branch replaces its stubs here). */
  addActions(list: readonly SettingsAction[]): void {
    for (const a of list) this.actions.set(a.id, a);
  }

  registerFamily(kind: Kind, h: FamilyHandler): void {
    this.families.set(kind, h);
  }

  /** The three families that exist on main, all through the one AdminConsole. `permReadiness` is the permission service's fresh check (null = on). */
  bindConsole(c: Pick<AdminConsole, 'proposeConfig' | 'proposeOp' | 'proposePerm' | 'proposeServer'>, permReadiness?: () => Promise<string | null>, serverReadiness?: () => Promise<string | null>): void {
    const on = async () => null;
    this.registerFamily('config', { available: on, propose: (w, _k, raw) => c.proposeConfig(w, raw) });
    this.registerFamily('admin_op', { available: on, propose: (w, _k, raw, note) => c.proposeOp(w, raw, note) });
    this.registerFamily('perm', { available: permReadiness ?? on, propose: (w, _k, raw, note) => c.proposePerm(w, raw, note) });
    this.registerFamily('server', { available: serverReadiness ?? on, propose: (w, _k, raw, note) => c.proposeServer(w, raw, note) });
    this.addActions(serverActions()); // replaces the stubs: the server family now exists
  }

  list(): SettingsAction[] {
    return [...this.actions.values()];
  }

  action(id: string): SettingsAction | undefined {
    return this.actions.get(id);
  }

  /** Per family: null = available, text = why not. Shown by the panel and the dashboard. */
  async capabilities(): Promise<Record<Kind, string | null>> {
    const out = {} as Record<Kind, string | null>;
    for (const k of ['config', 'admin_op', 'perm', 'server'] as const) {
      const h = this.families.get(k);
      out[k] = h ? await h.available().catch(() => 'unavailable') : k === 'server' ? SERVER_OFF : 'unavailable';
    }
    return out;
  }

  build(id: string, values: Record<string, string>): BuildResult {
    const a = this.actions.get(id);
    if (!a) return bad('Unknown action.');
    return a.build(values);
  }

  /** The only way a front end creates a card: through the family handler, which is the console. */
  async propose(who: Proposer, b: Built): Promise<Proposed> {
    const h = this.families.get(b.kind);
    if (!h) return { ok: false, error: b.kind === 'server' ? SERVER_OFF : 'That kind of change is not available here.' };
    const off = await h.available().catch(() => 'unavailable');
    if (off) return { ok: false, error: off };
    // The cap applies here, once, for every front end and family (the console does not know who is asking).
    if (this.o.takeSlot && !this.o.takeSlot(who.userId)) {
      await this.o.audit?.({ actor: `user:${who.userId} via ${who.via ?? 'praw'}`, action: 'admin.propose', tool: b.kind, outcome: 'refused: proposal cap' });
      return { ok: false, error: CAP_TEXT };
    }
    return h.propose(b.named?.length ? { ...who, namedIds: [...new Set([...(who.namedIds ?? []), ...b.named])] } : who, b.kind, b.raw, b.note);
  }
}
