import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Client, Message } from 'discord.js';
import { createApp, type App, type AppOverrides, type AppServices } from '../../app.js';
import type { OutboundPayload } from '../../agents/loop/payload.js';
import type { ActorRef, IncomingMessage } from '../../company/types.js';
import { DEPT_IDS, type DeptId, type Env, type Logger } from '../../core/index.js';
import { migrate } from '../../db/migrate.js';
import type { Pool } from '../../db/pool.js';
import type { Task } from '../../db/repos/tasks.js';
import { TEST_URL } from '../../db/test-helpers.js';
import { PROMPTS_DIR, loadPrompts } from '../../prompts/index.js';
import { ProviderRegistry, type ChatChunk, type ChatRequest, type FakeTurn, type LLMProvider } from '../../providers/index.js';
import { buildMessage } from '../../discord/embeds/index.js';
import { toIncoming } from '../../discord/inbound.js';
import { FakeForgeDocker } from '../../forge/test-helpers.js';
import { fakeClient, fakeGuild } from '../fakes/discordClient.js';
import { FakeDiscordPort } from '../fakes/discordPort.js';
import type { PostOptions } from '../../discord/port.js';
import type { GroupFactory } from '../../tools/plugins/index.js';
import type { Resolver, Transport } from '../../net/guard.js';
import { fakeResolver, fakeTransport } from '../fakes/net.js';

export const GUILD = '1565649426943442944';
export const ADMIN_ROLE = '1565000000000000001';
export const CONFIG_CHANNEL = '1565667791938387969';
export const BOT_LOG_CHANNEL = '1566454343820124352';
export const AI_WARROOM = '1566366032094961705';
export const HQ_WORK = '1565652605290414160';
export const SOFTWARE_WORK = '1565682159375749161';
export const RND_WORK = '1565651357845692466';
export const MARKETING_WORK = '1565713202405445652';
export const CEO: ActorRef = { kind: 'head', dept: 'hq' };
export const CTO: ActorRef = { kind: 'head', dept: 'software' };
export const SA: ActorRef = { kind: 'persona', personaId: 'system-analyst' };

/** Snowflake bot user (= application) ids of the fake head clients, and one persona webhook id per dept. */
export const BOT_IDS = Object.fromEntries(DEPT_IDS.map((d, i) => [d, `1566000000000000${100 + i}`])) as Record<DeptId, string>;
const HOOK_IDS = Object.fromEntries(DEPT_IDS.map((d, i) => [d, `1567000000000000${100 + i}`])) as Record<DeptId, string>;
export const mentionOf = (d: DeptId) => `<@${BOT_IDS[d]}>`;

const prompts = loadPrompts(PROMPTS_DIR);
/** Actor prompt refs, longest body first so a body that contains another still classifies correctly. */
const ACTOR_REFS = [...prompts.values()].filter((d) => d.ref.startsWith('heads/') || d.ref.startsWith('members/')).sort((a, b) => b.body.length - a.body.length);

export type ScriptTurn = FakeTurn | ((req: ChatRequest) => FakeTurn);

const textOf = (req: ChatRequest): string =>
  req.messages.flatMap((m) => m.content).map((b) => (b.type === 'text' ? b.text : b.type === 'tool_result' ? b.content : '')).join('\n');

/** The id the loop shows the model in its first turn ("Current task (id ...)"). */
export function taskIdOf(req: ChatRequest): string {
  const id = /Current task \(id ([\w-]+)\)/.exec(textOf(req))?.[1];
  if (!id) throw new Error('no task id in the request');
  return id;
}

/** Which actor a request is for: the head/member prompt body inside the system text. */
export function actorOf(req: ChatRequest): string {
  const hit = ACTOR_REFS.find((d) => req.system.includes(d.body));
  if (!hit) throw new Error('request for an unknown actor');
  return hit.ref;
}

/**
 * Like FakeProvider, but with one script per actor (`heads/hq`, `members/system-analyst`, ...), so concurrent
 * runs of different actors cannot consume each other's turns. A turn may be computed from the request.
 */
export class ActorProvider implements LLMProvider {
  readonly id = 'claude';
  readonly calls: { actor: string; req: ChatRequest }[] = [];
  private readonly next = new Map<string, number>();
  private seq = 0;

  constructor(private readonly scripts: Record<string, ScriptTurn[]>) {}

  callsOf(actor: string): ChatRequest[] {
    return this.calls.filter((c) => c.actor === actor).map((c) => c.req);
  }

  /** Script turns not used yet, per actor. */
  remaining(): Record<string, number> {
    return Object.fromEntries(Object.entries(this.scripts).map(([a, s]) => [a, s.length - (this.next.get(a) ?? 0)]));
  }

  async *chat(req: ChatRequest, signal: AbortSignal): AsyncIterable<ChatChunk> {
    const actor = actorOf(req);
    this.calls.push({ actor, req });
    const i = this.next.get(actor) ?? 0;
    this.next.set(actor, i + 1);
    const step = this.scripts[actor]?.[i];
    if (!step) throw new Error(`script exhausted for ${actor}`);
    const turn = typeof step === 'function' ? step(req) : step;
    if (signal.aborted) {
      yield { type: 'stop', reason: 'aborted' };
      return;
    }
    if (turn.text) yield { type: 'text', text: turn.text };
    for (const tu of turn.toolUses ?? []) yield { type: 'tool_use', id: `tu_${++this.seq}`, name: tu.name, input: tu.input };
    yield { type: 'usage', inputTokens: turn.usage?.inputTokens ?? 10, outputTokens: turn.usage?.outputTokens ?? 5, cacheReadTokens: 0, cacheWriteTokens: 0 };
    yield { type: 'stop', reason: turn.toolUses?.length ? 'tool_use' : 'end_turn' };
  }
}

/** Streams nothing until aborted; `started` resolves when the first chat begins. */
export class SlowProvider implements LLMProvider {
  readonly id = 'claude';
  calls = 0;
  private resolveStarted!: () => void;
  readonly started = new Promise<void>((r) => (this.resolveStarted = r));

  async *chat(_req: ChatRequest, signal: AbortSignal): AsyncIterable<ChatChunk> {
    this.calls++;
    this.resolveStarted();
    yield { type: 'text', text: 'thinking…' };
    await new Promise<void>((resolve) => {
      if (signal.aborted) resolve();
      signal.addEventListener('abort', () => resolve(), { once: true });
      setTimeout(resolve, 30_000).unref();
    });
    yield { type: 'stop', reason: 'aborted' };
  }
}

export const respond = (type: OutboundPayload['type'], body: string) => ({ name: 'respond', input: { type, body } });
export const turn = (...toolUses: { name: string; input: unknown }[]): FakeTurn => ({ toolUses });

/** FakeDiscordPort that also records history limits and can loop posts back like the gateway does. */
export class TestPort extends FakeDiscordPort {
  historyLimits: number[] = [];
  onPosted: ((p: FakeDiscordPort['posts'][number]) => void) | null = null;

  override async post(actor: ActorRef, target: { channelId: string; threadId?: string }, payload: OutboundPayload, opts?: PostOptions): Promise<string> {
    const id = await super.post(actor, target, payload, opts);
    this.onPosted?.(this.posts.at(-1)!);
    return id;
  }

  onLogTask: ((t: Task) => void) | null = null;

  override async upsertTaskLog(task: Task, extra?: { blockedBecause?: string }): Promise<void> {
    await super.upsertTaskLog(task, extra);
    this.onLogTask?.(task);
  }

  override async history(id: string, limit: number, reader: ActorRef): Promise<IncomingMessage[]> {
    this.historyLimits.push(limit);
    return super.history(id, limit, reader);
  }
}

export function testEnv(depts: readonly DeptId[] = DEPT_IDS): Env {
  return {
    databaseUrl: TEST_URL,
    configMasterKey: Buffer.alloc(32, 7),
    guildId: GUILD,
    botAdminRoleId: ADMIN_ROLE,
    healthPort: 1,
    healthHost: '127.0.0.1',
    logLevel: 'silent',
    botTokens: Object.fromEntries(depts.map((d) => [d, `token-${d}`])),
    prawWorkspaceDir: join(tmpdir(), `assistant-int-ws-${randomUUID()}`),
  };
}

export type FakeClient = ReturnType<typeof fakeClient>;

export interface BootOptions {
  provider?: LLMProvider;
  /** More providers in the registry (e.g. the fake `gemini` the metered OCR service needs). */
  extraProviders?: LLMProvider[];
  port?: TestPort;
  depts?: readonly DeptId[];
  clients?: Partial<Record<DeptId, FakeClient>>;
  now?: () => number;
  /** schedule.offDays before start; default none, so suites that run on a real weekend clock are not held by the calendar. */
  offDays?: number[];
  start?: boolean;
  /** Boot without a provider override: the app registers its own providers, with this local-provider guard (Gate 1 L9). */
  localGuard?: AppOverrides['localGuard'];
  /** R8 PV-C01: the local-mode input (ALLOW_LOCAL_PROVIDERS in the real process env) as a seam, so a test never mutates process.env. */
  localMode?: boolean;
  /** APPROVAL-BATCH-1: off by default in the int suite (cards are posted at once); a batching test opts in with `{ windowMs }`. */
  approvalBatching?: AppOverrides['approvalBatching'];
  env?: Partial<Env>;
  /** WS-1: the docker port and images dir for the workspace boot (a test with env.wsRoot must not call the real Docker). */
  ws?: { docker?: import('../../workspaces/runner.js').DockerCli; imagesDir?: string };
  /** R6 MCP-1: the docker port and spawner for the MCP boot (a test must never reach the real Docker). */
  mcp?: AppOverrides['mcp'];
  /** R7 PLUGIN-FORGE: the docker port, images dir, stage root and timer periods of the plugin forge (a test must never reach the real Docker). */
  forge?: AppOverrides['forge'];
  /** Extra plugin group factories (stub tools). */
  groups?: GroupFactory[];
  /** Guarded-fetch fakes; default resolves nothing, so int tests can never reach a real network through fetch_page/web_search. */
  net?: { resolver: Resolver; transport: Transport };
  /** Injected `fetch` for the fixed-base-URL vendor clients (ClickUp); tests pass tests/fakes/http.ts. */
  fetch?: typeof fetch;
  /** Replaces the app logger (tests capture the log lines). */
  logger?: Logger;
  /** Boot binaries check (P22); default: the fake yt-dlp/ffmpeg scripts with their own sha256, so no real binary is ever run. */
  /** null: no override at all, so createApp's own selection runs (env.mediaSocket, the real container check). */
  binaries?: AppOverrides['binaries'] | null;
  /** Voice seams (fake session, channel check, member voice channel) and the fake binaries' FAKE_* switches for music (T36). */
  voice?: AppOverrides['voice'];
  musicEnv?: AppOverrides['musicEnv'];
  /** Replaces the media backend (a SocketMediaBackend over an in-process sidecar); `binaries` and `musicEnv` then go unused. */
  media?: AppOverrides['media'];
}

const FAKE_BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'fakes', 'bin');
const fileSha = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex');
/** Binaries check options over tests/fakes/bin; `expectedSha256` overrides let a test plant a mismatch. */
export function fakeBinaries(over: Partial<{ ytDlp: string; ffmpeg: string }> = {}): NonNullable<AppOverrides['binaries']> {
  const ytDlp = join(FAKE_BIN, 'yt-dlp');
  const ffmpeg = join(FAKE_BIN, 'ffmpeg');
  return { ytDlp, ffmpeg, expectedSha256: { ytDlp: over.ytDlp ?? fileSha(ytDlp), ffmpeg: over.ffmpeg ?? fileSha(ffmpeg) } };
}

export interface Booted {
  app: App;
  port: TestPort;
  clients: Record<string, FakeClient>;
}

/** createApp over the test pool with fake Discord clients and port; started unless `start: false`. */
export async function boot(pool: Pool, o: BootOptions = {}): Promise<Booted> {
  const port = o.port ?? new TestPort();
  const providers = o.localGuard ? undefined : new ProviderRegistry();
  if (o.provider) providers?.register(o.provider);
  for (const p of o.extraProviders ?? []) providers?.register(p);
  const clients: Record<string, FakeClient> = {};
  const createClient = (d: DeptId): Client => (clients[d] = o.clients?.[d] ?? fakeClient({ userId: BOT_IDS[d], guild: fakeGuild() }));
  const app = await createApp({ ...testEnv(o.depts), ...o.env }, {
    pool, port, createClient, healthPort: 0, approvalBatching: o.approvalBatching ?? false, ...(providers ? { providers } : { localGuard: o.localGuard! }), ...(o.localMode !== undefined ? { localMode: o.localMode } : {}), ...(o.now ? { now: o.now } : {}), ...(o.logger ? { logger: o.logger } : {}), ...(o.groups ? { groups: o.groups } : {}), ...(o.fetch ? { fetch: o.fetch } : {}),
    net: o.net ?? { resolver: fakeResolver({}), transport: fakeTransport({}) },
    ...(o.binaries === null ? {} : { binaries: o.binaries ?? fakeBinaries() }),
    ...(o.ws ? { ws: o.ws } : {}),
    ...(o.mcp ? { mcp: o.mcp } : {}),
    // R7: a test never reaches the real Docker or the real stage root; a test that turns the forge on passes its own docker and scratch root
    forge: o.forge ?? { docker: new FakeForgeDocker(), stageRoot: join(tmpdir(), `assistant-int-forge-${randomUUID()}`) },
    ...(o.voice ? { voice: o.voice } : {}), ...(o.musicEnv ? { musicEnv: o.musicEnv } : {}), ...(o.media ? { media: o.media } : {}),
  });
  await app.services.cfg.set('schedule.offDays', o.offDays ?? [], 'test');
  if (o.start !== false) await app.start();
  return { app, port, clients };
}

/** Applies the migrations (createApp does too) so a test can prepare rows before booting. */
export async function migrateUp(pool: Pool): Promise<void> {
  await migrate(pool, join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'db', 'migrations'), 'up');
}

/** Wipes every table between tests (the schema and migrations stay). */
export async function resetDb(pool: Pool): Promise<void> {
  await pool.query(`TRUNCATE approvals, budget_days, audit_log, dept_notes, tasks, config, prompt_overrides, provider_keys,
    persona_webhooks, channel_map, personas, departments, music_state, bot_messages, kb_review_runs, room_entries, board_messages RESTART IDENTITY CASCADE`);
}

export function humanMsg(content: string, over: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    id: randomUUID(), channelId: SOFTWARE_WORK, parentChannelId: null, threadId: null,
    author: { id: '42', name: 'owner', kind: 'human' }, content, mentionedHeads: [], isAdmin: false, attachments: [], origin: 'chat', ...over,
  };
}

export function botMsg(actor: ActorRef, content: string, over: Partial<IncomingMessage> = {}): IncomingMessage {
  const name = actor.kind === 'head' ? actor.dept : actor.personaId;
  return humanMsg(content, { author: { id: `bot-${name}`, name, kind: actor.kind, actor }, ...over });
}

type Posted = FakeDiscordPort['posts'][number];

/**
 * What the gateway would deliver for a post: the payload rendered by the real embed builder (embed-only, like the
 * live bots), wrapped as a discord.js message from our head bot or persona webhook, then mapped by the real
 * `toIncoming` (R30: content and head mentions come from the embeds). One message per rendered Discord message.
 */
export function gatewayEcho(p: Posted, s: Pick<AppServices, 'org' | 'clients'>): IncomingMessage[] {
  const persona = p.actor.kind === 'persona' ? s.org.persona(p.actor.personaId) : null;
  const dept = (persona ? persona.deptId : (p.actor as { dept: DeptId }).dept) as DeptId;
  const threadId = p.target.threadId ?? null;
  const rendered = buildMessage(p.payload, { deptColor: 0, adminRoleId: ADMIN_ROLE });
  const out: IncomingMessage[] = [];
  rendered.forEach((r, i) => {
    const m = {
      id: i === 0 ? p.id : `${p.id}-${i}`,
      guildId: GUILD,
      channelId: threadId ?? p.target.channelId,
      channel: { id: threadId ?? p.target.channelId, isThread: () => threadId !== null, parentId: threadId ? p.target.channelId : null },
      author: persona ? { id: HOOK_IDS[dept], username: persona.name, bot: true, globalName: null } : { id: BOT_IDS[dept], username: dept, bot: true, globalName: null },
      member: null,
      webhookId: persona ? HOOK_IDS[dept] : null,
      applicationId: persona ? BOT_IDS[dept] : null,
      content: r.content ?? '',
      embeds: r.embeds,
      mentions: { users: new Map() },
      attachments: new Map(),
    } as unknown as Message;
    const mapped = toIncoming(m, {
      guildId: GUILD,
      adminRoleId: ADMIN_ROLE,
      botUserIds: s.clients.botUserIds(),
      webhooks: new Map([[HOOK_IDS[dept], { applicationId: BOT_IDS[dept], deptId: dept }]]),
      personaByName: (d, n) => s.org.personaByName(d, n)?.id ?? null,
    });
    if (mapped) out.push(mapped);
  });
  return out;
}
