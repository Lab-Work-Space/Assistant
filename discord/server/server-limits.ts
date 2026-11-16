import { createHash } from 'node:crypto';
import { ChannelType } from 'discord.js';
import { redactText } from '../../core/logger.js';
import type { CardItem } from '../../admin/card.js';
import { context, channelOf, clean, constantsProblem, memberOf, mention, no, readChannel, Refuse, SAFE_CHECK, NAME, WIDENING as WIDEN, type Ctx, type PermConsts } from '../perm/perm-limits.js';
import type { Ref } from '../commands/plans.js';
import { BAN_KICK_MAX, DESTRUCTIVE_KINDS, ServerOp, SERVER_BATCH_MAX, type AutoModTrigger } from './server-ops.js';
import type { AutoModInfo, GuildInfo, MessageInfo, ServerWorld } from './server-world.js';
import type { ChannelInfo, MemberInfo } from '../perm/perm-world.js';
import { normalizeChannelName, opsTierProblem, rankOf, tierOf, timeoutMaxMinutes, type Tier, type TierRoles } from '../tiers.js';

/**
 * The hard limits of the server-management ops (spec "Hard limits", Gate 1 S1, S15-S29). Pure over a ServerWorld; run at propose AND at apply,
 * and by the executor on its own fresh live reads (S1). Reuses the phase-1 pieces (denied channels and categories, privileged roles, bots).
 */

export interface ServerConsts extends PermConsts {
  /** #🧾-bot-log: the fixed AutoMod alert channel (S28); its category is the Logs category (S15). */
  botLogChannelId: string;
  /** The category archived channels move to (spec: "📦 Archive"). Matched by exact name; zero or several of them turn archiving off. */
  archiveCategoryName: string;
}

export const ARCHIVE_CATEGORY_NAME = '📦 Archive';
/** S19: the ban delete-messages window cap in days. The owner may raise it (up to 7) by recording a reason in Gate 1. */
export const BAN_DELETE_DAYS_MAX = 1;
export const ARCHIVE_DELETE_AFTER_MS = 7 * 24 * 3600_000;
/** S21: a margin under Discord's 14 days, so a message cannot age out between propose and apply. */
export const BULK_MAX_AGE_MS = (14 * 24 - 1) * 3600_000;
const DAY_MS = 24 * 3600_000;

export interface ServerIn {
  proposer: { userId: string };
  /** S18: ids the confirming admin wrote in the triggering message (`<@id>`, `<@!id>` or the raw id), parsed by code. */
  named: ReadonlySet<string>;
  now(): number;
  secrets?: readonly string[];
  /** S13: whether the welcome flow is paused by the raid limit. */
  welcomePaused(): Promise<boolean>;
  /**
   * Delegated tiers (Gate 1 delta T11-T18): set for a Moderator or a Manager only. Absent = Bot Admin, whose limits are unchanged.
   * The executor fills it from its OWN live reads and config; nothing here comes from a card or from the main application.
   */
  tiers?: { actorId: string; tier: Tier; roles: TierRoles; modRoomId: string | null };
}

export interface ResolvedServerOp {
  op: ServerOp;
  item: CardItem;
  snap: unknown;
  /** Counted against the S30 destructive cap. */
  destructive: boolean;
  /** S21: what a bulk delete removes, for its audit rows (ids, author ids and times; never content). */
  bulk?: { id: string; authorId: string; at: number }[];
}
export type ServerChecked = { ok: true; resolved: ResolvedServerOp[]; named: string[] } | { ok: false; error: string };

interface SCtx extends Ctx {
  w: ServerWorld;
  sc: ServerConsts;
  in: ServerIn;
  guild: GuildInfo;
  channels: ChannelInfo[];
  logsCategoryId: string;
  archive: ChannelInfo | null;
  mapped: Set<string>;
  systemIds: Set<string>;
  /** Only for a Moderator or Manager. */
  tier: TierCtx | null;
}

interface TierCtx {
  actorId: string;
  tier: Tier;
  roles: TierRoles;
  /** T11: system channels, the mod room, the archive, the Logs category and every category holding one of them. */
  protectedIds: Set<string>;
  /** T11/T12 (Manager): roles whose appearance in a channel's overwrites puts it out of reach. */
  watchedRoles: Set<string>;
  /** T12: normalized names a Manager may not create or rename to (the mod room and the system channels). */
  reservedNames: Set<string>;
}

const MENTION = /<[@#]|@everyone|@here/i;
const URLISH = /:\/\/|www\.|discord\s*\.\s*gg|discord(?:app)?\.com\/invite|\[|\]\(|\b[a-z0-9-]+\s*\.\s*[a-z]{2,}\b/i; // G2SM-06: also bare domains, markdown links, spaced 'discord . gg'
const CONTROL = /[\u0000-\u001f\u007f\u2028\u2029\p{Cf}]/u;
const TYPE_NAME: Record<number, string> = { 0: 'text', 2: 'voice', 4: 'category', 5: 'announcement', 13: 'stage', 15: 'forum' };
const MAKE_TYPE = { text: ChannelType.GuildText, voice: ChannelType.GuildVoice, forum: ChannelType.GuildForum, stage: ChannelType.GuildStageVoice, announcement: ChannelType.GuildAnnouncement, category: ChannelType.GuildCategory } as const;
export const makeTypeCode = (t: keyof typeof MAKE_TYPE): number => MAKE_TYPE[t];

async function sctx(world: ServerWorld, sc: ServerConsts, input: ServerIn): Promise<SCtx> {
  const base = await context(world, sc);
  const [guild, channels, mapped] = await Promise.all([world.guild(), world.channels(), world.mappedChannelIds()]);
  if (!guild) return no('the server could not be read');
  if (!channels) return no('the channels could not be read');
  const log = channels.find((c) => c.id === sc.botLogChannelId);
  if (!log) return no('#🧾-bot-log could not be read, so the Logs category is unknown (refused to be safe)');
  const archives = channels.filter((c) => c.type === 4 && c.name.trim() === sc.archiveCategoryName);
  // A tier op needs the mod room in the executor's own view: its name, its category and the channels around it are what the tier rules protect.
  if (input.tiers?.modRoomId && !channels.some((c) => c.id === input.tiers!.modRoomId)) return no('the mod room is not visible to the executor (LW Admin needs View Channel there); refused to be safe');
  const archive = archives.length === 1 ? archives[0]! : null;
  const logsCategoryId = log.parentId ?? '';
  return {
    ...base, w: world, sc, in: input, guild, channels, logsCategoryId, archive, mapped: new Set(mapped), systemIds: new Set(sc.systemChannelIds),
    tier: input.tiers ? tierCtx(input.tiers, sc, base.priv, channels, archive, logsCategoryId) : null,
  };
}

function tierCtx(t: NonNullable<ServerIn['tiers']>, sc: ServerConsts, priv: Set<string>, channels: ChannelInfo[], archive: ChannelInfo | null, logsCategoryId: string): TierCtx {
  const room = [...sc.systemChannelIds, ...(t.modRoomId ? [t.modRoomId] : [])];
  const protectedIds = new Set<string>([...room, ...(archive ? [archive.id] : []), ...(logsCategoryId ? [logsCategoryId] : [])]);
  for (const id of room) {
    const p = channels.find((c) => c.id === id)?.parentId;
    if (p) protectedIds.add(p);
  }
  const reservedNames = new Set(channels.filter((c) => room.includes(c.id)).map((c) => normalizeChannelName(c.name)).filter(Boolean));
  const watchedRoles = new Set([...priv, ...(t.roles.managerId ? [t.roles.managerId] : []), ...(t.roles.moderatorId ? [t.roles.moderatorId] : []), t.roles.botAdminRoleId].filter(Boolean));
  return { actorId: t.actorId, tier: t.tier, roles: t.roles, protectedIds, watchedRoles, reservedNames };
}

/** S15: system channels, the Logs category and the rules channel. Returns why a channel is protected, else null. */
function protectedWhy(x: SCtx, ch: ChannelInfo): string | null {
  if (x.systemIds.has(ch.id) || (ch.parentId && x.systemIds.has(ch.parentId))) return 'a system channel (setting, bot-log, tasks, direct, ai-warroom)';
  if (x.logsCategoryId && (ch.id === x.logsCategoryId || ch.parentId === x.logsCategoryId)) return 'in the Logs category';
  if (ch.id === x.guild.rulesChannelId) return 'the rules channel';
  return null;
}

/** C17/C18 for channel ops: not denied, not a thread, readable parent, and not a protected channel. */
async function editable(x: SCtx, id: string, what = 'channel'): Promise<ChannelInfo> {
  const ch = await channelOf(x, id, what);
  const why = protectedWhy(x, ch);
  if (why) no(`${what} ${id} is ${why}; it is never changed`);
  const tw = tierChannelWhy(x, ch);
  if (tw) no(`${what} ${id} ${tw}`);
  return ch;
}

/** T11: what a Moderator or Manager may not touch. The overwrite rule is the Manager's (channel structure ops); a Moderator only needs the protected set. */
function tierChannelWhy(x: SCtx, ch: ChannelInfo): string | null {
  const t = x.tier;
  if (!t) return null;
  if (t.protectedIds.has(ch.id)) return 'is the mod room, a system channel, the archive or a category holding one; it is out of reach for your role';
  if (t.tier === 'manager' && ch.overwrites.some((o) => o.type === 'role' && t.watchedRoles.has(o.id))) return 'has permission overwrites for a staff or tier role; it is out of reach for your role';
  return null;
}

/** T12 (Manager): moving into or out of a category, or creating in one, must not inherit or shed an overwrite of a tier or privileged role. */
async function tierCategoryWhy(x: SCtx, id: string | null): Promise<string | null> {
  const t = x.tier;
  if (!t || t.tier !== 'manager' || !id) return null;
  const cat = await readChannel(x, id);
  if (!cat) return `category ${id} could not be read (refused to be safe)`;
  return cat.overwrites.some((o) => o.type === 'role' && t.watchedRoles.has(o.id)) ? `category ${id} has overwrites for a staff or tier role` : null;
}

/** T12: a name that collides (emoji, spacing and case stripped) with the mod room or a system channel. */
function reservedName(x: SCtx, name: string): void {
  if (x.tier && x.tier.reservedNames.has(normalizeChannelName(name))) no('that name is reserved (the mod room or a system channel)');
}

/** S17: a thread whose parent is a normal channel (not denied, not a system channel, not under a denied or Logs category). */
async function threadOf(x: SCtx, id: string): Promise<ChannelInfo> {
  const { c } = x;
  if (c.deniedChannelIds.includes(id) || c.deniedCategoryIds.includes(id)) no(`thread ${id} is off limits`);
  const t = await readChannel(x, id);
  if (!t) return no(`thread ${id} could not be read (refused to be safe)`);
  if (!t.isThread || !t.parentId) no(`${id} is not a thread`);
  if (c.deniedChannelIds.includes(t.parentId!) || c.deniedCategoryIds.includes(t.parentId!)) no(`thread ${id} is under a protected channel`);
  const parent = await readChannel(x, t.parentId!);
  if (!parent) return no(`the parent of thread ${id} could not be read (refused to be safe)`);
  if (parent.parentId && (c.deniedChannelIds.includes(parent.parentId) || c.deniedCategoryIds.includes(parent.parentId))) no(`thread ${id} is under a protected category`);
  const why = protectedWhy(x, parent);
  if (why) no(`thread ${id} belongs to ${why}; card threads and system threads are never changed`);
  if (x.tier?.protectedIds.has(parent.id)) no(`thread ${id} belongs to the mod room or a protected channel`);
  return t;
}

const topOf = (x: SCtx, m: MemberInfo): number => Math.max(0, ...m.roleIds.map((r) => x.roles.get(r)?.position ?? 0));

/** The spec's never-act-on list (S20): the member limits of phase 1, plus a top role at or above the executor's. */
async function actOn(x: SCtx, id: string): Promise<MemberInfo> {
  const m = await memberOf(x, id);
  if (topOf(x, m) >= x.me.topPosition) no(`member ${id} has a top role at or above the executor's top role`);
  // T16: the target's tier from LIVE roles; never yourself, never your own tier or higher (a member with several tier roles counts at the highest).
  if (x.tier) {
    if (id === x.tier.actorId) no('you cannot act on yourself');
    if (rankOf(tierOf(m.roleIds, x.tier.roles)) >= rankOf(x.tier.tier)) no(`member ${id} is at your tier or above; a ${x.tier.tier} cannot act on them`);
  }
  return m;
}

/** T17: a message by a member at the actor's tier or higher (the actor included) is out of reach for a Moderator or Manager. */
async function authorTierBlocked(x: SCtx, m: MessageInfo): Promise<boolean> {
  if (!x.tier) return false;
  const mem = await x.w.member(m.authorId);
  if (!mem) return false; // left the server: the existing check (user lookup, bot) already ran
  return m.authorId === x.tier.actorId || rankOf(tierOf(mem.roleIds, x.tier.roles)) >= rankOf(x.tier.tier);
}
const authorBlocked = async (x: SCtx, m: MessageInfo): Promise<boolean> => (await authorProtected(x, m)) || (await authorTierBlocked(x, m));

/** S21: whether the author of a message is someone whose messages are never deleted (a bot, the owner, a privileged holder, the executor). */
async function authorProtected(x: SCtx, m: MessageInfo): Promise<boolean> {
  if (m.authorBot || m.authorId === x.me.id || x.botIds.has(m.authorId)) return true;
  const mem = await x.w.member(m.authorId);
  if (mem) return mem.isBot || mem.isOwner || mem.roleIds.some((r) => x.priv.has(r)) || topOf(x, mem) >= x.me.topPosition;
  // not a member: gone from the server (a user lookup answers) or unknown (fail closed)
  const u = await x.w.user(m.authorId);
  return !u || u.isBot;
}

/** G2SM-03 (G2A-05): a value the masker would change is shown redacted on the card but would be written raw, so it is refused. */
function plain(x: SCtx, what: string, v: string | undefined | null): void {
  if (v && redactText(v, x.in.secrets) !== v) no(`${what} looks like a secret (a token or key) and cannot be set from Discord`);
}
const reasonProblem = (r: string | undefined, secrets: readonly string[] | undefined): string | null => {
  if (r === undefined) return null;
  if (redactText(r, secrets) !== r) return 'the reason looks like a secret (a token or key)';
  if (MENTION.test(r) || CONTROL.test(r)) return 'the reason must not contain mention syntax or control characters';
  return null;
};
const checkReason = (x: SCtx, r: string | undefined) => {
  const p = reasonProblem(r, x.in.secrets);
  if (p) no(p);
};
const withReason = (s: string, r: string | undefined) => (r ? `${s}; reason: "${r}"` : s);
const who = (m: { username?: string | undefined; nick?: string | null | undefined }, id: string) => clean(m.nick || m.username || id);

/** S18: a ban or kick target must have been named by the admin; for the other member ops an unnamed target is a warning on the card. */
function named(x: SCtx, id: string, strict: boolean): string | undefined {
  if (x.in.named.has(id)) return undefined;
  // T15: a Moderator or Manager names every member target in their OWN triggering message (code-parsed); the model's pick is never enough.
  if (strict || x.tier) no(`target ${id} was not named by the admin in the triggering message (by mention or raw id); ban and kick need a target the admin named`);
  return 'target chosen by Praw, not by you';
}

/** S26: an external event location is checked syntactically only: https, no userinfo, at most 100 characters. No lookup, no fetch. */
export function locationProblem(loc: string): { problem: string } | { host: string } {
  if (loc.length > 100) return { problem: 'the location is longer than 100 characters' };
  let u: URL;
  try {
    u = new URL(loc);
  } catch {
    return { problem: 'the location is not a valid URL' };
  }
  if (u.protocol !== 'https:') return { problem: 'the location must be an https URL' };
  if (u.username || u.password) return { problem: 'the location must not contain a user name or password' };
  if (!u.hostname) return { problem: 'the location has no host' };
  return { host: u.hostname }; // WHATWG URL gives the ASCII (punycode) form
}

const fmtTs = (ms: number) => new Date(ms).toISOString().replace('.000Z', 'Z');

function triggerCode(t: AutoModTrigger): 1 | 3 | 4 | 5 {
  return t.type === 'keyword' ? 1 : t.type === 'spam' ? 3 : t.type === 'preset' ? 4 : 5;
}
const PRESET_NAME: Record<number, string> = { 1: 'profanity', 2: 'sexual content', 3: 'slurs' };

function patternsOf(t: AutoModTrigger): { keywords: string[]; regex: string[]; allow: string[]; presets: number[]; mentionLimit: number | null } {
  return {
    keywords: t.type === 'keyword' ? t.keywords : [], regex: t.type === 'keyword' ? (t.regex ?? []) : [],
    allow: t.type === 'keyword' || t.type === 'preset' ? (t.allow ?? []) : [], presets: t.type === 'preset' ? t.presets : [], mentionLimit: t.type === 'mentionSpam' ? t.mentionLimit : null,
  };
}

function describeRule(r: { keywords: string[]; regex: string[]; allow: string[]; presets: number[]; mentionLimit: number | null }): string {
  return JSON.stringify({ keywords: r.keywords, regex: r.regex, allow: r.allow, presets: r.presets.map((p) => PRESET_NAME[p] ?? p), mentionLimit: r.mentionLimit });
}

async function checkActions(x: SCtx, a: { block?: { customMessage?: string | undefined } | undefined; alert?: boolean | undefined; timeoutSeconds?: number | undefined }): Promise<string> {
  if (!a.block && !a.alert && a.timeoutSeconds === undefined) no('an AutoMod rule needs at least one action (block, alert or timeout)');
  const cm = a.block?.customMessage;
  if (cm !== undefined && (URLISH.test(cm) || MENTION.test(cm) || CONTROL.test(cm))) no('the custom block message must not contain a URL, mention syntax or control characters');
  if (cm !== undefined && redactText(cm, x.in.secrets) !== cm) no('the custom block message looks like a secret');
  if (a.alert) {
    const log = await readChannel(x, x.sc.botLogChannelId);
    if (!log) no('#🧾-bot-log could not be read, so alert actions are off');
  }
  const parts = [a.block ? `block${cm ? ` (message "${cm}")` : ''}` : '', a.alert ? 'alert to #🧾-bot-log' : '', a.timeoutSeconds !== undefined ? `timeout ${a.timeoutSeconds}s` : ''].filter(Boolean);
  return parts.join(', ');
}

async function checkExempt(x: SCtx, roles: readonly string[] | undefined, channels: readonly string[] | undefined): Promise<void> {
  for (const id of roles ?? []) {
    if (id === x.w.guildId) no('@everyone cannot be exempt from an AutoMod rule');
    if (!x.roles.has(id)) no(`exempt role ${id} was not found`);
  }
  const normal = [...x.roles.values()].filter((r) => r.id !== x.w.guildId).length;
  if (roles && normal > 0 && new Set(roles).size >= normal) no('exempting every role would switch the rule off for everyone');
  for (const id of channels ?? []) {
    if (x.sc.deniedChannelIds.includes(id) || x.sc.deniedCategoryIds.includes(id)) no(`exempt channel ${id} is off limits`);
    if (!(await readChannel(x, id))) no(`exempt channel ${id} could not be read`);
  }
}

async function selectBulk(x: SCtx, op: Extract<ServerOp, { kind: 'msg.bulk' }>): Promise<{ ids: string[]; msgs: MessageInfo[] }> {
  const all = await x.w.messages(op.channel, 100);
  if (!all) return no(`messages of channel ${op.channel} could not be read`);
  const cutoff = x.in.now() - BULK_MAX_AGE_MS;
  const picked: MessageInfo[] = [];
  const verdict = new Map<string, boolean>();
  for (const m of all) {
    if (picked.length >= op.count) break;
    if (m.createdAt < cutoff || m.pinned) continue;
    if (op.author && m.authorId !== op.author) continue;
    if (!verdict.has(m.authorId)) verdict.set(m.authorId, await authorBlocked(x, m));
    if (verdict.get(m.authorId)) continue;
    picked.push(m);
  }
  if (!picked.length) no('no message qualifies: only messages younger than 14 days, not pinned and not by a protected member can be deleted');
  return { ids: picked.map((m) => m.id), msgs: picked };
}

const days = (ms: number) => Math.floor(ms / DAY_MS);

async function checkOne(op: ServerOp, x: SCtx): Promise<ResolvedServerOp> {
  const destructive = DESTRUCTIVE_KINDS.includes(op.kind);
  const done = (item: CardItem, snap: unknown, o: ServerOp = op): ResolvedServerOp => ({ op: o, item, snap, destructive });
  switch (op.kind) {
    case 'channel.edit': {
      const ch = await editable(x, op.channel);
      if (x.tier && x.mapped.has(ch.id)) no('a channel mapped to a department cannot be changed by your role');
      const changes: string[] = [];
      const old: string[] = [];
      if (op.name !== undefined && op.name.trim() !== ch.name) {
        plain(x, 'the channel name', op.name);
        reservedName(x, op.name);
        if (!NAME.test(op.name.trim())) no('the channel name may use letters, digits, pictographs, spaces, hyphens and underscores only');
        old.push(`name "${clean(ch.name)}"`); changes.push(`name "${op.name.trim()}"`);
      }
      if (op.topic !== undefined && op.topic !== (ch.topic ?? '')) {
        if (CONTROL.test(op.topic.replace(/[\n\r\t]/g, ''))) no('the topic must not contain control characters');
        plain(x, 'the topic', op.topic);
        old.push(`topic "${ch.topic ?? ''}"`); changes.push(`topic "${op.topic}"`);
      }
      if (op.slowmode !== undefined && op.slowmode !== (ch.slowmode ?? 0)) { old.push(`slowmode ${ch.slowmode ?? 0}s`); changes.push(`slowmode ${op.slowmode}s`); }
      if (op.nsfw !== undefined && op.nsfw !== (ch.nsfw ?? false)) { old.push(`NSFW ${ch.nsfw ? 'on' : 'off'}`); changes.push(`NSFW ${op.nsfw ? 'on' : 'off'}`); }
      if (!changes.length) no('nothing would change');
      return done({ label: 'Edit channel', refs: [mention('channel', ch.id)], old: old.join('; '), neu: changes.join('; ') }, { name: ch.name, topic: ch.topic ?? '', slowmode: ch.slowmode ?? 0, nsfw: ch.nsfw ?? false });
    }
    case 'channel.move': {
      const ch = await editable(x, op.channel);
      if (x.tier && x.mapped.has(ch.id)) no('a channel mapped to a department cannot be moved by your role');
      const out = await tierCategoryWhy(x, ch.parentId);
      if (out) no(`the channel is in ${out}; it cannot be moved out by your role`);
      const into = await tierCategoryWhy(x, op.category);
      if (into) no(`the target ${into}`);
      let target: ChannelInfo | null = null;
      if (op.category !== null) {
        target = await editable(x, op.category, 'category');
        if (target.type !== 4) no(`${op.category} is not a category`);
      }
      if ((ch.parentId ?? null) === (target?.id ?? null) && op.position === undefined) no('the channel is already there');
      return done({ label: 'Move channel', refs: [mention('channel', ch.id), ...(target ? [mention('channel', target.id)] : [])], old: `in ${ch.parentId ? 'a category' : 'the top level'}, position ${ch.position ?? '?'}`, neu: `${target ? `in "${clean(target.name)}"` : 'at the top level'}${op.position !== undefined ? `, position ${op.position}` : ''}; permissions are kept (not synced)` }, { parent: ch.parentId, position: ch.position ?? null });
    }
    case 'channel.make': {
      plain(x, 'the channel name', op.name);
      plain(x, 'the topic', op.topic);
      if (!NAME.test(op.name.trim())) no('the channel name may use letters, digits, pictographs, spaces, hyphens and underscores only');
      reservedName(x, op.name);
      const inside = await tierCategoryWhy(x, op.category);
      if (inside) no(`the new channel would inherit from ${inside}`);
      let cat: ChannelInfo | null = null;
      if (op.category !== null) {
        if (op.type === 'category') no('a category cannot sit inside a category');
        cat = await editable(x, op.category, 'category');
        if (cat.type !== 4) no(`${op.category} is not a category`);
      }
      return done({ label: 'Create channel', refs: cat ? [mention('channel', cat.id)] : [], old: '(none)', neu: `${op.type} "${op.name.trim()}"${cat ? ` in "${clean(cat.name)}"` : ' at the top level'}` }, { category: cat?.id ?? null });
    }
    case 'channel.archive': {
      const ch = await editable(x, op.channel);
      if (ch.type === 4) no('a category cannot be archived');
      if (!x.archive) no(`archiving needs exactly one category named "${x.sc.archiveCategoryName}"`);
      if (ch.parentId === x.archive!.id) no('the channel is already archived');
      if (x.mapped.has(ch.id)) no('a channel mapped to a department cannot be archived');
      return done({ label: 'Archive channel', refs: [mention('channel', ch.id)], old: `in ${ch.parentId ? 'a category' : 'the top level'}`, neu: `moved to "${clean(x.archive!.name)}"; @everyone cannot send there; history is kept` }, { parent: ch.parentId, overwrites: ch.overwrites.map((o) => `${o.type}:${o.id}:${o.allow}/${o.deny}`).sort() });
    }
    case 'channel.delete': {
      const ch = await editable(x, op.channel);
      if (x.archive && ch.id === x.archive.id) no('the Archive category is never deleted');
      if (ch.type === 4 && ch.name.trim() === x.sc.archiveCategoryName) no('the Archive category is never deleted');
      if (x.mapped.has(ch.id)) no('a channel mapped to a department cannot be deleted');
      const empty = await x.w.channelEmpty(ch.id);
      if (empty === null) no('whether the channel is empty could not be read (refused to be safe)');
      let why: string;
      if (empty) why = 'it is empty';
      else {
        const at = await x.w.archivedAt(ch.id);
        if (at === null || !x.archive || ch.parentId !== x.archive.id) no('only an empty channel or category, or a channel this application archived at least 7 days ago and that is still in the Archive category, can be deleted');
        if (x.in.now() - at! < ARCHIVE_DELETE_AFTER_MS) no(`the channel was archived ${days(x.in.now() - at!)} day(s) ago; it can be deleted after 7 days`);
        why = `archived ${days(x.in.now() - at!)} days ago`;
      }
      return done({ label: 'Delete channel', refs: [mention('channel', ch.id)], old: `${TYPE_NAME[ch.type] ?? ch.type} "${clean(ch.name)}"`, neu: `deleted (${why})`, risk: true }, { name: ch.name, parent: ch.parentId, empty });
    }
    case 'thread.archive': case 'thread.lock': case 'thread.unlock': case 'thread.delete': {
      const t = await threadOf(x, op.thread);
      const a = op.kind.slice(7);
      if (a === 'archive' && t.archived) no('the thread is already archived');
      if (a === 'lock' && t.locked) no('the thread is already locked');
      if (a === 'unlock' && !t.locked) no('the thread is not locked');
      return done({ label: `${a[0]!.toUpperCase()}${a.slice(1)} thread`, refs: [mention('channel', t.id)], old: `${t.archived ? 'archived' : 'open'}, ${t.locked ? 'locked' : 'unlocked'}`, neu: a === 'delete' ? 'deleted' : a === 'archive' ? 'archived' : a === 'lock' ? 'locked' : 'unlocked', risk: a === 'delete' }, { archived: !!t.archived, locked: !!t.locked, parent: t.parentId });
    }
    case 'member.nick': {
      const m = await actOn(x, op.member);
      const nick = op.nick === null ? null : op.nick.trim();
      plain(x, 'the nickname', nick);
      if (nick !== null && (nick.length < 1 || MENTION.test(nick) || CONTROL.test(nick))) no('a nickname is 1 to 32 characters without mention syntax');
      if ((m.nick ?? null) === nick) no('nothing would change');
      const w = named(x, op.member, false);
      return done({ label: 'Set nickname', refs: [mention('user', op.member)], old: `"${m.nick ?? ''}" (${who(m, op.member)})`, neu: nick === null ? '(cleared)' : `"${nick}"`, ...(w ? { warn: w } : {}) }, { nick: m.nick ?? null });
    }
    case 'invite.create': {
      const ch = await editable(x, op.channel);
      if (ch.type === 4) no('an invite needs a channel, not a category');
      return done({ label: 'Create invite', refs: [mention('channel', ch.id)], old: '(none)', neu: `at most ${op.maxUses} use(s), expires in ${Math.round(op.maxAgeSeconds / 3600)} h; unique; the link is shown only to you after Confirm`, risk: true }, { channel: ch.id });
    }
    case 'invite.revoke': {
      const list = await x.w.invites();
      if (!list) return no('the invites could not be read');
      const inv = list.find((i) => i.code === op.code);
      if (!inv) no('no such invite');
      if (inv!.inviterId !== x.me.id) no('only invites this application created can be revoked');
      return done({ label: 'Revoke invite', refs: inv!.channelId ? [mention('channel', inv!.channelId)] : [], old: `invite ${hash8(op.code)} (${inv!.uses}/${inv!.maxUses || 'unlimited'} used)`, neu: 'revoked' }, { uses: inv!.uses });
    }
    case 'msg.delete': case 'msg.pin': case 'msg.unpin': {
      const ch = await editable(x, op.channel);
      const m = await x.w.message(ch.id, op.message);
      if (!m) no('the message could not be read');
      if (await authorBlocked(x, m!)) no('the message was written by a protected member (a bot, the server owner, a Founder/Bot Admin/privileged holder, someone above the executor, or at your own tier or above)');
      // T15: a Moderator or Manager points at the message by id or by replying to it in their own trigger message.
      if (x.tier && !x.in.named.has(op.message)) no('the message must be named in your own message (by its id, or by replying to it)');
      if (op.kind === 'msg.pin' && m!.pinned) no('the message is already pinned');
      if (op.kind === 'msg.unpin' && !m!.pinned) no('the message is not pinned');
      if (op.kind === 'msg.delete') checkReason(x, op.reason);
      const label = op.kind === 'msg.delete' ? 'Delete message' : op.kind === 'msg.pin' ? 'Pin message' : 'Unpin message';
      return done({ label, refs: [mention('channel', ch.id), mention('user', m!.authorId)], old: `message ${m!.id} from ${fmtTs(m!.createdAt)}`, neu: op.kind === 'msg.delete' ? withReason('deleted (the text is not shown here)', op.reason) : op.kind === 'msg.pin' ? 'pinned' : 'unpinned' }, { pinned: m!.pinned, author: m!.authorId });
    }
    case 'msg.bulk': {
      const ch = await editable(x, op.channel);
      checkReason(x, op.reason);
      if (op.ids) {
        // apply (or a stored card): the frozen list, never a new selection (N2). Only the still-eligible ids are kept; the rest are skipped by the executor.
        const live: MessageInfo[] = [];
        for (const id of op.ids) {
          const m = await x.w.message(ch.id, id);
          if (!m || m.pinned || m.createdAt < x.in.now() - BULK_MAX_AGE_MS || (await authorBlocked(x, m))) continue;
          live.push(m);
        }
        if (!live.length) no('none of the stored messages can still be deleted');
        return { ...done(bulkItem(ch, live, op.ids.length, op.reason), { ids: [...op.ids].sort() }, op), bulk: live.map((m) => ({ id: m.id, authorId: m.authorId, at: m.createdAt })) };
      }
      const { ids, msgs } = await selectBulk(x, op);
      return { ...done(bulkItem(ch, msgs, ids.length, op.reason), { ids: [...ids].sort() }, { ...op, ids }), bulk: msgs.map((m) => ({ id: m.id, authorId: m.authorId, at: m.createdAt })) };
    }
    case 'member.timeout': case 'member.untimeout': {
      const m = await actOn(x, op.member);
      checkReason(x, op.reason);
      const w = named(x, op.member, false);
      // T18: a Moderator or Manager can neither end nor shorten a timeout longer than their own tier could have set (one set by a higher tier).
      if (x.tier && (m.timeoutUntil ?? 0) - x.in.now() > timeoutMaxMinutes(x.tier.tier) * 60_000) no('the member is timed out for longer than your role could set; only a higher role can change it');
      if (op.kind === 'member.untimeout') {
        const until = m.timeoutUntil ?? 0;
        if (until <= x.in.now()) no('the member is not timed out');
        return done({ label: 'End timeout', refs: [mention('user', op.member)], old: `timed out until ${fmtTs(until)} (${who(m, op.member)})`, neu: withReason('timeout ended', op.reason), ...(w ? { warn: w } : {}) }, { until: m.timeoutUntil });
      }
      const warns = [w, op.minutes > 1440 ? 'a timeout longer than 1 day' : undefined].filter(Boolean).join('; ');
      return done({ label: 'Timeout member', refs: [mention('user', op.member)], old: m.timeoutUntil && m.timeoutUntil > x.in.now() ? `timed out until ${fmtTs(m.timeoutUntil)}` : `not timed out (${who(m, op.member)})`, neu: withReason(`timed out for ${op.minutes} minute(s)`, op.reason), risk: true, ...(warns ? { warn: warns } : {}) }, { until: m.timeoutUntil ?? null });
    }
    case 'member.kick': {
      named(x, op.member, true);
      const m = await actOn(x, op.member);
      checkReason(x, op.reason);
      return done({ label: 'Kick member', refs: [mention('user', op.member)], old: `member (${who(m, op.member)})`, neu: withReason('kicked', op.reason), risk: true }, { member: true, roles: [...m.roleIds].sort() });
    }
    case 'member.ban': {
      named(x, op.member, true);
      checkReason(x, op.reason);
      if (op.deleteDays > BAN_DELETE_DAYS_MAX) no(`the messages-delete window is at most ${BAN_DELETE_DAYS_MAX} day(s)`);
      const u = await x.w.user(op.member);
      if (!u) no(`user ${op.member} could not be fetched (refused to be safe)`);
      if (u!.isBot) no(`user ${op.member} is a bot`);
      if (await x.w.banned(op.member)) no('that user is already banned');
      if (op.member === x.guild.ownerId) no(`user ${op.member} is the server owner`);
      // G2SM-04: only Discord's Unknown Member (10007) means "not a member"; any other failed fetch must not skip the never-act-on checks.
      const present = await x.w.isMember(op.member);
      if (present === null) no(`member ${op.member} could not be checked (refused to be safe)`);
      const isMember = present ? await actOn(x, op.member) : null;
      const warn = op.deleteDays > 0 ? `deletes this user's messages from the last ${op.deleteDays} day(s) in EVERY channel, including channels this application cannot see` : undefined;
      return done({ label: 'Ban member', refs: [mention('user', op.member)], old: `${isMember ? 'member' : 'not a member'} (${clean(u!.username)})`, neu: withReason(`banned; delete-messages window ${op.deleteDays} day(s)`, op.reason), risk: true, ...(warn ? { warn } : {}) }, { member: !!isMember, roles: isMember ? [...isMember.roleIds].sort() : [] });
    }
    case 'member.unban': {
      checkReason(x, op.reason);
      const u = await x.w.user(op.user);
      if (!u) no(`user ${op.user} could not be fetched (refused to be safe)`);
      if (u!.isBot) no(`user ${op.user} is a bot`);
      if (!(await x.w.banned(op.user))) no('that user is not banned');
      return done({ label: 'Unban user', refs: [mention('user', op.user)], old: `banned (${clean(u!.username)})`, neu: withReason('unbanned', op.reason) }, { banned: true });
    }
    case 'automod.create': {
      const code = triggerCode(op.trigger);
      const p = patternsOf(op.trigger);
      plain(x, 'the rule name', op.name);
      for (const w of [...p.keywords, ...p.regex, ...p.allow]) plain(x, 'an AutoMod pattern', w);
      const acts = await checkActions(x, op.actions);
      await checkExempt(x, op.exemptRoles, op.exemptChannels);
      if (op.trigger.type === 'keyword' && !op.trigger.keywords.length && !(op.trigger.regex?.length)) no('a keyword rule needs keywords or regex patterns');
      const rules = await x.w.autoModRules();
      if (!rules) return no('the AutoMod rules could not be read');
      if (rules.some((r) => r.name.trim().toLowerCase() === op.name.trim().toLowerCase())) no('an AutoMod rule with that name already exists');
      const warns = [(op.exemptRoles?.length || op.exemptChannels?.length) ? 'adds an exemption' : '', p.allow.some((a) => a.includes('*')) ? 'has an allow-list entry with a wildcard' : ''].filter(Boolean).join('; ');
      const refs = [...(op.exemptRoles ?? []).map((id) => mention('role', id)), ...(op.exemptChannels ?? []).map((id) => mention('channel', id))];
      return done({ label: 'Create AutoMod rule', refs, old: '(none)', neu: `"${op.name.trim()}" (${op.trigger.type}), ${op.enabled ? 'enabled' : 'disabled'}; actions: ${acts}; exempt (mentions above): roles ${op.exemptRoles?.length ?? 0}, channels ${op.exemptChannels?.length ?? 0}`, detail: describeRule(p), risk: true, ...(warns ? { warn: warns } : {}) }, { exists: false, code });
    }
    case 'automod.edit': {
      const rule = await ruleOf(x, op.rule);
      plain(x, 'the rule name', op.name);
      if (op.trigger) { const q = patternsOf(op.trigger); for (const w of [...q.keywords, ...q.regex, ...q.allow]) plain(x, 'an AutoMod pattern', w); }
      if (op.trigger && triggerCode(op.trigger) !== rule.triggerType) no('the trigger type of a rule cannot change');
      if (op.actions) await checkActions(x, op.actions);
      await checkExempt(x, op.exemptRoles, op.exemptChannels);
      const warns: string[] = [];
      if (op.exemptRoles?.some((r) => !rule.exemptRoles.includes(r)) || op.exemptChannels?.some((c) => !rule.exemptChannels.includes(c))) warns.push('adds an exemption');
      if (op.trigger) {
        const p = patternsOf(op.trigger);
        if (p.allow.some((a) => a.includes('*') && !rule.allow.includes(a))) warns.push('adds an allow-list entry with a wildcard');
        if (p.mentionLimit !== null && rule.mentionLimit !== null && p.mentionLimit > rule.mentionLimit) warns.push('raises the mention limit (the rule is weaker)');
        if (p.mentionLimit !== null && rule.mentionLimit !== null && p.mentionLimit < rule.mentionLimit) warns.push('lowers the mention limit');
      }
      if (op.name === undefined && !op.trigger && !op.actions && !op.exemptRoles && !op.exemptChannels) no('nothing would change');
      return done({ label: 'Edit AutoMod rule', old: `"${clean(rule.name)}" ${describeRule(rule)}`, neu: [op.name ? `name "${op.name}"` : '', op.actions ? `actions: ${await checkActions(x, op.actions)}` : '', op.exemptRoles ? `exempt roles ${op.exemptRoles.length}` : '', op.exemptChannels ? `exempt channels ${op.exemptChannels.length}` : ''].filter(Boolean).join('; ') || 'patterns changed', ...(op.trigger ? { detail: describeRule(patternsOf(op.trigger)) } : {}), risk: true, ...(warns.length ? { warn: warns.join('; ') } : {}) }, snapRule(rule));
    }
    case 'automod.enable': case 'automod.disable': {
      const rule = await ruleOf(x, op.rule);
      const on = op.kind === 'automod.enable';
      if (rule.enabled === on) no(`the rule is already ${on ? 'enabled' : 'disabled'}`);
      return done({ label: on ? 'Enable AutoMod rule' : 'Disable AutoMod rule', old: `"${clean(rule.name)}" ${rule.enabled ? 'enabled' : 'disabled'}`, neu: on ? 'enabled' : 'disabled', risk: !on, ...(on ? {} : { warn: 'switches an AutoMod rule off' }) }, snapRule(rule));
    }
    case 'automod.delete': {
      const rule = await ruleOf(x, op.rule);
      return done({ label: 'Delete AutoMod rule', old: `"${clean(rule.name)}" ${describeRule(rule)}`, neu: 'deleted', risk: true, warn: 'deletes an AutoMod rule' }, snapRule(rule));
    }
    case 'guild.edit': {
      const g = x.guild;
      const old: string[] = [];
      const neu: string[] = [];
      const refs: Ref[] = [];
      if (op.name !== undefined && op.name.trim() !== g.name) {
        if (CONTROL.test(op.name) || MENTION.test(op.name)) no('the server name must not contain mention syntax or control characters');
        plain(x, 'the server name', op.name);
        old.push(`name "${clean(g.name)}"`); neu.push(`name "${op.name.trim()}"`);
      }
      if (op.description !== undefined && (op.description ?? null) !== g.description) {
        if (op.description && (CONTROL.test(op.description) || MENTION.test(op.description))) no('the description must not contain mention syntax or control characters');
        plain(x, 'the description', op.description);
        old.push(`description "${g.description ?? ''}"`); neu.push(`description "${op.description ?? ''}"`);
      }
      for (const [field, cur, label] of [['systemChannel', g.systemChannelId, 'system channel'], ['rulesChannel', g.rulesChannelId, 'rules channel']] as const) {
        const v = op[field];
        if (v === undefined || v === cur) continue;
        if (v !== null) {
          const ch = await editable(x, v, label);
          if (ch.type !== 0) no(`the ${label} must be a text channel`);
          refs.push(mention('channel', ch.id));
        }
        old.push(`${label} ${cur ?? '(none)'}`); neu.push(`${label} ${v ?? '(none)'}`);
      }
      if (!neu.length) no('nothing would change');
      return done({ label: 'Edit server settings', refs, old: old.join('; '), neu: neu.join('; ') }, { name: g.name, description: g.description, system: g.systemChannelId, rules: g.rulesChannelId });
    }
    case 'event.create': {
      const start = Date.parse(op.start);
      const end = op.end ? Date.parse(op.end) : null;
      if (start < x.in.now() + 60_000) no('the event must start at least a minute from now');
      if (start > x.in.now() + 366 * DAY_MS) no('the event is more than a year away');
      if (end !== null && end <= start) no('the event must end after it starts');
      if (CONTROL.test(op.name.replace(/[\n\r\t]/g, '')) || MENTION.test(op.name)) no('the event name must not contain mention syntax');
      plain(x, 'the event name', op.name);
      plain(x, 'the event description', op.description);
      let where: string;
      let refs: Ref[] = [];
      if (op.type === 'external') {
        if (!op.location) no('an external event needs a location');
        if (end === null) no('an external event needs an end time');
        const l = locationProblem(op.location!);
        if ('problem' in l) no(l.problem);
        where = `external, location "${op.location}" (host ${(l as { host: string }).host})`;
      } else {
        if (!op.channel) no(`a ${op.type} event needs a channel`);
        const ch = await editable(x, op.channel!, 'event channel');
        if (ch.type !== (op.type === 'voice' ? 2 : 13)) no(`the channel is not a ${op.type} channel`);
        where = `${op.type} channel`;
        refs = [mention('channel', ch.id)];
      }
      return done({ label: 'Create event', refs, old: '(none)', neu: `"${op.name}" ${where}, ${op.start}${op.end ? ` to ${op.end}` : ''}`, ...(op.description ? { detail: op.description } : {}) }, { exists: false });
    }
    case 'event.edit': case 'event.cancel': {
      const list = await x.w.events();
      if (!list) return no('the scheduled events could not be read');
      const ev = list.find((e) => e.id === op.event);
      if (!ev) no('no such scheduled event');
      if (ev!.status !== 1) no('only a scheduled (not started or finished) event can be changed');
      if (op.kind === 'event.cancel') return done({ label: 'Cancel event', old: `"${clean(ev!.name)}" at ${fmtTs(ev!.start)}`, neu: 'canceled', risk: true }, { name: ev!.name, start: ev!.start });
      const s = op.start ? Date.parse(op.start) : null;
      const e = op.end ? Date.parse(op.end) : null;
      if (s !== null && s < x.in.now() + 60_000) no('the event must start at least a minute from now');
      if ((e ?? ev!.end) !== null && (e ?? ev!.end)! <= (s ?? ev!.start)) no('the event must end after it starts');
      if (op.name && (CONTROL.test(op.name) || MENTION.test(op.name))) no('the event name must not contain mention syntax');
      plain(x, 'the event name', op.name);
      plain(x, 'the event description', op.description);
      if (op.name === undefined && op.description === undefined && s === null && e === null) no('nothing would change');
      return done({ label: 'Edit event', old: `"${clean(ev!.name)}" at ${fmtTs(ev!.start)}`, neu: [op.name ? `name "${op.name}"` : '', s !== null ? `start ${op.start}` : '', e !== null ? `end ${op.end}` : '', op.description !== undefined ? 'description' : ''].filter(Boolean).join('; '), ...(op.description ? { detail: op.description } : {}) }, { name: ev!.name, start: ev!.start, end: ev!.end, description: ev!.description });
    }
    case 'welcome.resume': {
      if (!(await x.in.welcomePaused())) no('the welcome flow is not paused');
      return done({ label: 'Resume welcome', old: 'paused (raid limit)', neu: 'running' }, { paused: true });
    }
  }
}

async function ruleOf(x: SCtx, id: string): Promise<AutoModInfo> {
  const rules = await x.w.autoModRules();
  if (!rules) return no('the AutoMod rules could not be read');
  const r = rules.find((q) => q.id === id);
  if (!r) return no('no such AutoMod rule');
  if (![1, 3, 4, 5].includes(r.triggerType)) no('this rule type (for example member profile) is not managed here');
  return r;
}
const snapRule = (r: AutoModInfo) => ({ enabled: r.enabled, name: r.name, kw: createHash('sha256').update(describeRule(r)).digest('hex').slice(0, 16), ex: [r.exemptRoles, r.exemptChannels] });
const hash8 = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 8);

function bulkItem(ch: ChannelInfo, msgs: MessageInfo[], stored: number, reason: string | undefined): CardItem {
  const by = new Map<string, number>();
  for (const m of msgs) by.set(m.authorId, (by.get(m.authorId) ?? 0) + 1);
  const t = msgs.map((m) => m.createdAt);
  const authors = [...by].map(([id, n]) => `${id} x${n}`).join(', ');
  return {
    label: 'Bulk delete messages', refs: [mention('channel', ch.id)], old: `${msgs.length} of ${stored} stored message(s) can be deleted`,
    neu: withReason(`delete ${msgs.length} message(s) from ${fmtTs(Math.min(...t))} to ${fmtTs(Math.max(...t))}; authors: ${authors} (the text is never shown)`, reason), risk: true,
  };
}

/** All or nothing: the first refused op refuses the card. Never writes. */
export async function checkServerOps(ops: readonly ServerOp[], world: ServerWorld, sc: ServerConsts, input: ServerIn): Promise<ServerChecked> {
  try {
    const problem = constantsProblem(sc);
    if (problem) return { ok: false, error: problem };
    if (ops.length === 0 || ops.length > SERVER_BATCH_MAX) return { ok: false, error: `a proposal has 1 to ${SERVER_BATCH_MAX} operations` };
    if (ops.filter((o) => o.kind === 'member.ban' || o.kind === 'member.kick').length > BAN_KICK_MAX) return { ok: false, error: `at most ${BAN_KICK_MAX} ban or kick targets per card` };
    if (input.tiers) {
      const tp = opsTierProblem(input.tiers.tier, ops);
      if (tp) return { ok: false, error: tp };
    }
    const x = await sctx(world, sc, input);
    const resolved: ResolvedServerOp[] = [];
    for (const [i, op] of ops.entries()) {
      try {
        resolved.push(await checkOne(op, x));
      } catch (e) {
        if (e instanceof Refuse) return { ok: false, error: `operation ${i + 1} (${op.kind}) refused: ${e.message}` };
        throw e;
      }
    }
    return { ok: true, resolved, named: [...input.named] };
  } catch (e) {
    if (e instanceof Refuse) return { ok: false, error: e.message };
    throw e;
  }
}

/** S12: whether a role may be handed to a joining member. Null = yes, else why not (the welcome handler then pauses and alerts). */
export async function welcomeRoleProblem(roleId: string, world: ServerWorld, sc: ServerConsts): Promise<string | null> {
  try {
    const x = await context(world, sc);
    const role = x.roles.get(roleId);
    if (!role) return `role ${roleId} was not found`;
    if (roleId === world.guildId) return '@everyone cannot be a default role';
    if (role.managed) return 'the role is managed by an integration';
    if (x.priv.has(roleId) || roleId === sc.founderRoleId || roleId === sc.botAdminRoleId) return 'the role is Founder, Bot Admin or another privileged role';
    if (role.position >= x.me.topPosition) return 'the role is at or above the executor\'s top role';
    if (x.botRoleIds.has(roleId)) return 'the role is held by a bot';
    if (role.permissions & ~SAFE_CHECK) return 'the role carries powers beyond the safe set';
    for (const sid of sc.systemChannelIds) {
      const sc2 = await readChannel(x, sid);
      if (!sc2) return `system channel ${sid} could not be read (refused to be safe)`;
      if (sc2.overwrites.some((o) => o.type === 'role' && o.id === roleId && (o.allow & WIDEN) !== 0n)) return 'the role is allowed into a system channel';
    }
    return null;
  } catch (e) {
    if (e instanceof Refuse) return e.message;
    throw e;
  }
}
