import { Org } from '../../company/org.js';
import { SEED_DEPARTMENTS, type OrgRepos } from '../../company/seed.js';
import { CONFIG_DEFAULTS } from '../../config/defaults.js';
import { ConfigSchema, type ConfigKey, type ConfigValue } from '../../config/schema.js';
import { createLogger } from '../../core/logger.js';
import type { ChannelMapping, Department, Persona, PromptOverride, ProviderKey } from '../../db/repos/index.js';
import type { PromptDoc } from '../../prompts/index.js';
import { CONFIG_CHANNEL_ID, type CommandDeps, type InteractionLike, type ModalSpec, type Reply } from './types.js';

export const GUILD = '1565649426943442944';
export const ADMIN_ROLE = '1565000000000000001';
export const MASTER_KEY = Buffer.alloc(32, 7);

export interface Call {
  commandName?: string;
  subcommand?: string | null;
  customId?: string;
  kind?: 'command' | 'button' | 'modal';
  guildId?: string | null;
  channelId?: string | null;
  roles?: string[];
  userId?: string;
  id?: string;
  userIsBot?: boolean;
  parentChannelId?: string | null;
  strings?: Record<string, string>;
  numbers?: Record<string, number>;
  bools?: Record<string, boolean>;
  channels?: Record<string, { id: string; parentId: string | null }>;
  fields?: Record<string, string>;
  messageId?: string | null;
  messageAuthorId?: string | null;
  attachments?: Record<string, { url: string; name: string; size: number; contentType: string | null }>;
}

export type FakeInteraction = InteractionLike & { replies: Reply[]; modals: ModalSpec[]; deferred: { ephemeral: boolean } | null; edits: Reply[]; followUps: Reply[]; deletedReply: boolean };

let seq = 0;
export function interaction(c: Call): FakeInteraction {
  const kind = c.kind ?? 'command';
  const replies: Reply[] = [];
  const modals: ModalSpec[] = [];
  const edits: Reply[] = [];
  const self: FakeInteraction = {
    replies, modals, edits, deferred: null, followUps: [], deletedReply: false,
    guildId: c.guildId === undefined ? GUILD : c.guildId,
    channelId: c.channelId === undefined ? CONFIG_CHANNEL_ID : c.channelId,
    userId: c.userId ?? 'u1',
    id: c.id ?? `i${++seq}`,
    userName: 'Tester',
    userIsBot: c.userIsBot ?? false,
    parentChannelId: c.parentChannelId ?? null,
    memberRoleIds: c.roles ?? [ADMIN_ROLE],
    messageId: c.messageId ?? null,
    messageAuthorId: c.messageAuthorId ?? null,
    isChatInputCommand: () => kind === 'command',
    isButton: () => kind === 'button',
    isModalSubmit: () => kind === 'modal',
    commandName: c.commandName ?? '',
    subcommand: c.subcommand ?? null,
    options: {
      string: (n) => c.strings?.[n] ?? null,
      number: (n) => c.numbers?.[n] ?? null,
      integer: (n) => c.numbers?.[n] ?? null,
      boolean: (n) => c.bools?.[n] ?? null,
      channel: (n) => c.channels?.[n] ?? null,
      attachment: (n) => c.attachments?.[n] ?? null,
    },
    customId: c.customId ?? '',
    field: (id) => c.fields?.[id] ?? null,
    reply: async (r) => { replies.push(r); },
    deferReply: async (o) => { self.deferred = o; },
    editReply: async (r) => { edits.push(r); },
    followUp: async (r) => { self.followUps.push(r); },
    deleteReply: async () => { self.deletedReply = true; },
    showModal: async (m) => { modals.push(m); },
  };
  return self;
}

export const cmd = (name: string, sub: string | null, o: Omit<Call, 'commandName' | 'subcommand'> = {}) => interaction({ commandName: name, subcommand: sub, ...o });
export const text = (r: Reply | null) => JSON.stringify(r?.embeds ?? []) + (r?.content ?? '');

const dept = (id: string): Department => ({ id, name: id, categoryNamePattern: id, workChannelId: SEED_DEPARTMENTS.find((d) => d.id === id)?.workChannelId ?? null, color: 0x3498db, model: null, provider: null, enabled: true });

export function memoryRepos() {
  const depts = new Map(['hq', 'software', 'rnd'].map((id) => [id, dept(id)]));
  const personas = new Map<string, Persona>();
  const channels = new Map<string, ChannelMapping>();
  const overrides: PromptOverride[] = [];
  const keys = new Map<string, ProviderKey>();
  const activeOf = (ref: string) => overrides.filter((o) => o.ref === ref && o.active).sort((a, b) => b.version - a.version)[0] ?? null;
  return {
    depts, personas, channels, overrides, keys,
    departments: { get: async (id: string) => depts.get(id) ?? null, list: async () => [...depts.values()], upsert: async (d: Department) => { depts.set(d.id, d); } },
    personaRepo: {
      get: async (id: string) => personas.get(id) ?? null, list: async () => [...personas.values()],
      upsert: async (p: Persona) => { personas.set(p.id, p); }, delete: async (id: string) => { personas.delete(id); },
    },
    channelMap: {
      get: async (id: string) => channels.get(id) ?? null, list: async () => [...channels.values()],
      upsert: async (m: ChannelMapping) => { channels.set(m.channelId, m); }, delete: async (id: string) => { channels.delete(id); },
    },
    overrideRepo: {
      getActive: async (ref: string) => activeOf(ref),
      upsert: async (ref: string, body: string, by: string | null) => {
        const v = Math.max(0, ...overrides.filter((o) => o.ref === ref).map((o) => o.version)) + 1;
        overrides.forEach((o) => { if (o.ref === ref) o.active = false; });
        overrides.push({ id: overrides.length + 1, ref, body, version: v, createdBy: by, createdAt: new Date(), active: true, tombstone: false, restoredFrom: null });
      },
      delete: async (ref: string) => { overrides.forEach((o) => { if (o.ref === ref) o.active = false; }); },
    },
    providerKeys: { upsert: async (k: ProviderKey) => { keys.set(k.provider, k); } },
  };
}

export async function makeDeps(over: Partial<CommandDeps> = {}) {
  const mem = memoryRepos();
  mem.personas.set('system-analyst', {
    id: 'system-analyst', deptId: 'software', name: 'System Analyst', avatarUrl: null, promptRef: 'members/system-analyst',
    model: null, provider: null, tools: ['respond'], directChannelId: null, enabled: true,
  });
  const prompts = new Map<string, PromptDoc>([
    ['members/system-analyst', { ref: 'members/system-analyst', meta: { name: 'System Analyst', role: 'SA', dept: 'software', tools: ['respond'], traits: ['precise'], fragments: [] }, body: 'You analyse systems.' }],
  ]);
  const org = await Org.load({ departments: mem.departments, personas: mem.personaRepo, channelMap: mem.channelMap } as unknown as OrgRepos, prompts);
  const store = new Map<ConfigKey, unknown>();
  const sets: { key: string; value: unknown; by: string }[] = [];
  const cfg = {
    get: <K extends ConfigKey>(k: K) => (store.has(k) ? store.get(k) : CONFIG_DEFAULTS[k]) as ConfigValue<K>,
    set: async <K extends ConfigKey>(k: K, v: ConfigValue<K>, by: string) => {
      const parsed = ConfigSchema[k].parse(v) as ConfigValue<K>;
      const old = cfg.get(k);
      store.set(k, parsed);
      sets.push({ key: k, value: parsed, by });
      return { old, new: parsed };
    },
  };
  const calls: string[] = [];
  const decisions: { id: number; decision: string; user: { id: string; isAdmin: boolean } }[] = [];
  const logLines: string[] = [];
  const log = createLogger('debug', { destination: { write: (s: string) => { logLines.push(s); } } });
  const audits: unknown[] = [];
  const deps: CommandDeps = {
    guildId: GUILD, adminRoleId: ADMIN_ROLE, masterKey: MASTER_KEY, cfg, org,
    repos: { departments: mem.departments, personas: mem.personaRepo, channelMap: mem.channelMap, overrides: mem.overrideRepo, providerKeys: mem.providerKeys },
    prompts,
    halt: { halt: async (by) => { calls.push(`halt:${by}`); return 2; }, resume: async (by) => { calls.push(`resume:${by}`); } },
    approvals: {
      decide: async (id, decision, user) => { decisions.push({ id, decision, user }); return { ok: true, approval: { id } as never }; },
      resumeApproved: async () => { calls.push('resumeApproved'); return 3; },
    },
    budget: { usage: async (day) => (day === '2026-10-31' ? [{ day, scope: 'company', scopeId: '', reservedUsd: 0, spentUsd: 1.5 }, { day, scope: 'bot', scopeId: 'head:hq', reservedUsd: 0.1, spentUsd: 0.5 }] : []) },
    audit: async (e) => { audits.push(e); },
    providers: { has: (id) => id === 'claude' },
    tools: { plugins: () => ['web_search', 'fetch_page', 'clickup_create_task'] },
    log,
    now: () => new Date('2026-10-31T12:00:00Z'),
    ...over,
  };
  return { deps, mem, org, sets, calls, decisions, logLines, audits };
}
