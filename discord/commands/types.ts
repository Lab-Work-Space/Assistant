import type { APIActionRowComponent, APIComponentInMessageActionRow, APIEmbed } from 'discord.js';
import type { Org } from '../../company/org.js';
import type { ConfigStore } from '../../config/store.js';
import type { ApprovalBatchRepo, TaskGrantRepo, TaskRepo, WebGrantRepo, ChannelMapRepo, DepartmentRepo, PersonaRepo, PromptOverrideRepo, ProviderKeyRepo } from '../../db/repos/index.js';
import type { Approvals, AuditFn, Budget, Halt } from '../../governance/index.js';
import type { PromptDoc } from '../../prompts/index.js';
import type { GithubClient } from '../../tools/plugins/github/client.js';
import { buildMessage } from '../embeds/index.js';

/** #⚙️-setting: the only channel commands, modals and approval buttons are accepted from. */
/**
 * G2-MCP-04 (with G2-RL-09): the reviewed list of `CommandDeps` keys the AI-driven AdminConsole must never hold. It checks them at construction (`in`, so even an undefined value throws).
 * Adding a human-only command group here is a reviewed change; the admin/ boundary tests forbid the literals inside admin/, so the console refers to this constant only.
 */
export const ADMIN_FORBIDDEN_CMD_KEYS: readonly string[] = ['releases', 'mcp', 'forge'];
export const CONFIG_CHANNEL_ID = '1565667791938387969';

export interface ModalSpec {
  customId: string;
  title: string;
  inputs: { id: string; label: string; style: 'short' | 'paragraph'; required: boolean; minLength?: number; maxLength: number; /** Prefilled text (at most maxLength). */ value?: string }[];
}

/** Minimal structural view of a discord.js interaction (a thin adapter maps the real one). */
export interface InteractionLike {
  guildId: string | null;
  channelId: string | null;
  userId: string;
  /** Interaction id (unique per interaction; Praw's synthetic message ids derive from it). */
  id?: string;
  /** Display name of the invoker, for the synthetic message author. */
  userName?: string;
  /** True when the invoker is a bot account (Praw's path drops those, P15). */
  userIsBot?: boolean;
  /** Parent channel id when the interaction happened in a thread, otherwise null. */
  parentChannelId?: string | null;
  /** Buttons: the id of the message the button sits on and the user id of that message's author (Gate 1 C5: it must be a stored card posted by hq). */
  messageId?: string | null;
  messageAuthorId?: string | null;
  /** Role ids of the invoking member (empty outside a guild). */
  memberRoleIds: readonly string[];
  isChatInputCommand(): boolean;
  isButton(): boolean;
  isModalSubmit(): boolean;
  /** Select menus (the settings panel, Gate 1 S37a). Absent on fakes that predate it: read as false. */
  isStringSelectMenu?(): boolean;
  /** The chosen option values of a select menu. */
  values?: readonly string[];
  commandName: string;
  subcommand: string | null;
  options: {
    string(name: string): string | null;
    number(name: string): number | null;
    integer(name: string): number | null;
    boolean(name: string): boolean | null;
    channel(name: string): { id: string; parentId: string | null; type?: number } | null;
    /** An attachment option (Task 34): the CDN url, name, size and the type Discord declared (null when it declared none). */
    attachment(name: string): { url: string; name: string; size: number; contentType: string | null } | null;
  };
  /** Button or modal custom id. */
  customId: string;
  /** Modal submit text inputs. */
  field(id: string): string | null;
  reply(r: Reply): Promise<unknown>;
  /** Acknowledge within Discord's 3 s deadline; follow with editReply. */
  deferReply(o: { ephemeral: boolean }): Promise<unknown>;
  editReply(r: Reply): Promise<unknown>;
  /** A follow-up message (ephemeral when the reply says so); used when a refusal must not land in a public deferred reply. */
  followUp?(r: Reply): Promise<unknown>;
  /** Deletes the deferred reply ("thinking…") before an ephemeral follow-up replaces it. */
  deleteReply?(): Promise<unknown>;
  showModal(m: ModalSpec): Promise<unknown>;
}

export interface Reply {
  content?: string;
  embeds?: APIEmbed[];
  /** Buttons (Task 37: the voice opt-in button on the public join notice). */
  components?: APIActionRowComponent<APIComponentInMessageActionRow>[];
  ephemeral: boolean;
  /** Message flag SuppressEmbeds: no link preview (the dashboard login link, Gate 1 S41). */
  suppressEmbeds?: boolean;
  /** Always parse [] (no pings from replies). */
  allowedMentions: { parse: [] };
  /** More messages of the same answer, sent as follow-ups after the reply (each masked like the reply itself). */
  followUps?: Reply[];
}

/**
 * TASKADMIN-1: what `/task list|cancel|retry|done` and the `taskadm:` buttons need. Optional on CommandDeps (older tests have none: the commands then say they are not
 * available). Everything here is the live object the app already has; nothing is a model path (TA-C1).
 */
export interface TaskAdminDeps {
  tasks: Pick<TaskRepo, 'get' | 'update' | 'listOpenAdmin' | 'countByStatus' | 'openSubtree' | 'findByIdPrefix' | 'pendingApprovalCount' | 'acceptDigest' | 'countOpenChildren'>;
  approvals: Pick<Approvals, 'adminCancel'>;
  /** `abort` is passed to adminCancel as its before-emit hook (TA-C9); `active` is the "running now" read. */
  taskRuns: Pick<import('../../agents/tasks/task-runs.js').TaskRuns, 'abort' | 'active'>;
  /** `Scheduler.adminAccept` (TA-C20) and the task-lock busy query (TA-C19, never waited on). */
  scheduler: Pick<import('../../agents/scheduler/scheduler.js').Scheduler, 'adminAccept' | 'isTaskBusy'>;
  webGrants: Pick<WebGrantRepo, 'revokeRoot'>;
  bus: Pick<import('../../core/events.js').EventBus<import('../../core/events.js').AppEvents>, 'emit'>;
  isHalted(): boolean;
  nonces: import('./task-nonce.js').NonceStore;
}

export interface CommandDeps {
  guildId: string;
  adminRoleId: string;
  masterKey: Buffer;
  cfg: Pick<ConfigStore, 'get' | 'set'>;
  org: Pick<Org, 'reload' | 'dept' | 'heads' | 'personasOf' | 'persona'>;
  repos: {
    departments: Pick<DepartmentRepo, 'get' | 'upsert'>;
    personas: Pick<PersonaRepo, 'get' | 'list' | 'upsert' | 'delete'>;
    channelMap: Pick<ChannelMapRepo, 'get' | 'upsert' | 'delete'>;
    overrides: Pick<PromptOverrideRepo, 'getActive' | 'upsert' | 'delete'>;
    providerKeys: Pick<ProviderKeyRepo, 'upsert'>;
  };
  /** Same map the Org uses: new personas register their prompt doc here. */
  prompts: Map<string, PromptDoc>;
  halt: Pick<Halt, 'halt' | 'resume'>;
  approvals: Pick<Approvals, 'decide' | 'resumeApproved'> & Partial<Pick<Approvals, 'decideBatch' | 'decideGrant' | 'decideTaskGrant'>>;
  /** OT-1: overtime requests (the card buttons and the switch). Absent in tests that predate it: an `approval:ot:` button then answers 'Unknown action.'. */
  ot?: Pick<import('../../governance/spend/ot.js').OtService, 'decide' | 'decideDay' | 'revoke' | 'revokeAll'>;
  /** WEBGRANT-1: the grant rows the revoke button and the batch card refresh read (absent in tests that predate it: the grant and revoke buttons then answer 'Unknown action.'). */
  webGrants?: Pick<WebGrantRepo, 'get' | 'revoke' | 'setCard' | 'unrevokedOfMessage'>;
  /** TREEGRANT-1: the task grant rows the revoke button and the card refresh read, and the switch-off revoke (absent in tests that predate it: the task buttons then answer 'Unknown action.'). */
  taskGrants?: Pick<TaskGrantRepo, 'get' | 'revoke' | 'unrevokedOfMessage'> & Partial<Pick<TaskGrantRepo, 'revokeAll'>>;
  /** TREEGRANT-1: the offer a card carries (null: no "Approve the whole task" button on it); async because "no live grant in the tree" is a database read. */
  taskGrantOffer?: (a: import('../../db/repos/index.js').Approval) => Promise<import('../embeds/approval.js').TreeGrantOffer | null>;
  /** TREEGRANT-1: the usage-line editor of a grant's card; the revoke button cancels its pending edit (TG-C17). */
  taskCard?: { closed(grantId: number): void };
  /** APPROVAL-BATCH-1: batch lookups for the card refresh (absent in tests that predate batching: every card then takes today's path). */
  batches?: Pick<ApprovalBatchRepo, 'ofApproval' | 'get' | 'members' | 'pendingIds' | 'close'>;
  /** Literal secrets masked on the refreshed batch card (the list the post path uses). */
  secrets?: readonly string[];
  budget: Pick<Budget, 'usage'>;
  /** USAGE-1: the latest Claude subscription quota snapshot, and model calls/tokens per actor (absent in tests that predate it: those parts are skipped). */
  quota?: { latest(): import('../../db/repos/quota.js').StoredQuota | null };
  /** R8 PROV-FALLBACK: the "Backup:" line of `/usage range:quota` (fixed format, built by the app); null = no line (no key, or no subscription provider). Absent: no line. */
  fallback?: { line(): Promise<string | null> };
  llmUsage?: { byActor(since: Date): Promise<import('../../db/repos/quota.js').ActorUsage[]> };
  /** SPEND-1: trend report, the effective department cap, the cap-change supersede and the raise card click. Absent in tests that predate it. */
  spend?: {
    report(by: import('../../governance/spend/spend.js').GroupBy): Promise<import('../../governance/spend/spend.js').Report>;
    effectiveCap(dept: string): Promise<number>;
    supersede(dept: string, userId: string): Promise<{ count: number; cards: { channelId: string; messageId: string }[] }>;
    decide(c: import('../../governance/spend/spend.js').DecideInput): Promise<import('../../governance/spend/spend.js').Decided>;
  };
  /** Closes the approval card in place after a decision (DiscordPort.closeCard: the posting hq client only, buttons removed). Absent: a public reply instead. */
  cards?: { close(channelId: string, messageId: string, note: string, revoke?: number | { task: number }): Promise<void>; update?(channelId: string, messageId: string, payload: import('../../agents/loop/payload.js').OutboundPayload): Promise<boolean> };
  /** Registered plugin (non-builtin) tool names; `/bot tools` accepts only these. */
  tools: { plugins(): string[] };
  /** Gate 1 L9: provider ids registered in this process; selection refuses any other. */
  providers: { has(id: string): boolean };
  audit: AuditFn;
  log: { error(obj: unknown, msg?: string): void };
  now?: () => Date;
  /** Task 30: `/github allow add` resolves repositories through the App; absent when GitHub is not configured. */
  github?: Pick<GithubClient, 'installationAccount' | 'resolveRepo' | 'deniedIds'>;
  /** CLICKUP-ALL-1: `/clickup watch` checks a list against the workspace scope. Absent when ClickUp is off or in list mode tests. */
  clickup?: Pick<import('../../tools/plugins/clickup/client.js').ClickUpClient, 'mode' | 'listInScope'> & Partial<Pick<import('../../tools/plugins/clickup/client.js').ClickUpClient, 'teamScope'>>;
  /** CLICKUP-ALL-1: `/clickup watch remove` forgets the list's baseline so a later add baselines it silently again. */
  clickupSeen?: Pick<import('../../db/repos/praw.js').ClickUpSeenRepo, 'forgetBaseline'>;
  /** SKILLS-1: the skill library, admin writes and proposals (`/skill`, the skill ops of admin_op_propose). Absent in tests that predate it. */
  skills?: Pick<import('../../skills/service.js').SkillService, 'preview' | 'run' | 'repo' | 'rejectProposal'>;
  /** GROW-1: tool requests (the `toolreq:` buttons, `/tool requests`) and tool ideas (`/tool ideas`, `/tool idea_close`). Absent in tests that predate it. */
  grow?: {
    requests: Pick<import('../../grow/tool-requests.js').ToolRequestService, 'decide' | 'listPending'>;
    ideas: Pick<import('../../grow/tool-ideas.js').ToolIdeaService, 'list' | 'close'>;
  };
  /** AUTO-1: the project service (`/project`, the `projcard:` and `projbud:` buttons). Absent in tests that predate it: the commands then say they are not available. */
  projects?: Pick<import('../../governance/projects.js').ProjectService, 'decideCard' | 'decideBudget' | 'start' | 'list' | 'pause' | 'resume' | 'close' | 'raise' | 'extend'>;
  /** LEARN-1 (LL-C7): `/retro run`. Only the command handler calls it. Absent in tests that predate it: the command then says it is not available. */
  retro?: { request(dept: string | null, by: string): Promise<import('../../grow/retro.js').RequestResult> };
  /** R5 RELEASE-1: the `relcard:` buttons and `/release list|show|reject`. Absent in tests that predate it: the commands then say they are not available. */
  releases?: Pick<import('../../releases/service.js').ReleaseService, 'decide' | 'list' | 'show' | 'reject'>;
  /** R6 MCP-1: `/mcp list|show|add|approve|test|disable|depts` (the closure `mcpCommandDeps(admin)`). Absent in tests that predate it: the commands then say they are not available. */
  mcp?: import('../../mcp/admin.js').McpCommandDeps;
  /** R7 PLUGIN-FORGE: `/forge list|show|cancel` (the closure `forgeCommandDeps(service)`). Absent in tests that predate it: the commands then say they are not available. */
  forge?: import('../../forge/types.js').ForgeCommandDeps;
  /** WS-1: `/ws list` and `/ws archive`. Absent when workspaces are not set up (the commands then say so). */
  ws?: { list(): Promise<import('../../db/repos/workspaces.js').WorkspaceRow[]>; archive(slug: string, userId: string): Promise<boolean> };
  /** The admin console's click path (`admincfg:` buttons, Gate 1 C4); absent in tests that do not need it. */
  admin?: {
    click(c: import('../../admin/console.js').Click): Promise<Reply>;
    /** `/settings set` on a card key (Gate 1 WS9): the same console path as the Praw tools. */
    proposeConfig?(p: import('../../admin/console.js').Proposer, raw: unknown): Promise<import('../../admin/console.js').Proposed>;
    proposeOp?(p: import('../../admin/console.js').Proposer, raw: unknown, note?: string): Promise<import('../../admin/console.js').Proposed>;
    /** `/skill review`: a card for a head's skill proposal (SKILLS-1). */
    mintSkillCard?(userId: string, proposalId: number): Promise<{ ok: true; cardId: string; text: string } | { ok: false; error: string }>;
  };
  /** `/settings`: a risk notice to #🧾-bot-log and the guild's channels (live lookup for channel-valued keys); absent in tests that do not need them. */
  settings?: { notice(text: string): Promise<void>; channels(): Promise<import('../../company/types.js').GuildChannelInfo[]> };
  /** The settings panel in #setting (Gate 1 S37): handles every `panel:` component and modal; absent in tests that do not need it. */
  panel?: { handle(i: InteractionLike): Promise<Outcome> };
  /** AI-APPROVE-1: `/approval ai` pause state (absent in tests that predate it: the subcommand then says it is unavailable). */
  aiApprover?: Pick<import('../../db/repos/ai-approver.js').AiApproverRepo, 'pausedToday' | 'setPause'>;
  /** TASKADMIN-1: the task administration commands (`/task`) and their confirm buttons. Absent in tests that predate it. */
  taskAdmin?: TaskAdminDeps;
  /** `/dashboard`: issues the one-time login link for the local dashboard (S41); absent unless the dashboard runs. */
  dashboard?: { link(userId: string): Promise<{ ok: true; url: string } | { ok: false; error: string }> };
}

/** What a sub-handler returns: a reply, or a modal to show. */
export type Outcome = Reply | { modal: ModalSpec };

export const isModal = (o: Outcome): o is { modal: ModalSpec } => 'modal' in o;

const NO_PING = { parse: [] } as { parse: [] };

export const ephemeral = (content: string): Reply => ({ content, ephemeral: true, allowedMentions: NO_PING });

/** Config-style embed reply (no secrets ever pass through here). */
export function configReply(title: string, body: string, opts: { fields?: { name: string; value: string }[]; ephemeral?: boolean } = {}): Reply {
  const msg = buildMessage({ type: 'config', title, body, fields: opts.fields, origin: 'governance' }, { deptColor: 0x95a5a6 })[0]!;
  return { embeds: msg.embeds, ephemeral: opts.ephemeral ?? false, allowedMentions: NO_PING };
}

/** Embed reply for one changed setting: `old → new`. */
export const changeReply = (what: string, oldV: unknown, newV: unknown): Reply =>
  configReply('Config updated', `**${what}**: ${fmt(oldV)} → ${fmt(newV)}`);

export const fmt = (v: unknown): string => (typeof v === 'string' ? v : v === null || v === undefined ? '(none)' : JSON.stringify(v));

/** Handlers receive only what they need; this is a command handler's signature. */
export type Handler = (i: InteractionLike, deps: CommandDeps) => Promise<Outcome>;
