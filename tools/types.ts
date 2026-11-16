import type { ZodType } from 'zod';
import type { OutboundPayload } from '../agents/loop/payload.js';
import type { OffDay } from '../company/calendar.js';
import type { ActorRef } from '../company/types.js';
import type { DeptId } from '../core/index.js';
import type { Org } from '../company/org.js';
import type { AppEvents, EventBus } from '../core/events.js';
import type { Approval, DeptNoteRepo } from '../db/repos/ledger.js';
import type { Task, TaskOrigin, TaskRepo } from '../db/repos/tasks.js';
import type { ConsumeResult } from '../db/repos/web-grants.js';
import type { TaskConsumeResult } from '../db/repos/task-grants.js';
import type { Approvals } from '../governance/approval/approvals.js';
import type { AuditFn } from '../governance/audit.js';
import type { ToolKind } from './policy-approval.js';
import type { Limits } from '../governance/limits.js';

/** Where the current run came from (R3). Set by code from the task row or the trigger, never by tool input. */
export type ToolOrigin = TaskOrigin;
/** Where the triggering conversation lives, for tools that reply or schedule back to it. */
export type ToolSource = {
  channelId: string; threadId: string | null; messageId: string | null; userId: string | null;
  /** PF20: the triggering message's attachments, set by the creating code path (never by tool input); empty without one. */
  attachments: { url: string; name: string; size: number }[];
  /** RF13: the RF1-verified replied-to message's and the RF7-verified forward snapshot's attachments, set by code; read only by index through read_image. */
  replyAttachments?: { url: string; name: string; size: number }[];
  forwardAttachments?: { url: string; name: string; size: number }[];
  /** Gate 1 S18: the text of the triggering admin message, set by code for `admin_console` runs only; the target ids named in it make ban/kick targets valid. */
  triggerText?: string;
  /** Delegated tiers: set by code for a mod-room run (the author's tier from the message's member roles); absent in #setting and everywhere else. */
  tier?: 'manager' | 'moderator';
  /** T15: the message the triggering mod-room message replies to, set by code; counts as named like an id in the text. */
  replyToId?: string;
};
/** TW6: the daily cap on root tasks created by bots. `acquire` returns a release function (call it once the create finished), or null when the cap is reached. */
export interface RootTaskGate { acquire(): Promise<(() => void) | null> }

/** TW13: what `meeting_start` may do. `refusal` is the non-mutating check (also run again at replay); `start` opens the meeting and returns at once. */
export interface MeetingPort {
  refusal(from: { threadId: string | null }, lifted?: boolean): string | null;
  start(req: { topic: string; agenda: string[]; invitees: DeptId[]; actor: ActorRef; from?: { threadId: string | null }; lifted?: boolean }): Promise<{ ok: true; id: string } | { ok: false; reason: string }>;
}

/**
 * F2: what `warroom_say` may do. The scheduler implements it: it owns the guard, the destination (a fixed code constant, never an argument), the
 * posting, the hourly window per head and the roll-up of the replies. Every refusal is a fixed code-written text.
 */
export interface WarroomSayPort {
  say(req: { actor: ActorRef; text: string; task: Task | null; tainted: boolean; lifted?: boolean; personStarted?: boolean; personAdmin?: boolean; personUser?: string | null }): Promise<{ ok: true; rollup: boolean } | { ok: false; reason: string }>;
}

/**
 * WEBGRANT-1: what `fetch_page.precheck` may do with a task web grant. `consume` spends one fetch of the task tree's live grant (host and
 * pathname+search length checked against the caps, atomically); it never throws, and anything but ok means the call gets its approval card.
 * The registry strips this port on the approved/runApproved path (W-C2): an approved replay never consumes.
 */
export interface WebGrantPort { consume(r: { rootId: string; host: string; chars: number }): Promise<ConsumeResult> }

/**
 * TREEGRANT-1: what the registry may do with a task-tree grant. `consume` spends one call of the task tree's live grant for a registered tool name
 * (code-sourced, never model text). `tainted` is the run's taint, so the gate can refuse a tainted run before any slot is spent. It never throws; anything
 * but ok means the call gets its approval card. Only the registry on the RUN path (never runApproved, never the admin registry) holds this port.
 */
export interface TaskGrantPort { consume(r: { rootId: string; tool: string; tainted: boolean }): Promise<TaskConsumeResult> }

/**
 * AUTO-1 (SA-1 5.4): what the registry and the tools may ask the project autopilot. `projectOf` is a database join (never tool input); `decide` never throws and answers
 * `card` (today's approval card) on any doubt. Only a non-admin run of the main registry holds it; the registry strips it on the approved path.
 */
export type AutopilotDecision = { kind: 'run' } | { kind: 'card' } | { kind: 'refuse'; code: 'url_heuristic' | 'query_heuristic' | 'masked_input' | 'input_cut'; company?: true };
export interface AutopilotPort {
  projectOf(taskId: string): Promise<{ id: number; rootTaskId: string; deadline: string } | null>;
  decide(r: { taskId: string; tool: string; input: unknown }): Promise<AutopilotDecision>;
  /** AUTO-2: company scope is on (enabled, scope 'company', not halted). Synchronous, never throws; any doubt is false. */
  companyOn?(): boolean;
  /** AUTO-2: the task's tree is a company tree (open root, no projects row, not an outside origin). Never throws; false on any doubt. */
  inCompany?(taskId: string): Promise<boolean>;
}

/**
 * ASKBACK-1: what `ask_requester` and `answer_subtask` may do. The scheduler implements it. Everything that decides WHO may ask, WHO may answer, WHICH
 * question and the caps is read from database rows inside the port; the tools pass text only (already redacted, defanged and length-checked).
 * `reason` is a key of the tool's own fixed-refusal table, never model text.
 */
export type AskRefusal = 'unavailable' | 'noTask' | 'noRequester' | 'open' | 'cap' | 'limit' | 'post';
export type AnswerRefusal = 'notWake' | 'closed' | 'post';
export interface AskPort {
  ask(req: { actor: ActorRef; taskId: string; question: string; tainted: boolean }): Promise<{ ok: true; seq: number; hours: number } | { ok: false; reason: AskRefusal }>;
  answer(req: { actor: ActorRef; questionId: number; answer: string; tainted: boolean }): Promise<{ ok: true } | { ok: false; reason: AnswerRefusal }>;
}

/**
 * HEAL-1 (HL-C9): what `resolve_blocked` may do. Implemented in agents/tasks/heal-actions.ts. Everything that decides WHO may resolve WHICH task is read from rows inside
 * the port; the tool passes the validated input only. `code` is a key of the tool's own fixed-refusal table, never model text.
 */
export type HealCode =
  | 'R_DISABLED' | 'R_HALTED' | 'R_NOT_HEAD' | 'R_NOT_FOUND' | 'R_NOT_BLOCKED' | 'R_NOT_HEALABLE' | 'R_NOT_DECIDER' | 'R_NOT_HERE' | 'R_PENDING'
  | 'R_RETRY_CAP' | 'R_TAINTED' | 'R_TREE_ENDED' | 'R_TURNS' | 'R_OPEN_CHILDREN' | 'R_STALE' | 'R_ERROR';
export interface HealPort {
  resolve(req: { actor: ActorRef; callerTaskId: string | null; tainted: boolean; taskId: string; action: 'retry' | 'cancel'; instruction?: string; reason?: string }): Promise<{ ok: true; action: 'retry' | 'cancel' } | { ok: false; code: HealCode }>;
}

/** Per-run state owned by the loop, created once per agent run and shared by every round's ToolContext. */
export type RunState = {
  tainted(): boolean; markTainted(): void; knownUrls: Set<string>;
  /** F1: every call of this run that ended as `awaiting_approval`: the tool name (the registry's own, never model text) and the card number (null when unknown). The loop adds the footer from it. */
  pending: { tool: string; card: number | null }[];
  /** F2: warroom_say calls made by this run (the per-run cap is checked in code). */
  sayCalls: number;
  /** RF10: forward_to calls this run has made (the run cap is counted in code). */
  forwards: number;
  /** RF13: images read by read_image in this run (the per-run cap is counted in code). */
  images: number;
  /** WEBGRANT-1 (D8): url key -> why the grant was not applied to it (a url rule `url:E7` or a consume miss); read by fetch_page's approval reason. */
  webGrantMiss?: Map<string, string>;
  /** ASKBACK-1: ask_requester / answer_subtask calls made by this run (the per-run cap is counted in code). */
  askCalls: number;
  answerCalls: number;
  /** ASKBACK-1 (AB4): a question was sent by this run: the loop ends it after the current batch and nothing it said is posted. */
  asked: boolean;
};

export function newRunState(): RunState {
  let tainted = false;
  return { tainted: () => tainted, markTainted: () => void (tainted = true), knownUrls: new Set(), pending: [], sayCalls: 0, forwards: 0, images: 0, webGrantMiss: new Map(), askCalls: 0, answerCalls: 0, asked: false };
}

/**
 * Everything a tool may touch. Deliberately no env, config store, secrets, provider keys or approval
 * decisions (Gate 1 D16). Owner and requester always come from `actor` / `task`, never from tool input (D14).
 * `notes` and `audit` extend the plan's list: update_task writes dept notes, the registry audits every call.
 */
export type ToolContext = {
  actor: ActorRef;
  task: Task | null;
  /** From the task row, else the trigger (P1). Tool input can never set it. */
  origin: ToolOrigin;
  source: ToolSource;
  /** True only for a human talking straight to praw (R3, see direct.ts); computed by the loop each round. */
  direct: boolean;
  /**
   * HEAL-1 (HL-C5): a person's own message started this run (chat or slash, not voice), and it is not an admin-console, post-only, ask-wake, meeting or
   * warroom-pool run. Computed only in runAgent from the trigger; never read from tool input (no input schema carries it).
   */
  personStarted?: boolean;
  /** HEAL-1 (HL-C2): the person behind a `personStarted` run is a Bot Admin (`msg.isAdmin`, the live role read by the inbound pass). Same code-derived rule as personStarted; false otherwise. */
  personAdmin?: boolean;
  /** Whether an untrustedOutput tool has returned in this run. */
  tainted(): boolean;
  run: RunState;
  /** Gets or creates the task of the current conversation (set by the loop when available). */
  ensureConversationTask?: () => Promise<Task>;
  /** P16d: whether a guild member can view a channel (the DiscordPort check). Absent in tests that do not need it. */
  canMemberView?: (userId: string, channelId: string) => Promise<boolean>;
  org: Pick<Org, 'canDelegate' | 'toolsFor' | 'dept' | 'persona'>;
  tasks: Pick<TaskRepo, 'create' | 'get' | 'update'> & Partial<Pick<TaskRepo, 'takeForward' | 'ownByPrefix' | 'openOf'>>;
  approvals: Pick<Approvals, 'needsApproval' | 'request'>;
  /** F1: the channel the approval card is posted in (chosen by code), for the text the model reads. Absent: a generic wording. */
  approvalChannel?: (a: Approval) => Promise<string | null>;
  limits: Pick<Limits, 'checkDepth' | 'checkChildren' | 'checkOpenTasks'>;
  bus: EventBus<AppEvents>;
  notes: Pick<DeptNoteRepo, 'add'>;
  audit: AuditFn;
  /** Whether a department's Discord client is connected (default: online); work for an offline one could not be posted. */
  deptOnline?: (dept: string) => boolean;
  /** TW6: set for runs that may create root tasks (no parent task); create_task takes a slot here first. */
  rootTaskGate?: RootTaskGate;
  /** TW13: present when meetings are wired. */
  meetings?: MeetingPort;
  /** TW13: this run is itself a turn of a meeting. */
  inMeeting?: true;
  /** F2: present when the warroom port is wired. */
  warroom?: WarroomSayPort;
  /** F2 / LF3: the roll-up of warroom replies (and a post-only run) cannot call `warroom_say`. Set by the loop from the trigger. */
  noWarroomSay?: true;
  /** WS1: this run's resolved provider is the local one and `limits.localUnlimited` is on (decided by the loop per run, never by a tool). */
  localLifted?: true;
  /** WS12: the live `duties.byDept` table (closed enum values). Absent: the code defaults. */
  duties?: () => Readonly<Record<string, readonly string[]>>;
  /** RF11: the guild id, for message links built from ids only. Absent: a forward card has no link. */
  guildId?: string;
  /** RF11: whether @everyone can view a channel, read live (false on any doubt). Absent: every forward card withholds the summary. */
  channelIsPublic?: (channelId: string) => Promise<boolean>;
  /** WEBGRANT-1: the task web grant (fetch_page only). Absent: no grant is ever applied. */
  webGrants?: WebGrantPort;
  /** TREEGRANT-1: the task-tree grant (TG-C6): set only on a non-admin run; the registry strips it on the approved path and unless it was built with `treeGrants: true`. */
  treeGrants?: TaskGrantPort;
  /** AUTO-1: the project autopilot port (non-admin runs of the main registry only). */
  autopilot?: AutopilotPort;
  /** ASKBACK-1: the ask/answer port (present when wired). */
  ask?: AskPort;
  /** HEAL-1: the resolve_blocked port (present when wired). */
  heal?: HealPort;
  /** ASKBACK-1: this run answers an open question (the scheduler's wake run; set by code only). `noAsk`: this run may not ask one (a wake run, or a resume that already asked). */
  askWake?: { questionId: number };
  noAsk?: true;
  /** Whether today is an off day (company/calendar.ts): create_task then tells the model the new task waits for the next workday. */
  offDay?: () => OffDay;
  /** OT-1: the end (`HH:MM`, schedule timezone) of the current task tree's approved overtime today, or null. Bound by the loop to the task's own root, never to tool input. */
  otUntil?: () => Promise<string | null>;
  /** TEAMTALK-1: today's date (`YYYY-MM-DD`) in `schedule.timezone`, for the range of create_task's `due`. Absent: the UTC date. */
  today?: () => string;
};

export type ToolResult = {
  content: string;
  isError?: boolean;
  terminal?: OutboundPayload;
  /** Set only when runApproved refused before anything ran (halted): the caller may un-claim the approval (R4 contract a). */
  notRun?: 'halted';
};

/** Spec §8. `input` passed to requiresApproval/run has already been validated by `inputSchema`. */
export interface ToolPlugin<I = unknown> {
  name: string;
  description: string;
  inputSchema: ZodType<I>;
  /** The result carries text from outside the company (web, files, third parties): the run is tainted after it returns. */
  untrustedOutput?: boolean;
  /** The `source` the registry writes on the untrusted wrapper (default `tool_output`), e.g. `web`. */
  untrustedSource?: string;
  /** How much the tool changes the world. Required for plugin tools (registerGroups); the registry then applies approvalFor on top of requiresApproval. */
  kind?: ToolKind;
  /**
   * What the approval card shows for a call of this tool: the object it acts on (an id, never model prose) and a short
   * human-readable change. Built from the validated input only. The registry puts it into the central approvalFor
   * reason (default: target `call` and the JSON input); it never decides WHETHER approval is needed.
   */
  summary?(input: I): { target: string; change: string };
  /** Called once after this run filed an approval card for the call, with the task the card waits in (a conversation task may have been opened just now). A throw is ignored. */
  onApprovalTask?(input: I, ctx: ToolContext, task: { id: string; rootId: string }): void;
  /**
   * Async refusals and a card built from fresh vendor data, checked after zod and BEFORE the approval decision, on both `run` and
   * `runApproved` (so an approved call re-checks against current state, P3). `refuse` ends the call with that fixed text and no
   * approval row; `summary` replaces `summary(input)` on the card. Throwing counts as a refusal (fail closed).
   * `pin` (P3) holds fields read from the vendor now (e.g. the blob sha being replaced): the registry merges them into the validated
   * input before the approval is stored (so they are part of the approved digest) or before a direct run; the merged input must pass zod.
   */
  precheck?(input: I, ctx: ToolContext): Promise<{ refuse: string } | { summary: { target: string; change: string }; pin?: Partial<I> } | null>;
  requiresApproval(input: I, ctx: ToolContext): boolean | { reason: string; estCostUsd?: number };
  run(input: I, ctx: ToolContext): Promise<ToolResult>;
}

export const sameActor = (a: ActorRef, b: ActorRef): boolean =>
  a.kind === 'head' ? b.kind === 'head' && a.dept === b.dept : b.kind === 'persona' && a.personaId === b.personaId;

export const toolError = (content: string): ToolResult => ({ content, isError: true });

/** LEARN-1 (LL-C1, LL-C2): the run read outside content, or it works on a task that did. One predicate for every taint-copy and taint-refuse site added by LEARN-1. */
export const runOrTaskTainted = (ctx: Pick<ToolContext, 'tainted' | 'task'>): boolean => ctx.tainted() || ctx.task?.tainted === true;
/** LL-C2: fixed refusal for jobs and reminders; a tainted run never files a card for a prompt or text it may have been steered to write. */
export const TAINTED_SETUP_REFUSAL = 'This cannot be set up after reading outside content; ask in a new message.';
