import { readFileSync } from 'node:fs';
import { modeNeedsNotice } from './tools/plugins/clickup/mode-notice.js';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Client } from 'discord.js';
import { Scheduler, type AgentDeps } from './agents/index.js';
import { TaskRuns } from './agents/tasks/task-runs.js';
import { NonceStore } from './discord/commands/task-nonce.js';
import { Meetings } from './agents/team/meetings.js';
import { BotRoots } from './governance/botroots.js';
import { createConversation } from './agents/conversation.js';
import { approvedTools } from './agents/loop/approved-tools.js';
import { approvedToolContext } from './agents/loop/loop.js';
import { PrawRateLimit } from './agents/call/rate.js';
import { VisionCap } from './agents/loop/vision.js';
import { TaskBoard, renderStatus } from './agents/tasks/task-board.js';
import { createHealActions } from './agents/tasks/heal-actions.js';
import { Healer } from './agents/tasks/healer.js';
import { WeeklyRetro } from './grow/retro.js';
import { IncidentSweep } from './grow/incident-sweep.js';
import { ToolIdeaService } from './grow/tool-ideas.js';
import { ToolRequestService } from './grow/tool-requests.js';
import { ReleaseService, releaseCommandDeps, releaseDigestDeps } from './releases/service.js';
import { ReleaseRepo } from './db/repos/releases.js';
import { CATALOG_DIGEST } from './tools/manifest/catalog.js';
import { AiDigest } from './agents/tasks/ai-digest.js';
import { retryBlocked } from './agents/tasks/retry.js';
import { Rhythm } from './agents/team/rhythm.js';
import { MediaJobRepo, MediaUsageRepo } from './db/repos/media.js';
import { MediaJobService } from './tools/plugins/media/jobs.js';
import { createGeminiMedia, type MediaClient } from './providers/gemini/media.js';
import { createMeteredModel } from './agents/call/metered.js';
import { localDay } from './company/calendar.js';
import { createCalendar, Org, seed, type OffDayWatch, type OrgRepos } from './company/index.js';
import { ConfigStore } from './config/index.js';
import { createLogger, EventBus, IncidentError, IncidentReporter, type AppEvents, type DeptId, type Env, type Logger } from './core/index.js';
import {
  AuditRepo, ChannelMapRepo, ConfigRepo, createPool, DepartmentRepo, DeptNoteRepo, migrate, PersonaRepo, PersonaWebhookRepo, PromptOverrideRepo,
  BoardMessageRepo, DailyRunRepo, DeptIncidentRepo, GuardStateRepo, HealRepo, RetroRepo, ToolIdeaRepo, ToolRequestRepo, ProviderKeyRepo, TaskRepo, type Persona, type Pool,
} from './db/index.js';
import {
  ClientManager, createDiscordPort, createInboundMapper, HqPresence, prawCommandDeps, restoreCustomPrompts, WebhookSender, type CommandDeps, type PrawCommandDeps, type DiscordPort,
} from './discord/index.js';
import { decryptSecret } from './config/secrets.js';
import { Approvals, Budget, createAudit, Halt, Limits } from './governance/index.js';
import { bindSpendStop, effectiveDeptCap, spendReport, spendView, SpendAlerts, SpendOverrides, SpendRepo, SpendWatch, summaryRenderer } from './governance/spend/spend.js';
import { CONFIG_CHANNEL_ID } from './discord/commands/types.js';
import { ApprovalBatching } from './governance/approval/approval-batches.js';
import { AiApprover } from './governance/ai-approver.js';
import { AiApproverRepo } from './db/repos/ai-approver.js';
import { ProjectRepo } from './db/repos/projects.js';
import { SkillAiRepo } from './db/repos/skill-ai.js';
import { SkillJudge } from './governance/skill-judge.js';
import { ApprovalBatchRepo } from './db/repos/approval-batches.js';
import { WebGrantRepo } from './db/repos/web-grants.js';
import { TaskGrantRepo, type TaskGrant, type TaskRevokeReason } from './db/repos/task-grants.js';
import { TaskGrantCards } from './discord/approval/task-grant-cards.js';
import { taskGrantCardText, taskGrantEndedText } from './discord/embeds/approval.js';
import { makeTaskGrantOffer } from './discord/approval/task-grant-offer.js';
import { assertTreeGrantScope } from './tools/tree-grant-scope.js';
import { isConversationTask } from './agents/conversation.js';
import { QuestionRepo } from './db/repos/questions.js';
import { OtRequestRepo, type OtRequest } from './db/repos/ot-requests.js';
import { LlmUsageRepo, QuotaRepo } from './db/repos/quota.js';
import { QuotaStore, resetText } from './governance/quota/quota.js';
import { FallbackGate } from './providers/fallback-gate.js';
import { alertApiBusy, alertApiOff, alertTaskRefused, usageBackupLine } from './providers/fallback-text.js';
import { fallbackEnabled } from './providers/route.js';
import { OtService } from './governance/spend/ot.js';
import { compactItemFits, otGrantedPayload, otRequestPayload, soloShowsWhole } from './discord/embeds/approval.js';
import { approvalBatchHooks } from './discord/commands/approval.js';
import { startHealth, type HealthServer } from './health.js';
import { loadPrompts, PROMPTS_DIR, protectedDocs, type PromptDoc } from './prompts/index.js';
import {
  adaptGenAi, createClaudeCodeLocalProvider, createClaudeProvider, createGeminiProvider, inContainer, localFlagOk, localModeOf, localOffByOwner, LOCAL_PROVIDER_ID, localProviderAllowed, toLocalModel, nodeGuardExec, nodeGuardFs, processGuardEnv, ProviderRegistry,
  type GuardResult,
} from './providers/index.js';
import { ReminderRepo } from './db/repos/reminders.js';
import { JobRepo } from './db/repos/jobs.js';
import { WatchRepo } from './db/repos/watches.js';
import { ClickUpSeenRepo } from './db/repos/praw.js';
import { ClickUpWriteUsage } from './db/repos/clickup-write-usage.js';
import { AdminCardRepo } from './db/repos/adminCards.js';
import { AdminConsole } from './admin/console.js';
import { ExecutorClient } from './admin/executor-port.js';
import { OutboxPump } from './admin/outbox.js';
import { ExecRepo } from './db/repos/exec.js';
import { PermissionFlagsBits } from 'discord.js';
import { SettingsRegistry } from './admin/settings.js';
import { SettingsPanel } from './admin/panel.js';
import { createPanelPort } from './discord/panel-port.js';
import { DashboardRepo, PanelStateRepo } from './db/repos/dashboard.js';
import { bootDashboard, dashboardPortFrom, type RunningDashboard } from './dashboard/boot.js';
import { ADMIN_READ_KEYS } from './admin/keys.js';
import { DENIED_CHANNEL_IDS } from './company/denylist.js';
import { BOT_LOG_CHANNEL_ID } from './discord/index.js';
import { ApprovalRooms, isNonSensitiveTool } from './discord/approval/approval-rooms.js';
import { adminTools } from './admin/tools.js';
import { DevJobRepo } from './db/repos/devjobs.js';
import { loadImages, localSource, proxyControl, type ControlFetch } from './devjob/boot.js';
import { DockerSandbox, realDocker } from './devjob/launcher.js';
import { DevJobService } from './devjob/service.js';
import { makeSupplyPort, type FetchLike } from './devjob/supply-net.js';
import { DeployRepo } from './db/repos/deploy.js';
import { packWorkspaceDir } from './vps/site.js';
import { LessonRepo } from './db/repos/lessons.js';
import { MusicStateRepo } from './db/repos/music.js';
import { BotMessageRepo } from './db/repos/botMessages.js';
import { RoomEntryRepo } from './db/repos/room-entries.js';
import { TeamTalk } from './agents/team/teamtalk.js';
import { WatchPoller } from './tools/plugins/watch/poller.js';
import { ddgBackend } from './tools/plugins/web/webSearch.js';
import { bootWeb } from './tools/plugins/web/boot.js';
import { unavailableBrowser } from './tools/plugins/web/browser.js';
import { bootRenderer } from './tools/plugins/docs/boot.js';
import { systemResolver, systemTransport } from './net/system.js';
import { JobRunner } from './tools/plugins/schedule/runner.js';
import { ReminderWorker } from './tools/plugins/reminders/worker.js';
import { createHttpClient } from './services/http.js';
import { createClickUpClient, TeamError, teamsEventAudit, teamsEventNotice, type TeamsEvent } from './tools/plugins/clickup/client.js';
import { githubFromEnv } from './tools/plugins/github/client.js';
import { ClickUpPoller, resolveNotifyChannel } from './tools/plugins/clickup/poller.js';
import { bootWorkspaces } from './workspaces/boot.js';
import { ProjectFiles } from './workspaces/files.js';
import { SlugLock } from './workspaces/lock.js';
import { WsService } from './workspaces/service.js';
import { realDockerCli, type DockerCli } from './workspaces/runner.js';
import { McpAdmin, forgeStageDeps, mcpCommandDeps, mcpDigestDeps } from './mcp/admin.js';
import { ForgeRepo } from './db/repos/forge.js';
import { GC_MS, TICK_MS } from './forge/caps.js';
import { makeForgeRequestPort } from './forge/port.js';
import { ForgeService, findForgeImagesFile, forgeCommandDeps, forgeDigestDeps, loadBaseId, type ForgeNotice } from './forge/service.js';
import { bootMcp } from './mcp/boot.js';
import { McpHost } from './mcp/host.js';
import { quarantineConfig } from './mcp/quarantine.js';
import type { McpSpawner } from './mcp/rpc.js';
import { StuckLatch, realMcpSpawner } from './mcp/sandbox.js';
import { Slots } from './mcp/slots.js';
import { createMcpToolFactory } from './mcp/tool.js';
import { McpRepo } from './db/repos/mcp.js';
import { WorkspaceRepo } from './db/repos/workspaces.js';
import { assertDeclared, assertRegistryDeclared, MAIN_GROUPS } from './tools/manifest/assert.js';
import { registerGroups, pluginGroups, type GroupFactory, type PluginDeps } from './tools/plugins/index.js';
import { KnowledgeService } from './knowledge/service.js';
import { createClassifier } from './knowledge/classifier.js';
import { SkillRepo } from './db/repos/skills.js';
import { SkillService } from './skills/service.js';
import { seedSkills } from './skills/seed.js';
import { SEED_SKILLS } from './skills/seed-data.js';
import { createKnowledgePanel } from './knowledge/dashboard.js';
import { KbRepo, KnowledgeStateRepo, ProposalRepo } from './db/repos/knowledge.js';
import { createReflector } from './agents/review/reflect.js';
import { SelfReview } from './agents/review/selfReview.js';
import { ProjectService } from './governance/projects.js';
import { AutopilotService, CAP_NOTICE_TITLE, capNoticeBody } from './governance/autopilot.js';
import { GROW_TOOL_NAMES, growTools, RELEASE_TOOL_NAMES, releaseToolDeps, releaseTools, PROJECT_TOOL_NAMES, projectTools, SKILL_TOOL_NAMES, skillTools, KNOWLEDGE_TOOL_NAMES, knowledgeTools, builtinTools, createToolPolicy, ToolRegistry, unknownPromptTools } from './tools/index.js';
import { startApp } from './app-start.js';
import { LocalMediaBackend, type MediaBackend } from './media/backend.js';
import { SocketMediaBackend } from './media/client.js';
import { selectMediaBackend } from './media/select.js';
import { bootMedia, PINNED_BINARIES, pinnedFor, prawMusicPlayer, prawVoiceChannelOf, prawVoiceChat, prawVoiceManager, type CheckBinariesOptions, type Tts, type VoiceManager, type VoiceManagerDeps } from './voice/index.js';
import type { MusicPlayer } from './voice/music/index.js';

export interface AppOverrides {
  port?: DiscordPort;
  providers?: ProviderRegistry;
  /** An existing pool (tests: a private schema); it is not ended by stop(). */
  pool?: Pool;
  /** ClientManager seam (fake discord.js clients). */
  createClient?: (dept: DeptId) => Client;
  /** Clock for the hq-offline grace (D9) and the human rate limit (D13). */
  now?: () => number;
  /** Health port; 0 picks a free one. Defaults to env.healthPort. */
  healthPort?: number;
  /** APPROVAL-BATCH-1: `false` posts every approval card at once (tests); `{ windowMs }` sets the batch window; unset: batching on with BATCH_WINDOW_MS. */
  approvalBatching?: false | { windowMs: number };
  logger?: Logger;
  /** Local-provider guard seam (Gate 1 L9); default checks the real process env, fs and `claude --version`. Unused with `providers`. */
  localGuard?: () => Promise<GuardResult>;
  /**
   * R8 PV-C01: whether this is local mode (ALLOW_LOCAL_PROVIDERS=1 in the real process env, or the local guard passed). Default: read from there. A seam so a test
   * never mutates process.env. The VPS is never local mode: it never seeds and never refuses the code default.
   */
  localMode?: boolean;
  /** Extra plugin group factories (tests register stub tools here). */
  groups?: GroupFactory[];
  /** Resolver/transport for the guarded web fetch (net/guard); default real DNS and sockets. Tests pass fakes. */
  net?: PluginDeps['net'];
  /** Gate 1 Part C: replaces the Chrome boot (tests); default reads env.chrome (CHROME_CDP_URL) and checks the container. */
  web?: Parameters<typeof bootWeb>[2];
  /** RFMD P3 (RF15): replaces the document renderer boot (tests); default reads env.render (RENDER_CDP_URL) and checks the separate renderer container. */
  render?: Parameters<typeof bootRenderer>[2];
  /** RFMD P5: replaces the Imagen/Veo client (tests); default is built from the Gemini key, and the media group is off without one. */
  mediaClient?: MediaClient;
  /** fetch for fixed-base-URL vendor clients (ClickUp, later GitHub); tests pass tests/fakes/http.ts, production leaves it unset. */
  fetch?: typeof fetch;
  /** CLICKUP-ALL-1: replaces the rate limiter's sleep in workspace mode (tests); production leaves it unset. */
  clickupSleep?: (ms: number) => Promise<void>;
  /** Praw's workspace root (P18); default env.prawWorkspaceDir resolved against the working directory. */
  workspaceRoot?: string;
  /** WS-1: project workspaces. `root` sets WS_ROOT (tests). With `providers` (or `localGuard`, the other test seam) set and neither `root` nor env WS_ROOT, the workspace boot is skipped (ws stays off) so a test run never creates a folder under the real home and never sweeps the real Docker's ws containers. */
  ws?: { root?: string; /** The docker port (tests inject a fake; default: the real docker CLI). */ docker?: DockerCli; /** Directory that holds docker/ws/images.json (tests). */ imagesDir?: string };
  /** R6 MCP-1: the docker port and the stdio spawner of the MCP sandbox (tests inject fakes; the default is the real docker CLI). Nothing here is called while `mcp.enabled` is off. */
  mcp?: { docker?: Pick<DockerCli, 'exec'>; spawn?: McpSpawner };
  /** R7 PLUGIN-FORGE: the docker port of the plugin builder (tests inject a fake; the default is the real docker CLI, touched only while `forge.enabled` is on), the directory that holds docker/forge/images.json, the stage root, and the timer periods. */
  forge?: { docker?: Pick<DockerCli, 'exec'>; imagesDir?: string; stageRoot?: string; tickMs?: number; gcMs?: number };
  /** Boot media-binaries check (P22) overrides; default the pinned /opt/yt-dlp and /opt/ffmpeg/ffmpeg. Tests pass tests/fakes/bin. */
  binaries?: Partial<CheckBinariesOptions>;
  /** Replaces the media backend wholesale (tests: a SocketMediaBackend over an in-process sidecar). Wins over `binaries`; with either, selectMediaBackend is skipped. */
  media?: MediaBackend;
  /** Voice seams (tests: a fake session, a channel check and the member's voice channel); default Praw's real client. */
  voice?: Partial<Pick<VoiceManagerDeps, 'createSession' | 'checkChannel'>> & { voiceChannelOf?: (userId: string) => Promise<string | null>; tts?: Tts };
  /** Extra child env for the local music binaries: tests only (the fake yt-dlp's FAKE_* switches); childEnv still refuses secret names (P8). Never sent to a sidecar. */
  musicEnv?: Record<string, string>;
  /** Local dashboard seams (tests). Default: local mode is ALLOW_LOCAL_PROVIDERS=1 in the real process env, the container check is the providers' one, the port is DASHBOARD_PORT or 8787. */
  dashboard?: { local?: boolean; inContainer?: () => string | null; port?: number; envDir?: string };
}

export interface AppServices {
  /** The literal secrets masked everywhere (a stored Gemini key joins after decryption). Read-only for callers. */
  secrets: readonly string[];
  scheduler: Scheduler;
  /** TASKADMIN-1: the stop signal shared by the agent loops (AgentDeps.taskRuns) and the /task commands. */
  taskRuns: TaskRuns;
  jobRunner: JobRunner;
  cfg: ConfigStore;
  halt: Halt;
  approvals: Approvals;
  /** APPROVAL-BATCH-1: absent when batching is off. */
  batching?: ApprovalBatching;
  budget: Budget;
  tasks: TaskRepo;
  org: Org;
  port: DiscordPort;
  clients: ClientManager;
  presence: HqPresence;
  commands: CommandDeps;
  /** Praw's own command path deps (what the praw client's interactions are handled with). */
  prawCommands: PrawCommandDeps;
  providers: ProviderRegistry;
  /** USAGE-1 / OPS-HOLD: the Claude subscription quota store (tests publish snapshots through it). */
  quota: QuotaStore;
  /** R8 PROV-FALLBACK: the Claude API backup gate. */
  fallback: FallbackGate;
  /** Praw's one voice channel (M5); leaves on /halt. */
  voice: VoiceManager;
  /** Admin console (Praw in #setting): proposals, the confirm click and the card sweep. */
  adminConsole: AdminConsole;
  /** R6 MCP-1: read-only state of the external tool host (never the admin): whether the boot succeeded and which tool names are live. */
  mcp: { booted(): boolean; names(): readonly string[] };
  /** Task 36: the music queue and player; null when the media check disabled music (P22). */
  music: MusicPlayer | null;
  /** Base URL of the health server once started. */
  healthUrl(): string | null;
  /** Base URL of the local dashboard (127.0.0.1) once started; null outside local mode. */
  dashboardUrl(): string | null;
  /** Re-checks the off-day calendar now (the watch also polls every minute); resolves once work released by a day turn is scheduled. */
  offDayTick(): Promise<void>;
}

export interface App {
  start(): Promise<void>;
  stop(): Promise<void>;
  readonly services: AppServices;
}

/** P18: created lazily with mode 0700 on first use (in the image this is the praw-workspace volume). */
const DEFAULT_WORKSPACE_DIR = 'data/workspace/praw';
const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'db', 'migrations');
/** Spec §5 with R-L1: the default set on the first boot where only the local provider is available. */
const FIRST_LOCAL_DEFAULT = { provider: LOCAL_PROVIDER_ID, model: toLocalModel('claude-sonnet-5-5') };
const defaultGuard = () => localProviderAllowed(processGuardEnv(), nodeGuardFs, nodeGuardExec);
const SHUTDOWN_WAIT_MS = 5000;

/** Literal secrets the logger masks wherever they appear (constraints: tokens, API key, CONFIG_MASTER_KEY). */
/** The password of the database url, raw and percent-decoded. */
const dbPassword = (url: string): string[] => {
  try {
    const raw = new URL(url).password;
    return [raw, decodeURIComponent(raw)];
  } catch {
    return [];
  }
};
/** The PEM text plus each base64 body line (a model can echo one line of it), and the one-line form. */
const pemLiterals = (pem: string): string[] => [pem, pem.trim(), pem.replace(/\s*\n\s*/g, ' ').trim(), ...pem.split('\n').map((l) => l.trim()).filter((l) => l.length >= 16 && !l.startsWith('-----'))];
const readKeyFile = (path: string): string => {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
};
export const secretsOf = (env: Env): string[] => {
  const pem = env.github?.privateKey ?? (env.github?.privateKeyPath ? readKeyFile(env.github.privateKeyPath) : '');
  return [
    env.configMasterKey.toString('base64'), env.configMasterKey.toString('hex'), env.databaseUrl, ...dbPassword(env.databaseUrl), env.anthropicApiKey ?? '', env.geminiApiKey ?? '', ...Object.values(env.botTokens),
    env.clickup?.apiToken ?? '', ...(pem ? pemLiterals(pem) : []),
    env.googleSheets?.secret ?? '', env.googleSheets?.url ?? '', env.devjob?.proxyToken ?? '',
  ].filter((s): s is string => !!s);
};

/** A literal shorter than this masks common words wherever it appears; it is kept (masking is the safe side), only warned about. */
export const SHORT_SECRET_CHARS = 8;
/** How many literal secrets are short. The warning names a count only, never a value, its length or which env key it is. */
export const shortSecretCount = (secrets: readonly string[]): number => secrets.filter((s) => s.length < SHORT_SECRET_CHARS).length;

async function storedGeminiKey(repo: ProviderKeyRepo, masterKey: Buffer, log: Logger): Promise<string | undefined> {
  try {
    const enc = await repo.get('gemini');
    return enc ? decryptSecret(enc, masterKey, 'gemini').trim() || undefined : undefined;
  } catch {
    log.warn('stored gemini key could not be read or decrypted; gemini not registered');
    return undefined;
  }
}

/** Custom personas (no prompt file) get a sibling member prompt of their department as template. */
const siblingOf = (prompts: Map<string, PromptDoc>) => (p: Persona): PromptDoc | null =>
  [...prompts.values()].find((d) => d.ref.startsWith('members/') && d.meta.dept === p.deptId) ?? null;

/**
 * Builds the whole company in boot order: pool -> migrate -> ConfigStore -> seed -> Org -> governance -> providers ->
 * tools -> scheduler. start() then connects Discord, posts startup alerts, recovers tasks and serves /healthz.
 */
export async function createApp(env: Env, o: AppOverrides = {}): Promise<App> {
  // One mutable list shared by the logger, the Discord port, interaction replies and approval cards; a stored key joins it after decryption.
  const secrets = secretsOf(env);
  const log = o.logger ?? createLogger(env.logLevel, { secrets });
  const now = o.now ?? Date.now;
  const bootTime = new Date(now()); // G2-GW-02: skill-review recovery only touches proposals created before this process started
  // Gate 1 L9: decided before touching the database. R-L10: with no provider at all the boot does NOT fail (that would be a
  // restart loop under `restart: unless-stopped`); providerReady() below keeps the service idle with an alert until one registers.
  let local: GuardResult | null = null;
  let localRefusedCode: string | undefined;
  if (!o.providers) {
    local = await (o.localGuard ?? defaultGuard)();
    if (!local.ok) {
      log.info({ reason: local.reason }, 'claude-code-local not registered');
      if (local.code) localRefusedCode = local.code;
      if (!env.anthropicApiKey) log.warn('no model provider available: set ANTHROPIC_API_KEY or allow the local provider; idle until one registers');
    } else for (const w of local.warnings ?? []) log.warn(w);
  }
  const pool = o.pool ?? createPool(env.databaseUrl);
  const bus = new EventBus<AppEvents>(log);
  let cfg: ConfigStore;
  try {
    await migrate(pool, MIGRATIONS_DIR, 'up');
    cfg = await ConfigStore.open(pool, bus, log);
  } catch (err) {
    if (!o.pool) await pool.end().catch(() => undefined);
    throw err;
  }

  const skillRepo = new SkillRepo(pool);
  const orgRepos: OrgRepos = { departments: new DepartmentRepo(pool), personas: new PersonaRepo(pool), channelMap: new ChannelMapRepo(pool), skills: skillRepo };
  const overrides = new PromptOverrideRepo(pool);
  const prompts = loadPrompts(PROMPTS_DIR);
  protectedDocs(prompts); // K6: the safety prompts must match their pinned hashes, or the process does not start
  await seed(orgRepos, prompts);
  await restoreCustomPrompts(await orgRepos.personas.list(), prompts, siblingOf(prompts));
  const org = await Org.load(orgRepos, prompts);

  const tasks = new TaskRepo(pool, secrets); // the shared secret list masks a blocked note before it is stored (TASKADMIN-1, TA-C15)
  const taskRuns = new TaskRuns(); // TASKADMIN-1 (TA-C10): the one stop signal the loops check and /task cancel aborts through
  const botMessages = new BotMessageRepo(pool, now);
  const halt = new Halt(cfg, tasks, bus);
  const limits = new Limits(cfg, tasks);
  const auditRepo = new AuditRepo(pool);
  const audit = createAudit(auditRepo, log);
  // WEBGRANT-1 (D4): a live config edit cannot make a grant allow more sites than fetches; the boot refuses the combination (the grant also clamps it).
  if (cfg.get('web.taskGrant.maxHosts') > cfg.get('web.taskGrant.maxFetches')) {
    if (!o.pool) await pool.end().catch(() => undefined);
    throw new Error('config web.taskGrant.maxHosts must not exceed web.taskGrant.maxFetches');
  }
  // TREEGRANT-1 (TG-C16): a conversation root cannot get a longer grant than the grant itself; the boot refuses the combination.
  if (cfg.get('taskGrant.conversationHours') > cfg.get('taskGrant.hours')) {
    if (!o.pool) await pool.end().catch(() => undefined);
    throw new Error('config taskGrant.conversationHours must not exceed taskGrant.hours');
  }
  // W-C4: the grant button and decideGrant share these predicates with the card renderers (the url must be shown whole).
  // TREEGRANT-1 (TG-C3): the task-grant decision recomputes eligibility with the same pure predicate the card uses; `kindOf` reads the main registry (a closure: `tools` is built below, before any decision runs).
  const approvals = new Approvals(pool, tasks, cfg, bus, halt, audit, secrets, isNonSensitiveTool, { solo: (a) => soloShowsWhole(a, secrets), batch: (a) => compactItemFits(a, secrets) }, { kindOf: (n) => tools.kindOf(n), isConversation: (t) => isConversationTask(t) });
  // AUTO-1 (SA-1 3.4): the project repo; BE2/BE3 hand the same instance to the project service and the autopilot port.
  const projects = new ProjectRepo(pool, { cfg, halt, now });
  const budget = new Budget(pool, cfg, bus, () => new Date(now()), {
    taskCap: (rootId, c) => approvals.treeCap(rootId, c),
    localCap: (rootId, c) => approvals.localCap(rootId, c),
    // SPEND-1: the department cap read through the reserving transaction's own client (Gate 1 S9).
    deptCap: (dept, month, c) => effectiveDeptCap(cfg, dept, month, c),
    // AUTO-1 (AP-C6, AP-C10): the active project's caps for the tree, on the reserving transaction's client; null unless autopilot.enabled; a throw fails the reservation closed.
    project: (rootId, c) => projects.capFor(rootId, c),
  });
  // SPEND-1 boot assert: the rollup must keep at least the 35 days the anomaly baseline and the 30-day trend read.
  if (cfg.get('spend.retentionDays') < 35) {
    if (!o.pool) await pool.end().catch(() => undefined);
    throw new Error('config spend.retentionDays must be at least 35');
  }
  // ASKBACK-1 (AB10): a task may ask 2 questions; a per-tree cap below that would make the per-task cap meaningless.
  if (cfg.get('ask.perRoot') < 2) {
    if (!o.pool) await pool.end().catch(() => undefined);
    throw new Error('config ask.perRoot must be at least 2');
  }

  // R8 PV-C01 (outcome guard): in local mode `provider.default` must come from a valid stored row. A missing or invalid row (a data reset, a CLI update that broke the
  // probe pin, a hand-edited value) would otherwise leave the code default `claude` (the metered API) serving ALL main work with no notice; here it reads as "provider
  // not available" (idle plus the existing incident) instead. The VPS (not local mode) is unchanged.
  const safeFlagOk = (): boolean => { try { return localFlagOk(processGuardEnv(), nodeGuardFs); } catch { return false; } };
  const localMode = localModeOf({ override: o.localMode, guardOk: local?.ok === true, flagOk: safeFlagOk(), inContainer: (o.dashboard?.inContainer ?? (() => inContainer(nodeGuardFs)))() !== null });
  const defaultBacked = (): boolean => !localMode || cfg.hasRow('provider.default');
  const providers = o.providers ?? new ProviderRegistry({ defaultUsable: defaultBacked });
  if (!o.providers && env.anthropicApiKey) providers.register(createClaudeProvider(env.anthropicApiKey, { workspaceId: env.anthropicWorkspaceId }));
  let geminiKey: string | undefined;
  if (!o.providers) {
    // R15: GEMINI_API_KEY wins, else the key stored by `/provider add gemini` (AAD = provider id). A missing or undecryptable key never
    // fails the boot: gemini stays unregistered and a department set to it runs nothing, with the no-provider alert.
    const stored = env.geminiApiKey ? undefined : await storedGeminiKey(new ProviderKeyRepo(pool), env.configMasterKey, log);
    if (stored) secrets.push(stored);
    const key = env.geminiApiKey ?? stored;
    geminiKey = key;
    if (key) providers.register(createGeminiProvider({ client: adaptGenAi({ apiKey: key }) }));
  }
  const short = shortSecretCount(secrets);
  if (short) log.warn({ count: short }, `a literal secret is shorter than ${SHORT_SECRET_CHARS} characters; it is still masked but may over-mask common words in replies and logs`);
  // USAGE-1: the Claude subscription quota (latest snapshot kept across restarts) and its hq alert in #bot-log (`port` is read when an alert fires, after boot).
  const quotaRepo = new QuotaRepo(pool);
  let claudeSpendToday: () => Promise<{ usd: number; calls: number }> = async () => ({ usd: 0, calls: 0 }); // set once the spend repo exists (R8)
  const botLogAlert = async (title: string, body: string): Promise<void> => void (await port.post({ kind: 'head', dept: 'hq' }, { channelId: BOT_LOG_CHANNEL_ID }, { type: 'alert', origin: 'governance', title, body }));
  // R8 PROV-FALLBACK: the in-memory block list of the Claude API backup. Marks come from the loop, the judge and the helper call; A3/A4 are posted once per episode, every mark is audited (status numbers and enums only).
  const fallbackAudit = (outcome: string): Promise<void> => audit({ actor: 'system', action: 'provider.fallback', taskId: null, tool: null, outcome }).then(() => undefined);
  const fallbackGate = new FallbackGate({
    heldUntil: () => quotaStore.heldUntil(),
    now,
    // temporary marks (the cool-down, a USD day) have ended: the requeued work is todo and only a hold start or end offers it, so offer it now (while the hold is on)
    onExpire: () => { if (quotaStore.heldUntil() !== null && fallbackEnabled(cfg)) void scheduler.resumeHeld(); },
    onMark: (e, first) => {
      const until = quotaStore.heldUntil();
      const when = until === null ? 'the hold ends' : resetText(Math.floor(until / 1000), cfg.get('schedule.timezone'));
      const outcome = e.kind === 'api_off' ? `api_off:${e.status}` : e.kind === 'api_busy' ? `api_busy:${e.status}` : e.kind === 'task_400' ? 'api_off:400' : `budget_out:${e.scope}`;
      void fallbackAudit(outcome).catch(() => undefined);
      if (!first) return;
      if (e.kind === 'api_off') void botLogAlert('Claude API backup', alertApiOff({ status: e.status, when })).catch(() => undefined);
      else if (e.kind === 'task_400') void botLogAlert('Claude API backup', alertTaskRefused({ status: 400 })).catch(() => undefined);
      else if (e.kind === 'api_busy') void botLogAlert('Claude API backup', alertApiBusy({ status: e.status })).catch(() => undefined);
    },
  });
  const quotaStore = new QuotaStore({
    repo: quotaRepo,
    alert: botLogAlert,
    timezone: () => cfg.get('schedule.timezone'),
    now,
    // R8 (PV-C03): a published rejection started a hold: re-offer the waiting todo tasks (those whose owner now resolves to the backup run; the rest stay held). Never from `load`.
    onHoldStart: () => { if (fallbackEnabled(cfg)) void scheduler.resumeHeld(); },
    onHoldEnd: () => { fallbackGate.clear(); void scheduler.resumeHeld(); }, // OPS-HOLD: the Claude quota hold is over: offer the waiting todo tasks to their owners again (a tracked job); R8: the gate marks end with the episode
    fallback: {
      enabled: () => fallbackEnabled(cfg),
      keyed: () => providers.has('claude'),
      capUsd: () => cfg.get('budget.companyDailyUsd'),
      used: () => fallbackGate.episodeUsed(),
      spend: () => claudeSpendToday(),
    },
    audit: fallbackAudit,
    log,
  });
  await quotaStore.load();
  if (local?.ok) {
    // Timeout and concurrency are read once at boot. Every attempt (retries too) is counted before it spawns (L8, R-L5).
    providers.register(createClaudeCodeLocalProvider({
      claudePath: local.claudePath,
      timeoutMs: cfg.get('provider.localTimeoutMs'),
      concurrency: cfg.get('limits.localConcurrency'),
      audit,
      log,
      onAttempt: (attempt, signal) => budget.onLocalAttempt(attempt, signal),
      onQuota: (q) => quotaStore.publish(q),
    }));
  }
  // Spec §5 with R8 PV-C01: in local mode provider.default was never written -> default to the local Sonnet, once, WHETHER OR NOT the API key is set and whether or not the local
  // guard passed at this boot (a failed probe then idles with the incident; it must not fall through to the metered code default). The VPS (not local mode) never seeds.
  // LOCAL-OFF-1: not when the owner turned the local provider off (the code default, the Claude API, applies; seeding a default nobody can serve would idle the bots).
  if (localMode && !localOffByOwner(processGuardEnv()) && (await new ConfigRepo(pool).get('provider.default')) === null)
    await cfg.set('provider.default', FIRST_LOCAL_DEFAULT, 'system:first-local-boot');
  // Gate 1 L9: an unregistered provider.default runs no loops (alert at start, health reports it); fixing it resumes work.
  const providerReady = () => defaultBacked() && providers.has(cfg.get('provider.default').provider);
  const clients = new ClientManager({ guildId: env.guildId, logger: log, ...(o.createClient ? { createClient: o.createClient } : {}) });
  const webhooks = new WebhookSender(new PersonaWebhookRepo(pool));
  const inbound = createInboundMapper({ guildId: env.guildId, adminRoleId: env.botAdminRoleId, botUserIds: () => clients.botUserIds(), webhooks, org, log });
  // Work-style §2/§5 (Gate 1 WS6, WS10, WS11): the post-only rooms are the approvals rooms, the daily-goal channel and the dashboard channel, read live from the config.
  const postOnlyRooms = (): string[] => [...new Set([...approvalRooms.rooms(), cfg.get('rhythm.dailyGoalChannelId'), cfg.get('dashboard.channelId')].filter((c): c is string => !!c))];
  const port = o.port ?? createDiscordPort(clients, webhooks, org, { guildId: env.guildId, adminRoleId: env.botAdminRoleId, inbound, secrets, taskMessages: tasks, boards: new BoardMessageRepo(pool), botUserIds: () => clients.botUserIds(), postOnly: postOnlyRooms, log });
  // Work-style §2 (Gate 1 WS6-WS8): the per-category approvals rooms are post-only; a card goes to one only after the live room check.
  const approvalRooms = new ApprovalRooms({
    cfg, tasks, port, org, botUserIds: () => clients.botUserIds(), adminRoleId: env.botAdminRoleId, log,
    lwAdminUserId: () => (executor ? executor.userId() : Promise.resolve(null)),
    alert: async (text) => void (await port.post({ kind: 'head', dept: 'hq' }, { channelId: BOT_LOG_CHANNEL_ID }, { type: 'alert', origin: 'governance', title: 'Approvals room not used', body: text })),
  });
  // BOTLOG-1: #bot-log is an incident log; every owner-actionable runtime fault is reported through this one reporter (deduped, sanitised).
  const incidents = new IncidentReporter({ port, channelId: BOT_LOG_CHANNEL_ID, log, secrets, now });
  // WEBGRANT-1: the task web grant. consume refuses while halted and while `web.taskGrant.enabled` is false (both read live); a fault is an incident, never a throw.
  const webGrants = new WebGrantRepo(pool, {
    gate: () => (halt.isHalted() ? 'halted' : cfg.get('web.taskGrant.enabled') === true ? null : 'disabled'),
    onFault: (err) => void incidents.report({ source: 'web_grant', stage: 'consume', toolName: 'fetch_page', err }),
  });
  // W-C3c/d: a halt by any path (the /halt command, a psql write seen by the config watcher, a read fault) revokes every grant; at boot, grants that lived through a halt are revoked too.
  halt.onHalted(async () => void (await webGrants.revokeAll('halt')));
  halt.onResumed(async () => void (await webGrants.revokeAll('halt'))); // G2W-02: every grant that exists at resume time predates it
  await webGrants.revokeBeforeHaltedRow();
  if (halt.isHalted()) await webGrants.revokeAll('halt');
  // TREEGRANT-1: the task-tree grant. consume refuses while halted, while `taskGrant.enabled` is false and (allowTainted false) in a tainted run, all read live before any SQL; a fault is an incident, never a throw.
  // Rows revoked before the card editor exists (the boot revokes) are closed once it does.
  let taskCards: TaskGrantCards | null = null;
  const taskBoot: { rows: readonly TaskGrant[]; reason: TaskRevokeReason }[] = [];
  const taskGrants = new TaskGrantRepo(pool, {
    gate: ({ tainted }) => (halt.isHalted() ? 'halted' : cfg.get('taskGrant.enabled') !== true ? 'disabled' : tainted && cfg.get('taskGrant.allowTainted') !== true ? 'tainted' : null),
    onFault: (err) => void incidents.report({ source: 'task_grant', stage: 'consume', err }),
    onUse: (id) => taskCards?.touch(id),
    onRevoked: (rows, reason) => {
      // G2TG-01 (TG-C19): a system revoke (halt, resume, boot, switch-off, root end) is audited like the admin click's `task_grant.revoke admin #gid`
      if (reason !== 'admin') for (const g of rows) void audit({ actor: 'system', action: 'task_grant.revoke', taskId: null, tool: null, outcome: `${reason} #${g.id}` }).catch(() => undefined);
      if (taskCards) void taskCards.revoked(rows, reason); else taskBoot.push({ rows, reason });
    },
  });
  // TG-C7: a halt by any path revokes every grant (and its companion web grant); a resume restores nothing; at boot, grants that lived through a halt are revoked before the scheduler attaches.
  halt.onHalted(async () => void (await taskGrants.revokeAll('halt')));
  halt.onResumed(async () => void (await taskGrants.revokeAll('halt')));
  await taskGrants.revokeBeforeHaltedRow();
  if (halt.isHalted()) await taskGrants.revokeAll('halt');
  // TG-C8: the switch off at boot revokes too, and a live flip (any path: /settings, psql) revokes; a failed revoke is owed to the next consume.
  if (cfg.get('taskGrant.enabled') !== true) await taskGrants.revokeAll('disabled');
  const unwatchTaskGrant = cfg.watch('taskGrant.enabled', (v) => {
    if (v === false) void taskGrants.revokeAll('disabled').catch((err: unknown) => log.error({ errName: err instanceof Error ? err.name : 'error' }, 'task grant switch-off revoke failed'));
  });
  // TG-C18: the root of a task tree ending revokes its grant and closes the card (consume also checks the root status in SQL, so this is not the security boundary).
  const unbindTaskRoot = bus.on('task.changed', (e) => {
    if (e.task.id === e.task.rootId && (e.to === 'done' || e.to === 'cancelled')) void taskGrants.revokeRoot(e.task.id).catch((err: unknown) => log.error({ errName: err instanceof Error ? err.name : 'error' }, 'task grant root-end revoke failed'));
  });
  // The offer a card carries (TG-C11): only for an eligible stored row of an open tree with no live grant (discord/approval/task-grant-offer.ts).
  const taskGrantOffer = makeTaskGrantOffer({ cfg, halt, tasks, grants: taskGrants, kindOf: (n) => tools.kindOf(n), isConversation: (t) => isConversationTask(t) });
  // OT-1: overtime grants follow the same halt rules (OT-C4, OT-C7, OT-C15): consume and the held check refuse while halted and while `ot.enabled` is false (both read live,
  // a failed read counts as off); every halt and every resume revokes every grant (resume restores nothing); a halt revoke that fails is owed to the next check; at boot a
  // grant that lived through a halt while the process was down is revoked before the scheduler attaches or the recovery pass runs.
  // G2OT-01: a grant the repository revokes on its own (the boot revoke, the halt revoke before the service exists, a refused call's halt retry) is handed to the
  // service to close its card: right away when the service exists, else once the clients are up (see start()).
  let otService: OtService | null = null; // set below, once the calendar and the port exist
  let otBootRevoked: OtRequest[] = [];
  const otClosed = (rows: OtRequest[], why: string) => {
    if (otService) void otService.closeRevoked(rows, why);
    else otBootRevoked.push(...rows);
  };
  const otRepo = new OtRequestRepo(pool, {
    gate: () => (halt.isHalted() ? 'halted' : cfg.get('ot.enabled') === true ? null : 'disabled'),
    onFault: (err) => void incidents.report({ source: 'overtime', stage: 'check', err }),
    onRevoked: (rows) => otClosed(rows, 'the company was halted'),
  });
  const otRevokeHalt = async () => {
    if (otService) await otService.revokeAll('halt');
    else otClosed(await otRepo.revokeAll('halt'), 'the company was halted');
  };
  halt.onHalted(otRevokeHalt);
  halt.onResumed(otRevokeHalt);
  otClosed(await otRepo.revokeBeforeHaltedRow(), 'the company was halted');
  if (halt.isHalted()) otClosed(await otRepo.revokeAll('halt'), 'the company was halted');
  // R6 MCP-1 (spec 5.8, 5.14): the live host of the external tools. Built here, loaded only by `bootMcp` (and only while `mcp.enabled` is on); until then it is empty. McpAdmin and the tool
  // adapter get `mcpHostGate`, whose refresh does nothing before a successful boot, so an approve with the switch off can never load a server by a path that skipped the Docker checks.
  const mcpRepo = new McpRepo(pool, { onTasksMoved: async (cs) => { for (const { task, from } of cs) if (from !== task.status) await bus.emit('task.changed', { task, from, to: task.status }); } }); // BE3: tasks the expiry cancelled are mirrored like expireOld's
  const mcpDocker: Pick<DockerCli, 'exec'> = o.mcp?.docker ?? realDockerCli();
  const mcpLatch = new StuckLatch();
  let mcpBooted = false;
  // the scheduler is built below; this is only called at run time, and the post is tracked so idle() and shutdown wait for it (a fault is swallowed: a notice never stops a call)
  const mcpAlert = (title: string, body: string): Promise<void> => scheduler.track('mcp.alert', async () => { await port.post({ kind: 'head', dept: 'hq' }, { channelId: BOT_LOG_CHANNEL_ID }, { type: 'alert', origin: 'governance', title, body }).catch(() => undefined); });
  const mcpHost: McpHost = new McpHost({
    repo: mcpRepo, makeTool: (s, t) => mcpToolFactory(s, t), secrets: () => secrets, log,
    onConfigChanged: (row) => quarantineConfig({ repo: mcpRepo, notify: (text) => mcpAlert('MCP server quarantined', text), log }, row), // 047: no refresh here (the host is mid-load)
    incident: (code, slug) => { if (/^[a-z][a-z0-9]{1,15}$/.test(slug) && /^[A-Za-z_]{1,40}$/.test(code)) void mcpAlert('MCP server not loaded', `MCP server ${slug} was not loaded (${code}). The other servers are unaffected.`); },
  });
  const mcpHostGate = { entry: (n: string) => mcpHost.entry(n), refresh: async (slug?: string) => { if (mcpBooted) await mcpHost.refresh(slug); } };
  const mcpSandbox = { docker: mcpDocker, spawn: o.mcp?.spawn ?? realMcpSpawner(), isHalted: () => halt.isHalted(), latch: mcpLatch, onStuck: () => void mcpAlert('MCP tools stopped', 'A sandbox container could not be removed, so external tools are stopped until the app restarts. Check Docker.') };
  const mcpToolFactory = createMcpToolFactory({
    host: mcpHostGate, repo: mcpRepo, sandbox: mcpSandbox, slots: new Slots(), enabled: () => cfg.get('mcp.enabled'), halted: () => halt.isHalted(), tz: () => cfg.get('schedule.timezone'),
    caps: () => ({ tree: cfg.get('mcp.maxCallsPerTree'), day: cfg.get('mcp.maxCallsPerDay') }), audit, secrets: () => secrets, notify: (text) => mcpAlert('MCP server quarantined', text), log,
  });
  const tools = new ToolRegistry({ halt, incidents, treeGrants: true, autopilot: true, external: { get: (n) => mcpHost.get(n), names: () => mcpHost.names() } }); // TG-C6: only the main registry may consume a task grant; R6: only it resolves external tools
  for (const t of builtinTools()) tools.register(t);
  const reminderRepo = new ReminderRepo(pool);
  const jobRepo = new JobRepo(pool);
  const watchRepo = new WatchRepo(pool);
  const lessonRepo = new LessonRepo(pool);
  // P9: vendor clients are built here and handed to the plugins by closure; a token never enters a ToolContext.
  // CLICKUP-ALL-1 (C3): list mode when CLICKUP_LIST_ID is set; workspace mode only with an explicit CLICKUP_TEAM_ID (env.ts decides, a token alone leaves ClickUp off).
  // CLICKUP-MULTI-1: CLICKUP_TEAM_ID=all is `teams: 'all'` (never an id string). A change of the workspace SET is audited and announced with counts only (CM-C3, CM-C4).
  if (env.clickup?.teamAllIgnored) log.warn('CLICKUP_TEAM_ID=all is ignored while CLICKUP_LIST_ID is set; clearing the list id opens every workspace'); // CM-C5 b: no values
  const clickup = env.clickup ? createClickUpClient({
    http: createHttpClient({ ...(o.fetch ? { fetch: o.fetch } : {}) }), token: env.clickup.apiToken,
    ...(env.clickup.listId ? { listId: env.clickup.listId } : env.clickup.teams === 'all' ? { allTeams: true as const } : { teamId: env.clickup.teamId }), ...(o.clickupSleep ? { sleep: o.clickupSleep } : {}),
    log, onTeamsEvent: (e) => clickupTeamsEvent(e),
  }) : undefined;
  const clickupTeamsEvent = (e: TeamsEvent): void => {
    const a = teamsEventAudit(e);
    void audit({ actor: 'system:clickup', action: a.action, tool: 'clickup', outcome: a.outcome }).catch(() => undefined);
    void port.post({ kind: 'head', dept: 'hq' }, { channelId: BOT_LOG_CHANNEL_ID }, { type: 'alert', origin: 'governance', title: 'ClickUp workspaces', body: teamsEventNotice(e) }).catch(() => undefined);
  };
  const clickupUsage = clickup?.mode === 'workspace' ? new ClickUpWriteUsage(pool) : undefined;
  const clickupSeenRepo = new ClickUpSeenRepo(pool);
  const gh = env.github ? githubFromEnv(env.github, { http: createHttpClient({ ...(o.fetch ? { fetch: o.fetch } : {}) }), clock: now }) : undefined;
  // P6a: resolve the denied repository names to ids once at startup (cached, refreshed lazily); a failure only refuses writes
  // The failure is logged and raised as one alert at start (it fails closed already); the error text is never sent (it could carry a vendor message).
  const denylistCheck: Promise<boolean> = gh && 'client' in gh
    ? gh.client.deniedIds().then(() => true, (err: unknown) => { log.warn({ err }, 'github denylist could not be resolved at startup; github writes are refused until it can'); return false; })
    : Promise.resolve(true);
  const presence = new HqPresence(now);

  // Shutdown and an hq pause (D9) are not halts, but a run between two provider calls must not start another one.
  let stopping = false;
  const agentHalt: AgentDeps['halt'] = {
    isHalted: () => stopping || halt.isHalted() || presence.paused(),
    track: (ac) => {
      if (!stopping) return halt.track(ac);
      ac.abort(new Error('shutting down'));
      return () => undefined;
    },
  };
  // Self-knowledge (Gate 1 K1-K18): the notes repo screens every write (secrets, PII); the service owns proposals and their apply; the
  // classifier and reflect/review calls go through the same metered call core as the agent loop, on the calling actor's own provider and model (PROV-HELPER).
  const noteRepo = new DeptNoteRepo(pool, { secrets });
  const kbRepo = new KbRepo(pool);
  const proposalRepo = new ProposalRepo(pool, (dept) => org.personasOf(dept).map((p) => p.promptRef)); // K5 at the repo layer: a member must belong to the department
  // PROV-HELPER: helper calls (reflect, review, classify) use the calling actor's own provider (profiles) and stand down during the Claude quota hold.
  const smallDeps = { providers, cfg, call: { budget, halt: agentHalt, audit, log }, profiles: { org, prompts, overrides }, quotaHold: quotaStore, fallback: fallbackGate };
  const knowledge = new KnowledgeService({
    kb: kbRepo, proposals: proposalRepo, notes: noteRepo, lessons: lessonRepo, overrides, tasks, org, prompts, classify: createClassifier(smallDeps), audit, secrets, cfg,
  });
  for (const t of knowledgeTools(knowledge)) tools.register(t);
  // SKILLS-1: core builtins are named once, here: the grant rule (tools/skill-grant.ts) and the tool policy both read this list.
  const builtinNames = [...builtinTools().map((t) => t.name), ...KNOWLEDGE_TOOL_NAMES, ...SKILL_TOOL_NAMES, ...PROJECT_TOOL_NAMES, ...RELEASE_TOOL_NAMES, ...GROW_TOOL_NAMES];
  const retroRepo = new RetroRepo(pool);
  const deptIncidentRepo = new DeptIncidentRepo(pool); // LEARN-1 (D2)
  const skillService = new SkillService({
    retro: retroRepo, repo: skillRepo, org, classify: createClassifier(smallDeps), audit, secrets, cfg,
    grant: { registered: () => tools.names(), builtins: () => builtinNames, kindOf: (n) => tools.kindOf(n) },
    notify: async (text) => void (await port.post({ kind: 'head', dept: 'hq' }, { channelId: CONFIG_CHANNEL_ID }, { type: 'alert', origin: 'governance', title: 'Skill proposal', body: text })),
    log,
  });
  for (const t of skillTools(skillService)) tools.register(t);
  await seedSkills(skillService, SEED_SKILLS, cfg, log); // LEARN-1 R3: starter skills once (never throws; skips any existing id; off with skills.seed.enabled)
  // GROW-1: tool_request (a Bot Admin card in #setting; never AI-approved) and tool_idea (a ticket). Registered through growTools, not builtinTools(); both names are in
  // builtinNames, so no skill and no tools.byDept list can grant them. The head notice goes through Scheduler.notifyHead (built later; called only at run time).
  const toolRequests = new ToolRequestService({
    repo: new ToolRequestRepo(pool), cfg, org, grant: { registered: () => tools.names(), builtins: () => builtinNames, kindOf: (n) => tools.kindOf(n) },
    plugins: () => tools.names().filter((n) => !builtinNames.includes(n)), halted: () => halt.isHalted(), audit, secrets, configChannelId: CONFIG_CHANNEL_ID,
    postCard: (p) => port.post({ kind: 'head', dept: 'hq' }, { channelId: CONFIG_CHANNEL_ID }, p),
    closeCard: (c, m, n) => port.closeCard(c, m, n),
    notifyHead: (dept, text) => scheduler.notifyHead(dept, text),
    log,
    projectGrant: (r) => autopilot.projectGrant(r), // AUTO-1 (AP-C7): injected port; this service still never imports the approver (the autopilot service is built below, called only at run time)
  });
  const toolIdeas = new ToolIdeaService({
    repo: new ToolIdeaRepo(pool), halted: () => halt.isHalted(), audit, secrets, log,
    notify: async (title, text) => void (await port.post({ kind: 'head', dept: 'hq' }, { channelId: BOT_LOG_CHANNEL_ID }, { type: 'alert', origin: 'governance', title, body: text })),
  });
  for (const t of growTools({ requests: toolRequests, ideas: toolIdeas })) tools.register(t);
  // AUTO-1 (SA-1 3.2, 3.5, 3.6): the project service: the one Bot Admin card (#setting), the budget notice, the lifecycle commands, the root-end sync and the deadline notice. project_propose is a
  // core builtin (its name is in builtinNames: no skill and no tools.byDept list can grant it). The head notice goes through Scheduler.notifyHead (built later; called only at run time).
  const projectService = new ProjectService({
    repo: projects, cfg, tasks, bus, halted: () => halt.isHalted(), secrets, configChannelId: CONFIG_CHANNEL_ID, now,
    postCard: (p) => port.post({ kind: 'head', dept: 'hq' }, { channelId: CONFIG_CHANNEL_ID }, p),
    closeCard: (c, m, n) => port.closeCard(c, m, n),
    notifyHead: (dept, text) => scheduler.notifyHead(dept, text),
    log,
  });
  for (const t of projectTools({ projects: projectService })) tools.register(t);
  // AUTO-1 (SA-1 3.3, AP-C1..C3): the inline autopilot decision. It reads the MAIN registry's describe (AA-C1: the hard-deny classes are imported, never copied).
  const autopilot = new AutopilotService({
    cfg, halted: () => halt.isHalted(), repo: projects, org, describe: (n) => tools.describe(n), secrets, exhausted: (id) => projectService.exhausted(id), log,
    // AUTO-2 3.8: one notice per local day (claim first, then post); fixed text and a closed code only. The service swallows a throw: the card is filed either way.
    capNotice: async (which) => {
      if (await projects.claimCapNotice(which)) await port.post({ kind: 'head', dept: 'hq' }, { channelId: BOT_LOG_CHANNEL_ID }, { type: 'alert', origin: 'governance', title: CAP_NOTICE_TITLE, body: capNoticeBody(which) });
    },
  });
  const stateRepo = new KnowledgeStateRepo(pool);
  // Task 32 (PF21): tools reach Gemini only through this metered closure (reserve -> halt-tracked stream -> settle -> llm.call audit).
  const metered = createMeteredModel({ providers, cfg, budget, audit, log, incidents, halt: agentHalt });
  // Task 34 (P15): per-human daily OCR/receipt cap, taken by the tools, peeked by the commands and the auto-OCR channel.
  const vision = new VisionCap(cfg, now);
  // P22/R13: missing or mismatched media binaries, or a voice library that fails to load (DAVE/opus native), turn off only
  // music/voice. They are listed in the one tool-groups alert, handed to the group factories and the VoiceManager; the boot continues.
  // Spec 4.4: MEDIA_SOCKET → the secret-free sidecar; no socket outside a container → the local binaries (owner Mac); no socket in a
  // container → fail closed, music and voice off with "media sidecar not configured". A test override (media/binaries) skips the
  // selection and the real container check (C13).
  const localMedia = (container?: () => string | null) => new LocalMediaBackend({
    ytDlp: o.binaries?.ytDlp ?? PINNED_BINARIES.ytDlp.path, ffmpeg: o.binaries?.ffmpeg ?? PINNED_BINARIES.ffmpeg.path,
    ...(o.binaries?.ytDlp ? (o.binaries.ytDlpTree ? { ytDlpTree: o.binaries.ytDlpTree } : {}) : { ytDlpTree: PINNED_BINARIES.ytDlp.tree }),
    expectedSha256: o.binaries?.expectedSha256 ?? pinnedFor(process.arch), ...(o.binaries?.exec ? { exec: o.binaries.exec } : {}), jsRuntime: process.execPath,
    ...(env.ytDlpCookiesFile ? { cookiesFile: env.ytDlpCookiesFile } : {}), ...(o.musicEnv ? { extraEnv: o.musicEnv } : {}), log,
    ...(container ? { inContainer: container } : {}),
  });
  const containerCheck = () => inContainer(nodeGuardFs);
  const selected = o.media ? { backend: o.media } : o.binaries ? { backend: localMedia() } : selectMediaBackend({
    ...(env.mediaSocket ? { mediaSocket: env.mediaSocket } : {}), inContainer: containerCheck,
    local: () => localMedia(containerCheck), socket: (p) => new SocketMediaBackend({ socketPath: p, log }),
  });
  const mediaBackend: MediaBackend | null = 'backend' in selected ? selected.backend : null;
  const media = 'backend' in selected ? await bootMedia(selected.backend) : { disabled: [{ id: 'music', why: selected.disabled }, { id: 'voice', why: selected.disabled }] };
  if (media.disabled.length) log.warn({ groups: media.disabled.map((d) => d.id) }, 'media check failed; music/voice groups disabled');
  const voice = prawVoiceManager({
    client: () => clients.client('praw'), guildId: env.guildId, log, isHalted: () => halt.isHalted(), silenceMs: () => cfg.get('voice.silenceMs'),
    unavailable: () => { const v = media.disabled.find((d) => d.id === 'voice'); return v ? `Voice is disabled: ${v.why}` : null; },
    ...(o.voice?.createSession ? { createSession: o.voice.createSession } : {}), ...(o.voice?.checkChannel ? { checkChannel: o.voice.checkChannel } : {}),
  });
  voice.leaveOnHalt(bus, (fn) => cfg.watch('halted', fn));
  // Task 36 (P7): music over the pinned yt-dlp/ffmpeg; its queue lives in music_state and comes back paused after a restart.
  const voiceChannelOf = o.voice?.voiceChannelOf ?? prawVoiceChannelOf(() => clients.client('praw'), env.guildId);
  const music = !mediaBackend || media.disabled.some((d) => d.id === 'music') ? null : prawMusicPlayer({
    voice, guildId: env.guildId, log, store: new MusicStateRepo(pool, env.guildId), allowlist: () => cfg.get('media.ytHostAllowlist'),
    voiceChannelOf,
    media: mediaBackend,
  });
  await music?.restore();
  const web = await bootWeb(env, log, { ...o.web, local: o.web?.local ?? process.env.ALLOW_LOCAL_PROVIDERS === '1' });
  const renderBoot = await bootRenderer(env, log, o.render);
  // RFMD P5: image and video generation. The key stays inside the client closure; the group is off without a client. Video jobs resume at boot (start below).
  const mediaClient = o.mediaClient ?? (geminiKey ? createGeminiMedia({ apiKey: geminiKey }) : undefined);
  const mediaJobs = mediaClient ? new MediaJobService({ repo: new MediaJobRepo(pool), client: mediaClient, port, provenance: botMessages, halt: agentHalt, log, incidents, clock: now }) : undefined;
  const mediaGen = mediaClient && mediaJobs ? { client: mediaClient, budget, usage: new MediaUsageRepo(pool, () => new Date(now())), jobs: mediaJobs } : undefined;
  // WS-1 (SA-1 3.1, Gate 1 WS-C5): WS_ROOT checks before the groups register. A refusal leaves the ws group off with a fixed reason (listed in the tool-groups alert).
  const workspaceRoot = o.workspaceRoot ?? resolve(process.cwd(), env.prawWorkspaceDir ?? DEFAULT_WORKSPACE_DIR);
  const wsRootEnv = o.ws?.root ?? env.wsRoot;
  const wsDocker = o.ws?.docker ?? realDockerCli();
  const wsBoot = (o.providers || o.localGuard) && wsRootEnv === undefined
    ? ({ ok: false, reason: 'workspace boot skipped', failed: false } as const)
    : await bootWorkspaces({ ...(wsRootEnv ? { wsRoot: wsRootEnv } : {}), prawRoot: workspaceRoot, ...(env.executorSocket ? { executorSocket: env.executorSocket } : {}), docker: wsDocker, ...(o.ws?.imagesDir ? { imagesDir: o.ws.imagesDir } : {}) });
  if (!wsBoot.ok) log.warn({ reason: wsBoot.reason }, 'workspaces disabled');
  // The run deps exist only when the Docker checks passed (wsBoot.runner is the verified image id). halt.isHalted is the latched flag; the caps are read at each claim.
  const wsService = wsBoot.ok
    ? new WsService({
        repo: new WorkspaceRepo(pool), root: wsBoot.root, files: new ProjectFiles(wsBoot.root), lock: new SlugLock(),
        ...(wsBoot.runner && process.getuid && process.getgid
          ? { run: { docker: wsDocker, image: wsBoot.runner, uid: process.getuid(), gid: process.getgid(), caps: () => ({ tree: cfg.get('ws.maxRunsPerTree'), day: cfg.get('ws.maxRunsPerDay') }), isHalted: () => halt.isHalted(), secrets: () => secrets, incidents, now } }
          : {}),
      })
    : undefined;
  // R4 (PM-C10): factories passed through `o.groups` are a test seam (main.ts passes none); their tool names are recorded so the whole-registry declaration check below can skip exactly them.
  // R5 RELEASE-1 (SA-1 5.7, Gate 1 RL-C1c): the release card. The service is built after wsService and registered before coreToolNames, so release_request is declared in 'builtin'. The tool gets
  // `releaseToolDeps(releaseService)` (a closure over `request`, nothing else); decide, reject and the lists reach only the slash/button layer (CommandDeps) and the sweeps below. The card
  // and the head notice follow the toolRequests lambdas. A missing workspace service means ws is off for the release service too (`ws_off`).
  // R7 PLUGIN-FORGE (spec 6, PF-C13, PF-C23): the forge repo and the base image id, read ONCE here (a changed file takes effect after a restart; the service checks the id against Docker at boot).
  const forgeRepo = new ForgeRepo(pool);
  const forgeBaseId = loadBaseId(findForgeImagesFile(o.forge?.imagesDir));
  const releaseRepo = new ReleaseRepo(pool);
  const releaseService = new ReleaseService({
    repo: releaseRepo,
    ws: wsService ?? { export: async () => { throw new Error('workspaces are not set up'); } },
    projects: { byRoot: (rootId) => projects.byRoot(rootId) },
    enabled: () => cfg.get('release.enabled'), wsEnabled: () => wsService !== undefined && cfg.get('ws.enabled') === true, halted: () => halt.isHalted(), tz: () => cfg.get('schedule.timezone'),
    audit, secrets, configChannelId: CONFIG_CHANNEL_ID, catalogDigest: CATALOG_DIGEST,
    postCard: (p) => port.post({ kind: 'head', dept: 'hq' }, { channelId: CONFIG_CHANNEL_ID }, p),
    postFile: (a, t, p, f) => port.postFile(a, t, p, f),
    post: (a, t, p, o) => port.post(a, t, p, o),
    forge: makeForgeRequestPort({ repo: forgeRepo, enabled: () => cfg.get('forge.enabled'), mcpEnabled: () => cfg.get('mcp.enabled'), baseId: forgeBaseId, secrets: () => secrets }),
    provenance: botMessages,
    closeCard: (c, m, n) => port.closeCard(c, m, n),
    notifyHead: (dept, text) => scheduler.notifyHead(dept, text),
    log,
  });
  for (const t of releaseTools(releaseToolDeps(releaseService))) tools.register(t);
  // RL-C5: the database clock, read before the Discord clients come up; recovery fails only claims older than this. A read fault skips recovery (rows left `releasing` are never re-posted; the next boot retries).
  const releaseBootTime = await releaseService.bootTime().catch((err: unknown) => { log.error({ errName: err instanceof Error ? err.name : 'unknown' }, 'release boot time read failed'); return '-infinity'; });
  const coreToolNames = [...tools.names()]; // everything registered before the plugin groups: all of it must be declared in group 'builtin'
  const testToolNames = new Set<string>();
  const testGroups: GroupFactory[] = (o.groups ?? []).map((f): GroupFactory => (d) => {
    const g = f(d);
    if (!('disabled' in g)) for (const t of g.tools) testToolNames.add(t.name);
    return g;
  });
  const groups = registerGroups(tools, [...pluginGroups, ...testGroups], { env, cfg, log, port, clock: now, reminders: reminderRepo, jobs: jobRepo, watches: watchRepo, lessons: lessonRepo, ...(clickup ? { clickup } : {}), ...(clickupUsage ? { clickupUsage, clickupSecrets: secrets } : {}), ...(gh && 'client' in gh ? { github: gh.client } : {}), ...(gh && 'disabled' in gh ? { githubDisabled: gh.disabled } : {}), org, provenance: botMessages, workspaceRoot, ...(env.docsDir ? { docsDir: env.docsDir } : {}), metered, vision, halt: agentHalt, mediaDisabled: media.disabled, ...(music ? { music } : {}), ...(o.net ? { net: o.net } : {}), ...(web.browser ? { browser: web.browser } : {}), ...(web.disabled ? { browserDisabled: web.disabled } : {}), ...(renderBoot.renderer ? { renderer: renderBoot.renderer } : {}), ...(renderBoot.disabled ? { rendererDisabled: renderBoot.disabled } : {}), ...(renderBoot.failed ? { rendererFailed: true as const } : {}), incidents, ...(mediaGen ? { mediaGen } : {}), ...(wsService ? { ws: wsService } : { wsDisabled: wsBoot.ok ? 'workspaces are not set up' : wsBoot.reason, ...(!wsBoot.ok && wsBoot.failed ? { wsFailed: true as const } : {}) }), wsSecrets: secrets });
  // R4 (PM-C4): every registered name must be declared in the manifest with the group and kind it was registered with (a plugin tool was checked inside registerGroups); an undeclared tool refuses the boot.
  assertDeclared(tools, coreToolNames, 'builtin');
  assertRegistryDeclared(tools, MAIN_GROUPS, testToolNames);
  // TG-C1 (S9): every task-grant tool that IS registered must be a non-sensitive write tool (a disabled group is skipped); a wrong kind refuses boot.
  try { assertTreeGrantScope(tools); } catch (err) { if (!o.pool) await pool.end().catch(() => undefined); throw err; }
  // Plugin tools reach an actor only through tools.byDept (praw's "*" expands here); builtins come from prompt meta.
  org.setToolPolicy(createToolPolicy(cfg, () => tools.names(), () => builtinNames, (n) => tools.kindOf(n), (d) => mcpHost.mcpFor(d), () => cfg.get('mcp.enabled')));
  org.setSkillsFaultSink((err) => void incidents.report({ source: 'skills', stage: 'reload', err }));
  const unknownTools = unknownPromptTools(prompts, tools.names());
  if (unknownTools.length) log.warn({ tools: unknownTools }, 'prompt frontmatter names tools that are not registered; they grant nothing');

  // An enabled department whose client is not connected cannot post: it gets no routes and no delegated work.
  const online = (dept: string) => clients.online().includes(dept as DeptId);
  // Off days (Sat/Sun by default plus listed holidays, in schedule.timezone): automated work waits, humans are answered; reminders unchanged.
  const calendar = createCalendar(cfg);
  const offDayAt = (t: number) => calendar.isOffDay(t).off;
  // OT-1: overtime requests. The request card goes to #⚙️-setting only; the scheduler, the decision buttons and create_task reach it through narrow views.
  const hq = { kind: 'head', dept: 'hq' } as const;
  const ot = new OtService({
    repo: otRepo, cfg, calendar, halt, bus, clock: now, configChannelId: CONFIG_CHANNEL_ID, secrets, audit, log, incidents, tasks,
    render: { request: otRequestPayload, granted: otGrantedPayload },
    ports: {
      postCard: async (p) => ({ channelId: CONFIG_CHANNEL_ID, messageId: await port.post(hq, { channelId: CONFIG_CHANNEL_ID }, p) }),
      editCard: (c, m, p) => port.updateCard(c, m, p),
      closeCard: (c, m, n) => port.closeCard(c, m, n),
      threadLine: (root, text) => scheduler.sayInThread(root, text),
    },
  });
  otService = ot;
  // G2OT-03: the switch turned off from ANY path (psql, /settings) ends every grant, so an off/on the same day cannot revive one. A failed revoke is owed to the next check.
  const unwatchOt = cfg.watch('ot.enabled', (v) => {
    if (v === false) void ot.revokeAll('admin').catch((err: unknown) => log.error({ errName: err instanceof Error ? err.name : 'error' }, 'overtime switch-off revoke failed'));
  });
  // Teamwork C: the daily cap on bot-created root tasks (TW6) and the meetings (TW13); the scheduler gives meetings their host in attach().
  const botRoots = new BotRoots(cfg, (since) => tasks.countBotRootsSince(since), now);
  const meetings = new Meetings({
    cfg, now, roots: botRoots, claim: (key) => stateRepo.claimWeek('meetings', key), log,
    heads: () => org.heads().filter((h) => h.enabled).map((h) => h.id as DeptId),
  });
  // TEAMTALK-1: the persona rooms' memory (read by every run) and the code that writes handoff lines, room lines and boards (bound by the scheduler).
  const roomEntries = new RoomEntryRepo(pool);
  const teamtalk = new TeamTalk({ port, tasks, rooms: roomEntries, org, halt, secrets, guildId: env.guildId, log, incidents, provenance: botMessages, now, enabled: () => cfg.get('teamtalk.enabled') !== false });
  const agent: AgentDeps = {
    rooms: roomEntries,
    botRoots, meetings, openTasks: (actor) => tasks.openOf(actor, 10), deptIncidents: (dept) => deptIncidentRepo.summary(dept), // LEARN-1: the head's incident block (not `incidents`, the BOTLOG-1 reporter)
    org, prompts, overrides, providers, fallback: fallbackGate, cfg, budget, limits, halt: agentHalt, taskRuns, approvals, tasks, notes: noteRepo, tools, bus, audit, log, secrets, incidents, online, provenance: botMessages,
    offDay: () => calendar.isOffDay(now()),
    canMemberView: (userId, channelId) => port.canMemberView(userId, channelId),
    guildId: env.guildId, channelIsPublic: (id) => port.channelIsPublic(id), // RF11: forward_to links and the audience rule
    canBotView: (dept, channelId) => port.botCanView(dept, channelId), // F3: the hint for a mention of a bot that cannot see the channel
    approvalChannel: (a) => approvalRooms.channelFor(a), // F1: the tool result names the channel the card is posted in
    webGrants: { consume: (r) => webGrants.consume(r) },
    treeGrants: { consume: (r) => taskGrants.consume(r) },
    ot: { until: (rootId) => ot.until(rootId) },
    // every non-admin run (the loop checks); only Praw also reads the lessons it saved itself (K1: no unreviewed model text for the other departments)
    lessons: (actor) => lessonRepo.activeTexts(cfg.get('lessons.promptChars'), { confirmedOnly: !(actor.kind === 'head' && actor.dept === 'praw') }),
    reflect: createReflector({ small: smallDeps, notes: noteRepo, state: stateRepo, audit }),
    // AUTO-1 (SA-1 3.4, 3.7, 5.4): the project port; the loop hands only projectOf and decide to the tools of a non-admin run
    forge: { hqIdeas: () => forgeRepo.eligibleIdeas(5), softwareIdea: (rootId) => forgeRepo.softwareIdea(rootId) }, // R7: the two note reads; nothing that builds, stages or installs
    autopilot: { projectOf: (id) => autopilot.projectOf(id), toolsFor: (pid, a) => autopilot.toolsFor(pid, a), budgetHit: (t) => projectService.budgetHit(t), decide: (r) => autopilot.decide(r), companyOn: () => autopilot.companyOn(), inCompany: (id) => autopilot.inCompany(id), treeToolsFor: (id, a) => autopilot.treeToolsFor(id, a) },
  };
  // HEAL-1: resolve_blocked's port. The cap-carrying rows go through healRepo.claim (awaited, throws); refusals use the swallowing audit.
  const healRepo = new HealRepo(pool, secrets);
  agent.heal = createHealActions({
    tasks, repo: healRepo, audit, cfg, isHalted: () => halt.isHalted(), pendingApprovals: (id) => tasks.pendingApprovalCount([id]), bus,
    revokeRoot: (rootId, by) => webGrants.revokeRoot(rootId, by), secrets, now, log,
  });
  const selfReview = new SelfReview({
    small: smallDeps, org, notes: noteRepo, proposals: proposalRepo, state: stateRepo, cfg, offDay: (t) => calendar.isOffDay(t), canRun: () => scheduler.canRun(),
    online, audit, secrets, now, log,
  });
  // R8 / Gate P3: one per-user Praw counter. The triggering message's own slot (taken in Scheduler.admit) IS the P3 charge for
  // the conversation task it opens; userSlot only re-checks the user is still within the limit. Entry points that bypass
  // admit() (future /ask, /ocr, /voice) must call prawRate.take() themselves.
  const prawRate = new PrawRateLimit(cfg, now);
  const conversation = createConversation({ tasks, port, limits, bus, userSlot: (userId) => prawRate.within(userId) });
  // R4: approved tool calls run as the task owner through runApproved, with a context built like the loop's own.
  const approved = approvedTools({ approvals, tools, context: async (actor, task) => approvedToolContext(actor, task, agent, await autopilot.toolsForTask(task.id, actor).catch(() => [])) });
  const board = new TaskBoard({ tasks, port, log });
  // Work-style §5 (WS11): the CEO's daily goal and evening report; the claim row is the one-run-per-day guard and keeps the report for the next day.
  const dailyRuns = new DailyRunRepo(pool);
  const rhythm = new Rhythm({ cfg, now, claim: (d, k) => dailyRuns.claim(d, k), save: (d, k, b) => dailyRuns.save(d, k, b), lastReport: (d) => dailyRuns.lastReport(d), openTasks: (n) => tasks.openIds(n), log });
  // Work-style §5 (WS10): the pinned status board, counts only, on the task board's 60 s debounce; off until `dashboard.channelId` is set.
  const statusBoard = new TaskBoard({
    tasks, port, log, key: 'status-board', channelId: () => cfg.get('dashboard.channelId'),
    build: async () => {
      const cats = new Map((await port.listGuildChannels().catch(() => [])).filter((c) => c.type === 4).map((c) => [c.id, c.name] as const));
      const live = clients.online().length;
      return renderStatus(await tasks.dashboardCounts(), cats, { online: live, total: org.heads().filter((h) => h.enabled).length, paused: presence.paused(), halted: halt.isHalted() });
    },
  });
  // APPROVAL-BATCH-1: one card for the tool approvals of one task and requester that arrive within the window (default 10 s). Tests turn it off or shorten it.
  const batchRepo = new ApprovalBatchRepo(pool);
  // TREEGRANT-1 (TG-C17): the usage line and the closing of a grant's card (stored card ids only).
  taskCards = new TaskGrantCards({
    repo: taskGrants,
    ports: { note: (c, m, t) => port.noteCard?.(c, m, t) ?? Promise.resolve(), close: (c, m, t) => port.closeCard(c, m, t) },
    text: async (g) => {
      const w = g.webGrantId !== null ? await webGrants.get(g.webGrantId).catch(() => null) : null;
      return taskGrantCardText(g, w ? { maxFetches: w.maxFetches, maxHosts: w.maxHosts, maxUrlChars: w.maxUrlChars } : null, secrets);
    },
    endedText: (g, reason) => taskGrantEndedText(g, reason, secrets),
    isBatchCard: async (approvalId) => { const b = await batchRepo.ofApproval(approvalId); return !!b && (b.state === 'posted' || b.state === 'closed'); },
    log,
  });
  for (const b of taskBoot.splice(0)) void taskCards.revoked(b.rows, b.reason);
  const batching = o.approvalBatching === false ? undefined : new ApprovalBatching({
    repo: batchRepo, expiryHours: () => cfg.get('approval.expiryHours'), log, ...(o.approvalBatching ? { windowMs: o.approvalBatching.windowMs } : {}),
    ...approvalBatchHooks({ port, rooms: approvalRooms, secrets, grantEnabled: () => cfg.get('web.taskGrant.enabled') === true, taskGrantOffer }),
    alert: async (text) => void (await port.post({ kind: 'head', dept: 'hq' }, { channelId: BOT_LOG_CHANNEL_ID }, { type: 'alert', origin: 'governance', title: 'Approval batch not posted', body: text })),
  });
  // AI-APPROVE-1: the AI approver. Off until `approval.ai.enabled` is set; the shared `secrets` array (it grows at boot) masks every text it builds.
  const aiApproverRepo = new AiApproverRepo(pool);
  const aiApprover = new AiApprover({ cfg, repo: aiApproverRepo, approvals, tasks, tools, halt: agentHalt, audit, secrets, org, prompts, overrides, providers, fallback: fallbackGate, call: smallDeps.call, log });
  // GROW-1: the AI skill judge (off until `skills.ai.enabled`). SkillService is built before the providers path exists, so it gets the judge by setJudge.
  const skillAiRepo = new SkillAiRepo(pool);
  const skillJudge = new SkillJudge({
    cfg, svc: skillService, proposals: skillRepo, repo: skillAiRepo, halt: agentHalt, audit, secrets, org, prompts, overrides, providers, fallback: fallbackGate, call: smallDeps.call, log,
    notify: async (title, text) => void (await port.post({ kind: 'head', dept: 'hq' }, { channelId: CONFIG_CHANNEL_ID }, { type: 'alert', origin: 'governance', title, body: text })),
  });
  skillService.setJudge(skillJudge);
  const aiDigest = new AiDigest({ repo: aiApproverRepo, skills: skillAiRepo, autopilot: projects, releases: releaseDigestDeps(releaseRepo), mcp: mcpDigestDeps(mcpRepo), forge: forgeDigestDeps(forgeRepo), cfg, secrets, now, log, daily: dailyRuns, post: (p) => port.post({ kind: 'head', dept: 'hq' }, { channelId: BOT_LOG_CHANNEL_ID }, p) });
  const scheduler = new Scheduler({ autopilot: { projectOf: (id) => autopilot.projectOf(id) }, aiApprover, heal: healRepo, retro: retroRepo, guildId: env.guildId, questions: new QuestionRepo(pool), ot, ...(batching ? { batching } : {}), teamtalk, incidents, guardStore: new GuardStateRepo(pool), meetings, board, agent, admin: { audit }, approvedTools: approved, conversation, prawRate, vision, port, secrets, org, tasks, limits, halt, cfg, bus, paused: () => presence.paused(), providerReady, online, calendar, log, now, provenance: botMessages, postOnly: postOnlyRooms, rhythm, statusBoard, approvalChannel: (a) => approvalRooms.channelFor(a), webGrantEnabled: () => cfg.get('web.taskGrant.enabled') === true, taskGrantOffer, pendingApprovals: (id) => tasks.pendingApprovalCount([id]), quotaHold: quotaStore, fallback: fallbackGate });
  scheduler.attach();
  projectService.attach(bus, (what, fn) => scheduler.track(what, fn)); // AUTO-1: a root task that ends ends its project
  // Gate 1 WS-C12 / SA-1 C13: the halt flag is latched before hooks run, so killAll always sees a halted company. Registered after the scheduler exists so idle() waits for it.
  if (wsService) halt.onHalted(() => scheduler.track('ws.halt', () => wsService.killAll()));
  // GROW-1: the weekly retro timer (Friday 16:00 by default, one run per department per ISO week; off with grow.retro.enabled, while halted and on off days).
  const weeklyRetro = new WeeklyRetro({
    cfg, calendar, org, repo: retroRepo, canRun: () => scheduler.canRun(), isHalted: () => halt.isHalted(), online, limits, now, log, audit,
    start: (a) => scheduler.retroStart({ ...a, dept: a.dept as DeptId }),
  });
  // LEARN-1 (D2): the incident sweep (code only, every 300 s and once at start, on off days too; off with grow.incidents.enabled and while halted).
  const incidentSweep = new IncidentSweep({ cfg, repo: deptIncidentRepo, canRun: () => scheduler.canRun(), log });
  const healer = new Healer({
    repo: healRepo, tasks, cfg, calendar, secrets, now, log,
    retry: (id, o) => retryBlocked({ tasks, bus, isHalted: () => halt.isHalted(), turnsCap: () => cfg.get('limits.turnsPerTask') }, id, o),
    wake: (a) => scheduler.healWake(a), isHealing: (id) => scheduler.isHealing(id), canRun: () => scheduler.canRun(),
    pendingApprovals: (id) => tasks.pendingApprovalCount([id]), daily: dailyRuns,
    held: (a) => scheduler.isHeld(a), openCounts: () => tasks.dashboardCounts(), holdUntil: () => quotaStore.heldUntil(), // OPS-HOLD
    post: (p) => port.post({ kind: 'head', dept: 'hq' }, { channelId: BOT_LOG_CHANNEL_ID }, p),
  });

  // Task 37 (P20): voice chat; off with the voice group (ffmpeg or the voice library missing, P22).
  const voiceChat = !mediaBackend || media.disabled.some((d) => d.id === 'voice') ? null : prawVoiceChat({
    voice, guildId: env.guildId, client: () => clients.client('praw'), voiceChannelOf, metered, cfg, ask: (m, opts) => scheduler.ask(m, opts), log, audit, secrets, clock: now, musicPlaying: () => music?.isPlaying() ?? false,
    post: async (channelId, body) => void (await port.post({ kind: 'head', dept: 'praw' }, { channelId }, { type: 'chat', body })),
    media: mediaBackend, ...(o.voice?.tts ? { tts: o.voice.tts } : {}),
  });

  // SPEND-1: department budgets, the raise card, alerts and the weekly summary. Alerts and the summary go to #🧾-bot-log, the card to #⚙️-setting; none pings.
  const spendRepo = new SpendRepo(pool);
  // R8: the Claude API spend of the current UTC day (spend_days rows of provider `claude`), for the end alert and the /usage line.
  claudeSpendToday = async () => {
    // spend_days.day is the schedule-timezone day (Budget `rollupDay`), not the UTC day of the company cap; this line reads the same day the spend trend and the weekly summary do.
    const day = localDay(now(), cfg.get('schedule.timezone')).date;
    const rows = (await spendRepo.trend(day, day)).filter((r) => r.provider === 'claude');
    return { usd: rows.reduce((a, r) => a + r.usd, 0), calls: rows.reduce((a, r) => a + r.calls, 0) };
  };
  const spendAlerts = new SpendAlerts(
    spendRepo,
    { alert: async (p) => void (await port.post({ kind: 'head', dept: 'hq' }, { channelId: BOT_LOG_CHANNEL_ID }, p)) },
    log, incidents, (r) => summaryRenderer(spendRepo, spendOverrides, cfg, now)(r),
  );
  const spendOverrides = new SpendOverrides({
    pool, cfg, clock: now, configChannelId: CONFIG_CHANNEL_ID, alerts: spendAlerts, audit, log,
    ports: { postCard: (p) => port.post({ kind: 'head', dept: 'hq' }, { channelId: CONFIG_CHANNEL_ID }, p) },
  });
  const spendWatch = new SpendWatch({ repo: spendRepo, cfg, overrides: spendOverrides, alerts: spendAlerts, clock: now, offDay: (t) => calendar.isOffDay(t), log });
  const unbindSpendStop = bindSpendStop(bus, spendOverrides, log);

  // R6 MCP-1 (spec 6): McpAdmin is built here and held by nothing but the closure below; AdminConsole gets `adminCmd`, which has no `mcp`.
  const mcpAdmin = new McpAdmin({
    repo: mcpRepo, docker: mcpDocker, sandbox: mcpSandbox, host: mcpHostGate, halted: () => halt.isHalted(), deptExists: (id) => org.dept(id) !== null, audit, secrets: () => secrets, log,
  });
  // R7 PLUGIN-FORGE (spec 6): ForgeService is built right after McpAdmin. It holds the one forgeStageDeps closure (no other method of the MCP admin), the repo and the builder's docker port; the AdminConsole
  // object below has no such key. Notices carry fixed code text: the heads through Scheduler.notifyHead, the Bot Admin alert in #setting, the incident alerts in #bot-log.
  const forgeOn = (): boolean => { try { return cfg.get('forge.enabled') === true; } catch { return false; } }; // a read error is off, at every site
  const forgeNotify = async (n: ForgeNotice): Promise<void> => {
    if (n.kind === 'staged_hq') await port.post({ kind: 'head', dept: 'hq' }, { channelId: CONFIG_CHANNEL_ID }, { type: 'alert', origin: 'governance', title: 'Plugin forge: staged', body: n.text });
    else if (n.kind === 'alert') await port.post({ kind: 'head', dept: 'hq' }, { channelId: BOT_LOG_CHANNEL_ID }, { type: 'alert', origin: 'governance', title: 'Plugin forge', body: n.text });
    else await scheduler.notifyHead(n.deptId, n.text);
  };
  const forgeService = new ForgeService({
    repo: forgeRepo, docker: o.forge?.docker ?? realDockerCli(), stage: forgeStageDeps(mcpAdmin), baseImageId: forgeBaseId, stageRoot: o.forge?.stageRoot ?? join(tmpdir(), 'assistant-forge'),
    isHalted: () => halt.isHalted(), forgeEnabled: forgeOn, tz: () => cfg.get('schedule.timezone'), audit, notify: forgeNotify, log,
  });
  // G2-RL-03: the admin console (AI-driven) gets this object, which has no `releases` key; `commands` adds the four release closures after it and is the only object that carries them.
  const adminCmd: CommandDeps = {
    guildId: env.guildId,
    adminRoleId: env.botAdminRoleId,
    masterKey: env.configMasterKey,
    cfg,
    org,
    repos: { ...orgRepos, overrides, providerKeys: new ProviderKeyRepo(pool) },
    prompts,
    halt,
    approvals,
    budget,
    quota: quotaStore,
    // R8: the "Backup:" line of /usage range:quota. Only where both the subscription provider and the API key are registered (it says "off" with the key loaded, PV-C11).
    fallback: {
      line: async () => {
        if (!providers.has('claude') || !providers.has('claude-code-local')) return null;
        const enabled = fallbackEnabled(cfg);
        const route = quotaStore.heldUntil() === null ? 'subscription' as const : enabled && fallbackGate.usable({ kind: 'head', dept: 'hq' }, 'hq') ? 'Claude API' as const : 'held' as const;
        const spent = await claudeSpendToday().catch(() => ({ usd: 0, calls: 0 }));
        return usageBackupLine({ enabled, route, usd: spent.usd, capUsd: cfg.get('budget.companyDailyUsd') });
      },
    },
    llmUsage: new LlmUsageRepo(pool),
    spend: {
      report: (by) => spendReport(spendRepo, spendOverrides, cfg, now(), by),
      effectiveCap: (dept) => spendOverrides.effectiveCap(dept, spendOverrides.month()),
      supersede: (dept, userId) => spendOverrides.supersede(dept, userId),
      decide: (c) => spendOverrides.decide(c),
    },
    grow: { requests: toolRequests, ideas: toolIdeas },
    projects: projectService,
    cards: { close: (c, m, n, r) => port.closeCard(c, m, n, r), update: (c, m, p) => port.updateCard(c, m, p) }, // the revoke argument must reach the port, or the grant card gets no Revoke button
    batches: batchRepo,
    webGrants,
    taskGrants,
    taskAdmin: { tasks, approvals, taskRuns, scheduler, webGrants, bus, isHalted: () => halt.isHalted(), nonces: new NonceStore(() => now()) }, // TASKADMIN-1
    taskGrantOffer,
    aiApprover: aiApproverRepo,
    taskCard: taskCards,
    ot,
    secrets,
    settings: {
      notice: async (text) => void (await port.post({ kind: 'head', dept: 'hq' }, { channelId: BOT_LOG_CHANNEL_ID }, { type: 'alert', origin: 'governance', title: 'Setting changed (risk)', body: text })),
      channels: () => port.listGuildChannels(),
    },
    audit,
    providers,
    tools: { plugins: () => tools.names().filter((n) => !builtinNames.includes(n)) },
    skills: skillService,
    retro: { request: (dept, by) => weeklyRetro.request(dept, by) }, // LEARN-1 (LL-C7)
    ...(wsService ? { ws: { list: () => wsService.list(), archive: (slug: string, userId: string) => wsService.archive(slug, userId) } } : {}),
    log,
    ...(gh && 'client' in gh ? { github: gh.client } : {}),
    ...(clickup ? { clickup, clickupSeen: clickupSeenRepo } : {}),
  };
  const commands: CommandDeps = { ...adminCmd, releases: releaseCommandDeps(releaseService), mcp: mcpCommandDeps(mcpAdmin), forge: forgeCommandDeps(forgeService) };

  // Admin console (Gate 1 C3-C7): the confirmation cards live in the database; its tools sit in their own registry, never the normal one.
  const adminCards = new AdminCardRepo(pool);
  // Phase 2 (Gate 1 S2, option A): every Discord write for roles, channels, members, moderation, AutoMod, server and events runs in the SEPARATE
  // executor process "LW Admin" (executor/), which alone holds BOT_TOKEN_ADMIN. This process only forwards proposals and confirmed card ids over a
  // local socket; without EXECUTOR_SOCKET those operations are simply off.
  const alertDisabled = async (dept: string, warnings: string[]) => void incidents.report({ source: 'boot', stage: 'executor client', dept, err: new IncidentError('client_disabled', `the ${dept} bot was turned off because its permissions are unsafe: ${warnings.join('; ')}`, 'Fix the Discord permissions of that bot, then restart.', undefined, true) });
  const executor = env.executorSocket ? new ExecutorClient({ socketPath: env.executorSocket, recheck: () => clients.recheck(), alert: alertDisabled, log }) : undefined;
  const execRepo = new ExecRepo(pool);
  const outbox = executor ? new OutboxPump({ exec: execRepo, port, cfg, botLogChannelId: BOT_LOG_CHANNEL_ID, log }) : undefined;
  // S14: the executor judges the default roles; Praw's own client must be able to see and send in the welcome channel.
  const welcomeCheck = executor ? {
    async check(roleIds: readonly string[], channelId: string | null): Promise<string | null> {
      const why = await executor.checkWelcome(roleIds, channelId);
      if (why || channelId === null) return why;
      const ch = await clients.client('praw')?.channels.fetch(channelId).catch(() => null);
      if (!ch || !ch.isTextBased() || ch.isDMBased()) return 'Praw cannot see the welcome channel';
      const me = ch.guild.members.me;
      return me && ch.permissionsFor(me)?.has(PermissionFlagsBits.ViewChannel | PermissionFlagsBits.SendMessages) ? null : 'Praw cannot send messages in the welcome channel';
    },
  } : undefined;
  let panel: SettingsPanel | null = null;
  const adminConsole = new AdminConsole({
    guildId: env.guildId, adminRoleId: env.botAdminRoleId, cards: adminCards, cfg, cmd: adminCmd, port, audit, log, secrets,
    hqUserId: () => clients.client('hq')?.user?.id, provenance: botMessages, knowledge, proposals: proposalRepo, skills: skillService,
    ...(executor ? { perms: executor.port('perm'), server: executor.port('server'), deploy: executor.port('deploy'), code: executor.port('code'), tiers: { check: (n: Parameters<ExecutorClient['checkTiers']>[0]) => executor.checkTiers(n) } } : {}), ...(welcomeCheck ? { welcome: welcomeCheck } : {}),
    afterApply: () => void panel?.refresh(), // S37e: the panel shows live values and follows every apply
  });
  // The settings front ends (Discord panel, local dashboard) reach the console only through this registry (no second write path).
  const settings = new SettingsRegistry({ takeSlot: (userId) => scheduler.takeAdminSlot(userId), audit });
  const execReady = async () => (executor ? executor.readiness() : 'the executor (LW Admin) is not configured in this process (EXECUTOR_SOCKET)');
  settings.bindConsole(adminConsole, execReady, execReady);
  panel = new SettingsPanel({
    guildId: env.guildId, adminRoleId: env.botAdminRoleId, settings, cfg, port: createPanelPort(() => clients.client('hq')), hqUserId: () => clients.client('hq')?.user?.id,
    state: new PanelStateRepo(pool), bots: () => org.heads().map((h) => `${h.id}${h.enabled ? '' : ' (off)'}`).join(', '), audit, log,
  });
  commands.panel = panel;
  const adminRegistry = new ToolRegistry({ halt, incidents });
  // VPS deploy (Gate 1 V22): reads and proposals go to the executor; a packed static site is handed over through the database (the executor is another macOS user).
  const deployRepo = new DeployRepo(pool);
  // Self-code (Gate 1 self-code): off unless the owner turned it on AND the executor has a code root AND the proxy control port is configured.
  let devjobService: DevJobService | undefined;
  if (executor && env.devjob && cfg.get('devjob.enabled')) {
    const dj = env.devjob;
    const sandbox = new DockerSandbox({ docker: realDocker, images: loadImages(process.cwd()) });
    devjobService = new DevJobService({
      repo: new DevJobRepo(pool), sandbox, workDir: dj.workDir, supply: makeSupplyPort(fetch as unknown as FetchLike),
      models: proxyControl({ url: dj.proxyControlUrl, token: dj.proxyToken, fetch: fetch as unknown as ControlFetch }), source: localSource(dj.sourceRepo),
      cfg: { budgetUsd: () => cfg.get('devjob.budgetUsd'), jobCapUsd: () => cfg.get('devjob.jobCapUsd'), ownerUserId: () => cfg.get('devjob.ownerUserId') },
      halted: () => halt.isHalted(), offDay: () => calendar.isOffDay(now()).off, audit, log,
      postCard: async (p, payload) => {
        const r = await adminConsole.proposeCode({ userId: p.confirmerId, tainted: false, via: 'praw' }, payload);
        return r.ok && r.cardId ? { ok: true, cardId: r.cardId } : { ok: false, error: r.ok ? 'no card was created' : r.error };
      },
    });
    void devjobService.recover();
    bus.on('halt.changed', (e) => { if (e.halted) void devjobService?.halt(); else void devjobService?.pump(); });
  }
  for (const t of adminTools({ console: adminConsole, ...(devjobService ? { code: { request: (r) => devjobService!.request(r), rollback: (u) => executor!.codeRollback(u) } } : {}), ...(executor ? { deploy: { read: (u, r) => executor.deployRead(u, r), site: { pack: (dir) => packWorkspaceDir(workspaceRoot, dir), store: (sha, tar, u) => deployRepo.putUpload(sha, tar, u) } } } : {}) })) adminRegistry.register(t);
  assertRegistryDeclared(adminRegistry, ['admin']); // R4 (PM-C4): the admin registry is declared in admin/manifest.ts too
  agent.adminTools = adminRegistry;
  commands.admin = adminConsole;

  const watchNet = { resolver: o.net?.resolver ?? systemResolver, transport: o.net?.transport ?? systemTransport, extraPorts: () => cfg.get('net.extraPorts'), ...(web.browser ? { browser: web.browser } : {}), ...(web.disabled ? { browser: unavailableBrowser() } : {}) };
  const prawCommands = prawCommandDeps({
    guildId: env.guildId, adminRoleId: env.botAdminRoleId, org, cfg, rate: prawRate, vision, ask: (m, opts) => scheduler.ask(m, opts), audit, log,
    reminders: reminderRepo, schedules: jobRepo, watches: watchRepo, lessons: lessonRepo,
    watchNet, clock: now, ...(music ? { music } : {}), ...(voiceChat ? { voiceChat } : {}),
  });
  const reminderWorker = new ReminderWorker({ repo: reminderRepo, port, clock: now, log, audit, canRun: () => scheduler.canRun(), enabled: () => org.dept('praw')?.enabled !== false });

  const jobRunner = new JobRunner({
    repo: jobRepo, port, submit: (t) => scheduler.submitTask(t), canRun: () => scheduler.canRun(), capacity: () => scheduler.jobCapacity(), clock: now, log, audit,
    enabled: () => org.dept('praw')?.enabled !== false, offDay: offDayAt,
  });

  const watchPoller = new WatchPoller({
    repo: watchRepo, port, net: watchNet, search: ddgBackend(watchNet), canRun: () => scheduler.canRun(), clock: now, log, audit,
    enabled: () => org.dept('praw')?.enabled !== false, offDay: () => offDayAt(now()),
  });

  // Task 27: only with ClickUp configured. Posts to clickup.notifyChannelId, else Praw's mapped home channel; no model runs here (PF15).
  const clickupPoller = clickup ? new ClickUpPoller({
    client: clickup, seen: clickupSeenRepo, port, clock: now, log, audit,
    channel: async () => resolveNotifyChannel(cfg.get('clickup.notifyChannelId'), org.dept('praw')?.workChannelId, await orgRepos.channelMap.list()),
    intervalSec: () => cfg.get('clickup.pollIntervalSec'), canRun: () => scheduler.canRun(),
    enabled: () => org.dept('praw')?.enabled !== false,
    // workspace mode polls only the watched lists (clickup.pollListIds, read every tick; empty = no request at all)
    ...(clickup.mode === 'workspace' ? { watched: () => cfg.get('clickup.pollListIds') } : {}),
  }) : undefined;

  let health: HealthServer | null = null;
  let dashboard: RunningDashboard | null = null;
  let expiry: NodeJS.Timeout | null = null;
  let adminSweep: NodeJS.Timeout | null = null;
  let toolReqSweep: NodeJS.Timeout | null = null;
  let releaseSweep: NodeJS.Timeout | null = null;
  let forgeTick: NodeJS.Timeout | null = null;
  let forgeGcTick: NodeJS.Timeout | null = null;
  let projectSweep: NodeJS.Timeout | null = null;
  let meetingTick: NodeJS.Timeout | null = null;
  let rhythmTick: NodeJS.Timeout | null = null;
  let askTick: NodeJS.Timeout | null = null;
  let healTick: NodeJS.Timeout | null = null;
  let retroTick: NodeJS.Timeout | null = null;
  let deptIncidentTick: NodeJS.Timeout | null = null; // LEARN-1 (`incidents` is BOTLOG-1's)
  let aiDigestTick: NodeJS.Timeout | null = null;
  let offDays: OffDayWatch | null = null;
  const unwatch: (() => void)[] = [unbindSpendStop, unwatchOt, unwatchTaskGrant, unbindTaskRoot];
  let stopped = false;
  let starting: Promise<void> | null = null;
  const services: AppServices = {
    secrets, scheduler, taskRuns, jobRunner, cfg, halt, approvals, ...(batching ? { batching } : {}), budget, tasks, org, port, clients, presence, commands, prawCommands, providers, quota: quotaStore, fallback: fallbackGate, voice, music, adminConsole,
    mcp: { booted: () => mcpBooted, names: () => mcpHost.names() },
    healthUrl: () => health?.url() ?? null,
    dashboardUrl: () => dashboard?.server.url() ?? null,
    offDayTick: async () => {
      offDays?.check();
      await offDays?.idle();
    },
  };

  return {
    services,
    start() {
      if (stopped) return Promise.reject(new Error('app stopped'));
      return (starting ??= (async () => {
        // Gate 1 S38: only in local mode, never in a container. Started before the Discord clients so /dashboard works from the first interaction.
        dashboard = await bootDashboard({
          local: o.dashboard?.local ?? process.env.ALLOW_LOCAL_PROVIDERS === '1',
          inContainer: o.dashboard?.inContainer ?? (() => inContainer(nodeGuardFs)),
          port: o.dashboard?.port ?? dashboardPortFrom(process.env.DASHBOARD_PORT),
          store: new DashboardRepo(pool), audit, console: adminConsole, settings, log,
          devjobs: { list: () => new DevJobRepo(pool).list(30), byHead: (h) => new DevJobRepo(pool).getByHead(h) },
          knowledge: createKnowledgePanel({ service: knowledge, proposals: proposalRepo, kb: kbRepo, notes: noteRepo, lessons: lessonRepo, overrides, audit }),
          // Env entry (Gate 1 env-entry): the owner's local env file; the notice goes to #bot-log as hq with key name and admin only (E18).
          env: {
            dir: o.dashboard?.envDir ?? join(homedir(), '.config', 'assistant'),
            notify: async (text) => void (await port.post({ kind: 'head', dept: 'hq' }, { channelId: BOT_LOG_CHANNEL_ID }, { type: 'alert', origin: 'governance', title: 'Env key changed', body: text })),
          },
          isAdmin: async (userId) => {
            // S47: a live fetch through hq, never a cache. Any failure is a refusal (the caller treats a throw as "not an admin").
            const hq = clients.client('hq');
            if (!hq) return false;
            const guild = hq.guilds.cache.get(env.guildId) ?? (await hq.guilds.fetch(env.guildId));
            return (await guild.members.fetch({ user: userId, force: true })).roles.cache.has(env.botAdminRoleId);
          },
          data: {
            status: async () => {
              const off = calendar.isOffDay(now());
              const db = await pool.query('SELECT 1').then(() => 'ok', () => 'error');
              return { db, clients: clients.online(), halted: halt.isHalted(), provider: providerReady() ? 'ok' : 'unavailable', offDay: off.off, ...(off.reason ? { offDayReason: off.reason } : {}) };
            },
            readConfig: (keys) => keys.filter((k) => (ADMIN_READ_KEYS as readonly string[]).includes(k)).map((key) => ({ key, value: cfg.get(key) })),
            pendingCards: () => adminCards.listPending(),
            audit: (q) => auditRepo.query(q),
            spend: () => spendView(spendRepo, spendOverrides, cfg, now()),
            channels: () => port.listGuildChannels().catch(() => null),
            lockedChannels: () => DENIED_CHANNEL_IDS.length,
            // S9/S48: the member list goes through the executor (LW Admin); absent without it. At most 50 rows, no avatars.
            ...(executor ? { members: async () => {
              const r = await executor.port('server').read('members');
              if (!r.ok) throw new Error('members unavailable');
              return (JSON.parse(r.text) as { id: string; name: string; roles: string[] }[]).map((m) => ({ id: m.id, name: m.name, roles: m.roles }));
            } } : {}),
          },
        });
        if (dashboard) commands.dashboard = { link: (userId) => dashboard!.link(userId) };
        const started = await startApp({
          secrets, env, log, pool, org, orgRepos, tasks, halt, approvals, budget, scheduler, port, clients, presence, inbound, commands, prawCommands, bus,
          unknownTools, incidents, bootNotes: stateRepo, healRepo, retroRepo,
          toolGroups: [...groups.disabled.filter((g) => !media.disabled.some((m) => m.id === g.id)), ...media.disabled],
          denylistCheck,
          ...(localRefusedCode ? { localRefused: { code: localRefusedCode, audit: () => audit({ actor: 'system', action: 'provider.local.refused', taskId: null, tool: null, outcome: localRefusedCode! }) } } : {}),
          provider: { ready: providerReady, current: () => cfg.get('provider.default').provider, watch: (fn) => cfg.watch('provider.default', fn) },
          healthPort: o.healthPort ?? env.healthPort,
          healthHost: env.healthHost,
          calendar: { cal: calendar, now },
          ot,
        });
        health = started.health;
        if (otBootRevoked.length) { const rows = otBootRevoked; otBootRevoked = []; void ot.closeRevoked(rows, 'the company was halted'); } // G2OT-01: the clients are up now
        void scheduler.recoverAiReviews(); // AI-APPROVE-1: escalate the reviews a restart cut short, then post their cards
        void toolRequests.recover().then(() => toolRequests.sweep()); // GROW-1 (GW-C20): reconcile a claim a crash left half done, then expire what ran out while down
        void skillJudge.recover(bootTime); // GROW-1: escalate the skill reviews a restart cut short and post their notices (the clients are up now)
        void scheduler.track('release.recover', async () => { await releaseService.recover(releaseBootTime); await releaseService.sweep(); }); // R5 (RL-C5): fail what a crash left releasing (never re-posted), then expire what ran out while down
        // R6 MCP-1 (spec 5.14): the boot runs in the background, only while `mcp.enabled` is exactly true (a read error is off), and again when the switch is turned on. It never throws and
        // never blocks the start. With the switch off nothing here touches Docker.
        const mcpOn = (): boolean => { try { return cfg.get('mcp.enabled') === true; } catch { return false; } };
        let mcpBooting = false;
        const mcpBoot = (): void => {
          if (mcpBooted || mcpBooting || stopped) return;
          mcpBooting = true;
          void scheduler.track('mcp.boot', async () => {
            try {
              const r = await bootMcp({ docker: mcpDocker, repo: mcpRepo, host: mcpHost, audit, log });
              mcpBooted = r.ok;
              if (r.ok) {
                await mcpHost.refresh(); // a change that landed between the load and the flag
                if (r.missing.length) void mcpAlert('MCP images missing', `MCP server image missing, not loaded: ${r.missing.join(', ')}.`);
              }
            } finally {
              mcpBooting = false;
            }
          });
        };
        if (mcpOn()) mcpBoot();
        unwatch.push(cfg.watch('mcp.enabled', () => { if (mcpOn()) mcpBoot(); }));
        // R7 PLUGIN-FORGE (spec 3.6, PF-C17): the recover (clean the stage root, sweep forge containers, requeue or fail the builds a crash left, check the base) runs in the background only while `forge.enabled`
        // is exactly true, and again once when the switch is turned on; with the switch off nothing here touches Docker. The tick (30 s) and the GC (10 min) never throw and do nothing while off or halted.
        let forgeRecovered = false;
        let forgeRecovering = false;
        const forgeBoot = (): void => {
          if (forgeRecovered || forgeRecovering || stopped) return;
          forgeRecovering = true;
          void scheduler.track('forge.recover', async () => {
            try { await forgeService.recover(); forgeRecovered = true; } finally { forgeRecovering = false; }
          });
        };
        if (forgeOn()) forgeBoot();
        unwatch.push(cfg.watch('forge.enabled', () => { if (forgeOn()) forgeBoot(); }));
        forgeTick = setInterval(() => void scheduler.track('forge.tick', async () => { if (forgeRecovered) await forgeService.tick(); }), o.forge?.tickMs ?? TICK_MS); // never before the recover has finished: it requeues the builds a crash left, and a tick must not claim one it would then requeue
        forgeTick.unref();
        forgeGcTick = setInterval(() => void scheduler.track('forge.gc', async () => { if (forgeOn()) await forgeService.gc(); }), o.forge?.gcMs ?? GC_MS); // GC only touches Docker while the forge is on
        forgeGcTick.unref();
        void scheduler.recoverApprovalBatches(); // APPROVAL-BATCH-1: seal and post the batches a restart left behind (the clients are up now)
        void panel.ensure(); // S37b: refresh the stored panel message, or re-post it once if it is gone
        expiry = started.expiry;
        // Cards that ran out while the process was down are expired and closed now, then every minute (the SQL check guards clicks regardless).
        // C20: a configured executor that is not ready (constants, hierarchy, permissions) is reported once at boot; an unconfigured one stays off.
        if (executor) {
          void (async () => {
            // `npm run dev` starts the executor next to the app and it needs a moment (migrations, Discord login): ask for up to ~90 s before alerting.
            let why = await executor.readiness();
            for (let i = 0; why && i < 18 && !stopped; i++) {
              await new Promise<void>((r) => setTimeout(r, 5000).unref());
              why = await executor.readiness();
            }
            if (why && !stopped) incidents.report({ source: 'executor', stage: 'readiness', err: new IncidentError('executor_not_ready', `Praw cannot change the server: ${why}`, 'Start the executor (npm run dev starts it) and check LW Admin permissions/constants.', undefined, true) });
          })().catch((err: unknown) => log.error({ err }, 'executor readiness check failed'));
          outbox?.start();
        }
        await adminConsole.sweep().catch((err: unknown) => log.error({ err }, 'admin card sweep failed'));
        adminSweep = setInterval(() => void adminConsole.sweep().catch((err: unknown) => log.error({ err }, 'admin card sweep failed')), 60_000);
        adminSweep.unref();
        toolReqSweep = setInterval(() => void toolRequests.sweep(), 60_000); // GROW-1: expire 7 day old tool requests, close the card, tell the head (never throws)
        toolReqSweep.unref();
        releaseSweep = setInterval(() => void scheduler.track('release.sweep', async () => { await releaseService.sweep(); }), 60_000); // R5: expire 7 day old release requests, close the card, tell the head (never throws)
        releaseSweep.unref();
        void projectService.tick(); // AUTO-1: expire proposals that ran out while down, owe the deadline notices; then every minute (never throws)
        projectSweep = setInterval(() => void projectService.tick(), 60_000);
        projectSweep.unref();
        offDays = started.offDays;
        // An edited calendar (a holiday added by mistake and removed again) is re-checked at once, not on the next minute poll.
        for (const k of ['schedule.offDays', 'schedule.holidays', 'schedule.workDays', 'schedule.timezone'] as const) unwatch.push(cfg.watch(k, () => void offDays?.check()));
        unwatch.push(cfg.watch('dashboard.channelId', () => statusBoard.touch()));
        if (!stopped) {
          reminderWorker.start();
          void mediaJobs?.start().catch((e) => log.warn({ errName: e instanceof Error ? e.name : 'unknown' }, 'media jobs did not resume'));
          selfReview.start();
          spendWatch.start();
          jobRunner.start();
          // TW13: the weekly meetings are started by code, about once a minute, when a configured time has come and it is a workday.
          meetingTick = setInterval(() => void meetings.tick().catch((err: unknown) => log.error({ err }, 'meeting tick failed')), 60_000);
          meetingTick.unref();
          // WS11: the CEO's daily goal and evening report, started by code about once a minute on workdays (off while rhythm.dailyGoalChannelId is null).
          rhythmTick = setInterval(() => void rhythm.tick().catch((err: unknown) => log.error({ err }, 'rhythm tick failed')), 60_000);
          rhythmTick.unref();
          // ASKBACK-1: expired questions end (their owner continues once), a wake that never started starts, an owner not yet resumed is resumed; a no-op while halted.
          askTick = setInterval(() => void scheduler.askTick().catch((err: unknown) => log.error({ err }, 'ask tick failed')), 60_000);
          askTick.unref();
          // HEAL-1: blocked tasks are retried by code or their deciding head is woken; at most 3 per tick, a no-op while halted, on an off day or with heal.enabled off.
          healTick = setInterval(() => void healer.tick().catch((err: unknown) => log.error({ errName: err instanceof Error ? err.name : 'error' }, 'heal tick failed')), 60_000);
          healTick.unref();
          retroTick = setInterval(() => void weeklyRetro.tick().catch((err: unknown) => log.error({ errName: err instanceof Error ? err.name : 'error' }, 'retro tick failed')), 60_000);
          retroTick.unref();
          void incidentSweep.tick();
          deptIncidentTick = setInterval(() => void incidentSweep.tick(), 300_000);
          deptIncidentTick.unref();
          // AI-APPROVE-1: the daily AI approval digest at 18:00 (schedule.timezone), on off days too; posts only with at least one review.
          aiDigestTick = setInterval(() => void aiDigest.tick().catch((err: unknown) => log.error({ errName: err instanceof Error ? err.name : 'error' }, 'ai digest tick failed')), 60_000);
          aiDigestTick.unref();
          statusBoard.touch();
          watchPoller.start();
          clickupPoller?.start();
          // CLICKUP-ALL-1 (C3): workspace mode is announced once (audit row without ids, one #bot-log notice); the team is resolved now so a wrong CLICKUP_TEAM_ID is seen at boot.
          if (clickup?.mode === 'workspace') {
            const all = clickup.teamScope === 'all';
            // HEAL-1 (H5, HL-C19): announced once per mode: a restart with the same mode as the newest audit row posts nothing and writes no row (a read error announces).
            const mode = all ? 'workspace-all' : 'workspace';
            const announce = await modeNeedsNotice(mode, () => auditRepo.latestOutcome('clickup.mode'));
            if (announce) void audit({ actor: 'system:clickup', action: 'clickup.mode', tool: 'clickup', outcome: mode }).catch(() => undefined);
            // all mode: the notice carries the count only, so it follows the first resolution of the workspace set
            if (!all && announce) void port.post({ kind: 'head', dept: 'hq' }, { channelId: BOT_LOG_CHANNEL_ID }, { type: 'alert', origin: 'governance', title: 'ClickUp workspace mode', body: 'ClickUp is in workspace mode: the bots can read every project of the workspace, and every write needs approval.' }).catch(() => undefined);
            void (all ? clickup.scope.teamsReady().then((n) => { if (announce) void port.post({ kind: 'head', dept: 'hq' }, { channelId: BOT_LOG_CHANNEL_ID }, { type: 'alert', origin: 'governance', title: 'ClickUp all-workspaces mode', body: `ClickUp all-workspaces mode: the bots can read every project of ${n} workspace(s) this token can see; every write needs approval.` }).catch(() => undefined); }) : clickup.scope.team()).catch((err: unknown) => {
              const reason = err instanceof TeamError ? err.reason : 'unavailable'; // a reason code only: never an id or vendor text
              log.warn({ reason }, 'clickup workspace not resolved');
              void audit({ actor: 'system:clickup', action: 'clickup.workspace.unresolved', tool: 'clickup', outcome: reason }).catch(() => undefined);
            });
          }
        }
      })());
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      stopping = true;
      // A stop during boot (e.g. SIGTERM) waits for start() to settle, then tears down whatever it brought up.
      await starting?.catch((err: unknown) => log.error({ err }, 'start failed before stop'));
      await outbox?.stop();
      await wsService?.shutdown();
      await jobRunner.stop();
      await watchPoller.stop();
      await clickupPoller?.stop();
      await mediaJobs?.stop();
      await reminderWorker.stop(); // awaits an in-flight pass; pool.end() comes later
      selfReview.stop();
      spendWatch.stop();
      if (expiry) clearInterval(expiry);
      if (adminSweep) clearInterval(adminSweep);
      if (toolReqSweep) clearInterval(toolReqSweep);
      if (releaseSweep) clearInterval(releaseSweep);
      if (forgeTick) clearInterval(forgeTick);
      if (forgeGcTick) clearInterval(forgeGcTick);
      if (projectSweep) clearInterval(projectSweep);
      if (meetingTick) clearInterval(meetingTick);
      if (rhythmTick) clearInterval(rhythmTick);
      if (askTick) clearInterval(askTick);
      if (healTick) clearInterval(healTick);
      if (retroTick) clearInterval(retroTick);
      if (deptIncidentTick) clearInterval(deptIncidentTick);
      if (aiDigestTick) clearInterval(aiDigestTick);
      offDays?.stop();
      for (const u of unwatch.splice(0)) u();
      board.stop();
      statusBoard.stop();
      scheduler.stop();
      // Not a halt (nothing persisted): abort in-flight streams, whose reservations are released; tasks keep their status for recovery.
      halt.abortInFlight();
      await Promise.race([scheduler.idle(), new Promise((r) => setTimeout(r, SHUTDOWN_WAIT_MS).unref())]);
      await health?.close();
      await dashboard?.close();
      await music?.shutdown(); // keeps the queue (paused) for the next boot; the leave below would clear it
      await voice.leave();
      await clients.stop();
      limits.dispose();
      await cfg.close();
      if (!o.pool) await pool.end();
    },
  };
}
