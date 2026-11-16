import { localDay, type OffDay } from '../../company/calendar.js';
import type { RoomEntryStore } from '../../db/repos/room-entries.js';
import type { Org } from '../../company/org.js';
import type { Route } from '../../company/router.js';
import type { ActorRef, IncomingMessage } from '../../company/types.js';
import type { ConfigStore } from '../../config/store.js';
import { forgeNoteHq, forgeNoteSoftware } from '../../forge/notes.js';
import type { AppEvents, EventBus } from '../../core/events.js';
import type { Approval, DeptNoteRepo, PromptOverrideRepo } from '../../db/repos/ledger.js';
import type { BlockReason, Task, TaskRepo, TaskStatus } from '../../db/repos/tasks.js';
import type { Approvals } from '../../governance/approval/approvals.js';
import type { AuditFn } from '../../governance/audit.js';
import { actorKey, liftsCap, localLiftOn, type Budget } from '../../governance/budget.js';

import type { Halt } from '../../governance/halt.js';
import type { TaskRuns } from '../tasks/task-runs.js';
import type { Limits } from '../../governance/limits.js';
import type { AskPort, AutopilotPort, HealPort, RootTaskGate, MeetingPort, WarroomSayPort } from '../../tools/types.js';
import { ASK_REFUSALS } from '../../tools/builtin/askRequester.js';
import { assembleContext, KNOWLEDGE_BUDGET_BYTES, type PromptDoc } from '../../prompts/index.js';
import type { ProviderRegistry } from '../../providers/registry.js';
import { reportFallback } from '../../providers/fallback-gate.js';
import { SEND_AGAIN_TEXT, WAITS_TEXT } from '../../providers/fallback-text.js';
import { fallbackEnabled, fallbackRequest, resolveEffective, type Effective, type FallbackState } from '../../providers/route.js';
import { isQuotaRejection, type ChatMessage, type ChatRequest, type ContentBlock, type LLMProvider, type StopReason } from '../../providers/types.js';
import { awaitingFooter, type ToolRegistry } from '../../tools/registry.js';
import { isDirectHumanRun, type DirectTrigger } from '../../tools/direct.js';
import { extractUrls } from '../../tools/urls.js';
import { newRunState, sameActor, type RunState, type ToolContext, type ToolOrigin, type ToolSource } from '../../tools/types.js';
import { conversationHook, isTopLevelConversation, type Conversation } from '../conversation.js';
import { IncidentError } from '../../core/incidents.js';
import { fitSkills } from '../../skills/render.js';
import { budgetText, callProvider as callCore, type CallDeps, type StreamDelta } from '../call/call.js';
import type { ReplyStreamSink } from '../stream/stream.js';
import { autopilotNote, buildSystem, COMPANY_AUTOPILOT_NOTE, firstTurn, inWarroom, MCP_NOTE, ownUserOf, RELEASE_NOTE, forgeOn, releaseOn, resolveActor, runStartsTainted, WARROOM_NOTE, type Provenance } from '../context.js';
import { escapeCardText } from '../../discord/embeds/approval.js';
import { dutyNote } from '../../company/duties.js';
import { handleOf, handlesIn } from '../../company/handles.js';
import { AI_WARROOM_CHANNEL_ID } from '../../company/channels.js';
import type { DeptId } from '../../core/index.js';
import { deptNotesFor, roomEntriesFor } from '../review/notes.js';
import { incidentBlock } from '../../grow/incidents.js';
import type { IncidentRow } from '../../db/repos/dept-incidents.js';
import type { Reflector } from '../review/reflect.js';
import { alertPayload, isNoReply, textToPayload, toPayload, type OutboundPayload } from './payload.js';
import { respondInput } from '../../tools/builtin/respond.js';
import { ADMIN_CONSOLE_NOTE, ADMIN_TOOL_NAMES, MOD_TOOL_NAMES, modRoomNote } from '../../admin/names.js';

/** SK11: actors whose skill overflow was already reported in this process (one incident per actor). */
const skillOverflowReported = new Set<string>();

/**
 * SK1: the skill set is decided HERE, from the trigger, before the system text is built. Admin-console, mod-room and post-only runs never get
 * skills (a Praw-dept skill would otherwise reach the admin tool set); a normal run gets the actor's skills, whole or not at all within the byte budget.
 */
function skillsForRun(trigger: Pick<AgentTrigger, 'admin' | 'modTier' | 'postOnly'>, actor: ActorRef, deps: Pick<AgentDeps, 'org' | 'incidents'>) {
  if (trigger.admin || trigger.modTier || trigger.postOnly) return [];
  const { kept, dropped } = fitSkills(deps.org.skillsFor(actor));
  const key = actor.kind === 'head' ? `head:${actor.dept}` : `persona:${actor.personaId}`;
  if (dropped.length && !skillOverflowReported.has(key)) {
    skillOverflowReported.add(key);
    deps.incidents?.report({ source: 'skills', stage: 'budget', err: new IncidentError('skills_over_budget', `team skills were dropped for ${key} (over the byte budget): ${dropped.join(', ')}`, 'Detach or shorten a skill with /skill detach or /skill edit.'), actor });
  }
  return kept;
}

export type AgentTrigger = {
  route: Route; msg?: IncomingMessage; task: Task | null; history: IncomingMessage[];
  /** R4: results of approved tool calls the scheduler ran before this owner run (shown as untrusted context). */
  approvedResults?: string[];
  /** R4: code-written lines about approvals that did not run (rejected, expired, integrity check failed). */
  approvalNotices?: string[];
  /** R4: called once, when this run's first provider call is actually made (the outcomes above count as delivered then). */
  onModelStart?: () => Promise<void>;
  /** Gate 1 C3: the `admin_console` run kind (a Bot Admin's message in #setting). Set by the scheduler only; it swaps the whole tool set. */
  admin?: true;
  /** Delegated tiers: with `admin`, makes it a mod-room run for a Moderator or Manager (a reduced tool set and note). Set by the scheduler only, from the author's live roles. */
  modTier?: 'manager' | 'moderator';
  /** TW4: a bot-origin warroom run (routed bot talk, a stall turn, a meeting turn): it also draws from the warroom pool. Set by the scheduler only. */
  pool?: 'warroom';
  /** Code-written instruction for this run (a meeting turn, a stalled conversation), shown outside the untrusted wrapper. Set by the scheduler only. */
  instruction?: string;
  /** TW6: replaces the default gate on root tasks created by this run (a meeting close counts its own tasks). Set by the meeting code only. */
  taskGate?: RootTaskGate;
  /** TW13: this run is a turn of a meeting (it can neither start nor nest another). Set by the meeting code only. */
  inMeeting?: true;
  /** TW3: called when a tool of this run created or changed a task row (code-observed; the warroom guard resets on it). */
  onTaskWrite?: () => void;
  /** WS11: a daily-rhythm run (09:00 goal, 20:00 report): no tools at all (the registry refuses any call), always tainted; the scheduler posts its text through the code path. Set by the scheduler only. */
  postOnly?: true;
  /** F2 / LF3: the run that summarises replies from #ai-warroom: `warroom_say` is neither offered nor allowed in it. Set by the scheduler only. */
  noWarroomSay?: true;
  /** STREAM-1: a live reply preview for this run (human messages only). Set by the scheduler only; the loop opens a segment per provider call and forwards the provider's tool-input fragments. */
  stream?: ReplyStreamSink;
  /** ASKBACK-1: the run of a requester woken with a question (AB5): only `answer_subtask` and read tools, neither offered nor allowed otherwise. Constructed only by the scheduler's askUp. */
  askWake?: { questionId: number };
  /** ASKBACK-1: this run may not ask a question (a wake run). Set by the scheduler only. */
  noAsk?: true;
  /** GROW-1 (GW-C2): the weekly retro run. Set by Scheduler.retroRun only. Drops UNVERIFIED lessons from the prompt (tainted notes and room entries are dropped for every non-admin run, LEARN-1 D1), and restricts the tool list (RETRO_TOOLS) at offer and dispatch. */
  retro?: true;
};
/** GROW-1 (GW-C1): the only tools a retro run may use (kindless grow tools join in GW-BE2/BE3 and are listed here already; absent tools simply are not offered). */
export const RETRO_TOOLS: readonly string[] = ['skill_propose', 'tool_request', 'tool_idea', 'kb_search', 'respond'];
export type AgentOutcome = {
  payload: OutboundPayload; costUsd: number; turns: number; stopped?: 'halted' | 'budget' | 'turns' | 'cancelled';
  /** G2-04: whether the run had read outside text when it ended; the scheduler records it with the post. */
  tainted?: boolean;
  /** G2-04: whose words the run answered (see ownUserOf); recorded with the post so only that person treats a clean reply as clean. */
  triggerUserId?: string | null;
  /** ASKBACK-1 (AB4): the run ended by sending a question; nothing it produced is posted by any delivery path. */
  asked?: true;
  /**
   * R8 PROV-FALLBACK: the run put its own task back to `todo` because of the quota hold (a quota rejection, a held route, or a refused/failed backup call).
   * The scheduler re-offers the task once, and only when its owner now resolves to the fallback route (PV-C03).
   */
  requeued?: 'quota';
};

export type AgentDeps = {
  org: Org;
  /** TEAMTALK-1: the persona rooms' memory (read only here; written by the scheduler's TeamTalk). Absent = no room memory. */
  rooms?: Pick<RoomEntryStore, 'recent'>;
  prompts: Map<string, PromptDoc>;
  overrides: Pick<PromptOverrideRepo, 'getActive'>;
  providers: Pick<ProviderRegistry, 'resolve'> & Partial<Pick<ProviderRegistry, 'has' | 'get'>>;
  cfg: Pick<ConfigStore, 'get'> & Partial<Pick<ConfigStore, 'listenerHealthy'>>;
  /** R8 PROV-FALLBACK: the Claude API backup gate (the quota hold plus the block list). Absent: no fallback, a quota-held run behaves as before. */
  fallback?: FallbackState;
  budget: Pick<Budget, 'reserve' | 'settle' | 'release' | 'costOf'>;
  limits: Pick<Limits, 'checkTurn' | 'checkDepth' | 'checkChildren' | 'checkOpenTasks'>;
  halt: Pick<Halt, 'isHalted' | 'track'>;
  /** TASKADMIN-1 (TA-C10): REQUIRED. The admin-cancel stop signal; the main app passes the one TaskRuns the commands abort through (a wiring test proves it). */
  taskRuns: Pick<TaskRuns, 'track' | 'cancelled'>;
  approvals: Pick<Approvals, 'needsApproval' | 'request' | 'onTreeCapHit' | 'onLocalCapHit'>;
  tasks: Pick<TaskRepo, 'create' | 'get' | 'update'> & Partial<Pick<TaskRepo, 'takeForward'>>;
  notes: Pick<DeptNoteRepo, 'add' | 'forContext'>;
  tools: ToolRegistry;
  /** Gate 1 C3: a separate registry holding only the admin console tools; admin runs use it and nothing else. Absent = no admin runs. */
  adminTools?: ToolRegistry;
  bus: EventBus<AppEvents>;
  audit: AuditFn;
  /** Warn sink for provider failures (see CallDeps.log). */
  log?: CallDeps['log'];
  /** HEAL-1 (HL-C15): the literal secrets masked in the failed-tool footer (the app's shared list, so a stored key joins after decryption). Absent: no literal masking beyond the pattern redactor. */
  secrets?: readonly string[];
  /** BOTLOG-1: incident reporter (see CallDeps.incidents); also used for a provider that is not registered here. */
  incidents?: CallDeps['incidents'];
  /** LEARN-1 (D2): the department's incident counts of the last 7 days (code-built rows). Heads only; a throw means no block. NOT `incidents` (that is the BOTLOG-1 reporter). */
  deptIncidents?: (dept: string) => Promise<IncidentRow[]>;
  /** Whether a department's Discord client is connected (create_task refuses offline assignees). Default: online. */
  online?: (dept: string) => boolean;
  /** Today's off-day state (company/calendar.ts), handed to tools as a closure; absent = always a workday. */
  offDay?: () => OffDay;
  /** R2: opens the conversation task when a human's message to praw delegates. Provided by the scheduler for those runs only. */
  conversation?: Conversation;
  /** RF11: the guild id and the live @everyone-can-view check handed to forward_to (message links; the audience rule). */
  guildId?: string;
  channelIsPublic?: (channelId: string) => Promise<boolean>;
  /** P16d: the DiscordPort check handed to tools (create_task via praw). */
  canMemberView?: (userId: string, channelId: string) => Promise<boolean>;
  /** P13: the active lesson texts for this actor, newest first. Asked for every non-admin run; a failure means no lessons. */
  lessons?: (actor: ActorRef) => Promise<string[]>;
  /** TW7: the actor's open tasks as ids, status and department only (never titles); absent = no header. */
  openTasks?: (actor: ActorRef) => Promise<{ id: string; status: string; deptId: string }[]>;
  /** TW6: the daily cap on root tasks created by bots (a run with no task). Absent = no cap (tests). */
  botRoots?: RootTaskGate;
  /** TW13: starts meetings (CEO `meeting_start`). Absent = the tool refuses. */
  meetings?: MeetingPort;
  /** F2: the `warroom_say` port (the scheduler installs it). Absent = the tool refuses. */
  warroomSay?: WarroomSayPort;
  /** ASKBACK-1: the ask/answer port (the scheduler installs it). Absent = the tools refuse and are not offered. */
  ask?: AskPort;
  /** HEAL-1: the resolve_blocked port (agents/tasks/heal-actions.ts). Absent = the tool refuses. */
  heal?: HealPort;
  /** F3: whether a department's bot can View a channel (read live, false on any doubt). Absent: no hint. */
  canBotView?: (dept: DeptId, channelId: string) => Promise<boolean>;
  /** F1: the channel an approval card is posted in (the scheduler's own resolver), so the tool result can name it. Absent: a generic wording. */
  approvalChannel?: (a: Approval) => Promise<string | null>;
  /** WEBGRANT-1: the task web grant port handed to tools (fetch_page.precheck). The registry strips it on the approved path (W-C2). Absent: no grant. */
  webGrants?: ToolContext['webGrants'];
  /** TREEGRANT-1: the task-tree grant port handed to the main registry's tools (TG-C6). Never put on an admin run; the registry also strips it on the approved path. Absent: no grant. */
  treeGrants?: ToolContext['treeGrants'];
  /** OT-1: the end of a task tree's approved overtime today (null = none), for create_task's reply only. Absent: no overtime text. */
  ot?: { until(rootId: string): Promise<Date | null> };
  /**
   * AUTO-1 (SA-1 3.4, 5.4): the project port. `budgetHit` blocks the task, calls `exhaust` and posts the one budget notice; it is wired in app.ts with the
   * project service. `projectOf` and `toolsFor` (project tool grants for an actor) are read where the offer and the dispatch list are built; `projectOf` and `decide` are the
   * port a non-admin run hands its tools (ToolContext.autopilot, SA-1 5.4). Absent = no autopilot.
   */
  /**
   * R7 PLUGIN-FORGE (spec 5.5): the two note inputs, as narrow reads (app.ts builds them over ForgeRepo; no build, stage or install is reachable). Asked only while `forge.enabled` reads true, only for the
   * CEO (`hqIdeas`) or the software head (`softwareIdea`, by the task root), never for an admin or post-only run. A fault reads as "no note".
   */
  forge?: {
    hqIdeas(): Promise<import('../../forge/notes.js').IdeaForNote[]>;
    softwareIdea(rootId: string): Promise<{ projectId: number; idea: import('../../forge/notes.js').IdeaForNote & { example: string } } | null>;
  };
  autopilot?: {
    budgetHit(task: Task): Promise<void>;
    toolsFor?(projectId: number, actor: ActorRef): Promise<string[]>;
    projectOf?: AutopilotPort['projectOf'];
    decide?: AutopilotPort['decide'];
    /** AUTO-2: company scope is on (sync, never throws), the task's tree is a company tree, and the task-tree tool grants of an actor. Absent = project scope only. */
    companyOn?: AutopilotPort['companyOn'];
    inCompany?: AutopilotPort['inCompany'];
    treeToolsFor?(taskId: string, actor: ActorRef): Promise<string[]>;
  };
  /** Flow A: after a task the actor owns reaches `done`, writes up to 3 department notes (agents/review/reflect.ts). Absent = off. */
  reflect?: Reflector;
  /** Output cap per provider call (also the output part of each reservation). */
  maxTokens?: number;
  now?: () => number;
  /** G2-04: taint of our earlier bot messages in the history (message id -> tainted). Absent: every one of them counts as tainted. */
  provenance?: { lookup: Provenance };
};

/** The title of the fixed alert for work that waits for the quota hold (unchanged since OPS-HOLD). */
const QUOTA_TITLE = 'Claude quota used up';

/** Provider calls per runAgent: the first answer plus up to 7 rounds of tool results. */
export const MAX_TOOL_ITERATIONS = 8;
export const DEFAULT_MAX_TOKENS = 4096;
/** A task in these states is left alone when the loop would block it. */
const SETTLED: readonly TaskStatus[] = ['done', 'cancelled', 'awaiting_approval', 'blocked'];
/** A tool round that moves the current task into one of these ends the turn: no further provider call (final #7). */
const ENDS_TURN: readonly TaskStatus[] = ['done', 'cancelled', 'awaiting_approval'];

type Stop = { payload: OutboundPayload; stopped?: AgentOutcome['stopped']; asked?: true; requeued?: 'quota' };
type Call =
  | { kind: 'stop'; stop: Stop }
  | { kind: 'done'; blocks: ContentBlock[]; text: string; reason: StopReason; costUsd: number; failed?: unknown; aborted: boolean };

/**
 * One agent turn: governance gates (halt, turn limit, budget) before every provider call, then the tool loop.
 * Ends on a `respond` payload, a plain text answer (chat fallback) or a stop reason. Never throws for
 * provider or budget failures; those become alert payloads.
 */
export async function runAgent(trigger: AgentTrigger, deps: AgentDeps): Promise<AgentOutcome> {
  const now = deps.now ?? Date.now;
  const started = now();
  const actor = trigger.route.actor;
  let costUsd = 0;
  let turns = 0;
  let model = '';
  let runState: RunState | null = null; // a stop before the run starts carries code-written text only
  // HEAL-1 (H4, HL-C15): non-read tool calls of this run that ended in an error and were not followed by a success of the same tool. `footerOn` is set once the run is known to answer a person.
  let footerOn = false;
  const failed = new Map<string, string>();
  const finish = (s: Stop): AgentOutcome => {
    // F1: a run that got an awaiting_approval result posts a code-written line per pending call after its answer, whatever the model said.
    const pending = runState?.pending ?? [];
    const awaited = pending.length && s.stopped !== 'halted' && s.stopped !== 'cancelled' && !isNoReply(s.payload) ? { ...s.payload, body: `${s.payload.body}\n\n${pending.slice(0, 3).map(awaitingFooter).join('\n')}`.trim() } : s.payload;
    // H4: built here, after the last provider call, so the model never sees or edits it; any error posts the answer without it.
    let noted = awaited;
    if (footerOn && failed.size && s.stopped !== 'halted' && s.stopped !== 'cancelled' && !s.asked && !isNoReply(s.payload)) {
      try {
        noted = { ...awaited, body: `${awaited.body}\n\n${notDoneFooter(failed, deps.secrets ?? [])}`.trim() };
      } catch (err) {
        deps.log?.warn({ errName: err instanceof Error ? err.name : 'Error' }, 'failed-tool footer could not be built; answer posted without it');
      }
    }
    const payload = turns > 0 ? { ...noted, footer: { model, costUsd, ms: now() - started } } : noted;
    return { payload, costUsd, turns, tainted: runState?.tainted() ?? false, triggerUserId: ownUserOf(trigger), ...(s.stopped ? { stopped: s.stopped } : {}), ...(s.asked ? { asked: true as const } : {}), ...(s.requeued ? { requeued: s.requeued } : {}) };
  };
  const halted = (): Stop => ({ payload: alertPayload('Halted', 'The company is halted. Nothing was run.'), stopped: 'halted' });
  // TASKADMIN-1 (TA-C10/C11): fixed text only. Checked against the in-memory mark AND the fresh row (the row comes back from the turnsUsed write after every model call).
  const cancelled = (): Stop => ({ payload: alertPayload('Task cancelled', 'This task was cancelled. Nothing more will run.'), stopped: 'cancelled' });
  // G2-03: the task of the run is the one it started with, else the conversation task it opened part-way through (tracked and checked the same way)
  const current = (): Task | null => task ?? openedTask;
  const cancelledNow = (): boolean => { const t = current(); return !!t && (deps.taskRuns.cancelled(t.id) || t.status === 'cancelled'); };

  if (deps.halt.isHalted()) return finish(halted());
  let task = trigger.task;
  let openedTask: Task | null = null; // R-02 / G2-03: a conversation task opened mid-run

  const profile = await resolveActor(actor, deps.org, deps.prompts, deps.overrides);
  if (typeof profile === 'string') return finish({ payload: alertPayload('Unavailable', profile) });
  let built: string;
  try {
    built = await buildSystem(profile.doc, deps.prompts, deps.overrides, skillsForRun(trigger, actor, deps));
  } catch (err) {
    // K6: a protected prompt that does not match its pinned hash fails closed: nothing runs. Logged by ref only, never text.
    deps.log?.warn({ ref: err instanceof Error && 'ref' in err ? (err as { ref: unknown }).ref : undefined }, 'protected prompt check failed; run refused');
    return finish({ payload: alertPayload('Unavailable', 'The safety prompt check failed, so nothing was run. An admin must look at the prompt files.') });
  }
  let resolved: Effective;
  try {
    // R8: the ONE route function (G4). `held` carries the subscription provider and makes no call; `fallback` carries the Claude API with the API model id.
    resolved = resolveEffective(deps.providers, profile, actor, deps.cfg, deps.fallback, task ? { taskId: task.id } : {});
  } catch {
    deps.incidents?.report({ source: 'provider', stage: 'resolve', err: new IncidentError('provider_unregistered', 'the provider selected for this bot is not registered in this process', 'Provider is not registered here: run scripts/probe-local-cli.sh (npm run probe:local), or pick another with /provider default.'), actor, ...(task ? { taskId: task.id, taskTitle: task.title } : {}) });
    // Gate 1 L9: a provider id that is not registered here (e.g. claude-code-local off the owner's Mac) runs nothing
    // (checked before the task moves to doing, so it is left as it was).
    return finish({ payload: alertPayload('Unavailable', 'The model provider selected for this bot is not available here. Nothing was run.') });
  }
  // R8 (PV-C02): a held route makes no call. The task is left as it was (todo; it has not moved to doing yet) and the text is today's "waits" text.
  if (resolved.route === 'held') return finish({ payload: alertPayload(QUOTA_TITLE, WAITS_TEXT) });
  const onApi = resolved.route === 'fallback';
  // WS1: decided per call from the resolved provider. `limits.turnsPerTask` is one of the caps `limits.localUnlimited` lifts for a local call (the turn counter still counts).
  const turnsLifted = liftsCap('limits.turnsPerTask', deps.cfg, resolved.provider.id);
  // Thread context is not ownership: only the owner's run changes the task's status.
  const owns = !!task && sameActor(task.owner, actor);
  // R8: the work waits for the hold: the task goes back to `todo` (the scheduler offers it again) and the person gets today's fixed "waits" text.
  const waitsStop = async (): Promise<Stop> => {
    const requeued = !!task && owns;
    if (task && owns) await requeue(deps, task);
    return { payload: alertPayload(QUOTA_TITLE, WAITS_TEXT), ...(requeued ? { requeued: 'quota' as const } : {}) };
  };
  // R8 (PV-C02): before EVERY call on the fallback route, wrap-up included: the switch (read live, fail closed), the gate marks and the actor's budget marks. A halt is the loop's own check.
  const backupNow = (): boolean => {
    try {
      return resolveEffective(deps.providers, profile, actor, deps.cfg, deps.fallback, task ? { taskId: task.id } : {}).route === 'fallback';
    } catch {
      return false;
    }
  };
  const apiBlocked = (): boolean => {
    if (!onApi) return false;
    try {
      return !(fallbackEnabled(deps.cfg) && deps.fallback?.usable(actor, profile.deptId, task?.id) === true);
    } catch {
      return true;
    }
  };
  if (task && !turnsLifted && !deps.limits.checkTurn(task)) return finish(await turnLimit(task, deps, owns));
  if (task && owns && task.status === 'todo') task = await setStatus(deps, task, 'doing', 'todo');

  model = resolved.model;
  const fbx = onApi ? { report: (o: Parameters<typeof reportFallback>[2]) => reportFallback(deps.fallback, { actor, deptId: profile.deptId, taskId: task?.id }, o), wait: () => waitsStop() } : undefined;
  const adminRun = trigger.admin === true;
  if (adminRun && !deps.adminTools) return finish({ payload: alertPayload('Unavailable', 'The admin console is not available in this process.') });
  const registry = adminRun ? deps.adminTools! : deps.tools;
  // AUTO-1 (SA-1 3.7): the run's task is in an active project (a database join; any fault reads as "no project"). Never for an admin run or a post-only run.
  const project = !adminRun && !trigger.postOnly && task && deps.autopilot?.projectOf ? await deps.autopilot.projectOf(task.id).catch(() => null) : null;
  // AUTO-2 (SA-1 3.4, 3.7): outside a project, with company scope on, a non-admin run gets the company note and the task-tree grants. A fault reads as "off" (project rules).
  let companyOn = false;
  try { companyOn = !adminRun && !trigger.postOnly && !project && deps.autopilot?.companyOn?.() === true; } catch { companyOn = false; }
  const projTools = project && deps.autopilot?.toolsFor ? await deps.autopilot.toolsFor(project.id, actor).catch(() => [] as string[])
    : companyOn && task && deps.autopilot?.treeToolsFor ? await deps.autopilot.treeToolsFor(task.id, actor).catch(() => [] as string[]) : [];
  const companyNote = companyOn && (!task ? conversationHook(actor, trigger, deps.conversation) !== undefined : (deps.autopilot?.inCompany ? await deps.autopilot.inCompany(task.id).catch(() => false) : false));
  // R6 MC-C1: a project or tree tool row never offers an external (MCP) tool; those come only from the department grant in `policy.effective`.
  const withProject = (n: readonly string[]): string[] => { const p = projTools.filter((t) => !t.startsWith('mcp_')); return p.length ? [...new Set([...n, ...p])] : [...n]; };
  // R7 PLUGIN-FORGE (spec 5.5, PF-C17, PF-C18): each note goes to its own actor only; the text is built by forge/notes.ts from untainted rows (cleaned, capped, delimited). A fault or a switch that is not exactly true: no note.
  let forgeNote = '';
  if (!adminRun && !trigger.postOnly && deps.forge && actor.kind === 'head' && (actor.dept === 'hq' || (actor.dept === 'software' && task)) && forgeOn(deps.cfg)) {
    try {
      forgeNote = actor.dept === 'hq' ? forgeNoteHq(await deps.forge.hqIdeas()) : await deps.forge.softwareIdea(task!.rootId).then((s) => (s ? forgeNoteSoftware(s) : ''));
    } catch { forgeNote = ''; }
  }
  const systemBase = built + (project ? `\n\n${autopilotNote(project)}` : companyNote ? `\n\n${COMPANY_AUTOPILOT_NOTE}` : '')
    + ((project || companyNote) && actor.kind === 'head' && actor.dept === 'software' && releaseOn(deps.cfg) ? `\n\n${RELEASE_NOTE}` : '') // R5 RELEASE-1 (RL-C13): a fixed note; a read error is off
    + (forgeNote ? `\n\n${forgeNote}` : '')
    + (inWarroom({ ...(trigger.msg ? { msg: trigger.msg } : {}), task }) ? `\n\n${WARROOM_NOTE}` : '') + (adminRun ? `\n\n${trigger.modTier ? modRoomNote(trigger.modTier) : ADMIN_CONSOLE_NOTE}` : '')
    // WS12: the duty lines are code text built from the closed table, appended after the (overridable) prompt; never wrapped content.
    + (!adminRun && !trigger.postOnly && actor.kind === 'head' ? `\n\n${dutyNote(deps.cfg.get('duties.byDept'), actor.dept)}` : '');
  const adminNames: readonly string[] = trigger.modTier ? MOD_TOOL_NAMES : ADMIN_TOOL_NAMES;
  // G2LF-02: no warroom_say when the run's own channel is the warroom (the heads already talk there) or on the CEO stall turn (set by the scheduler)
  const noSay = !!trigger.noWarroomSay || (trigger.msg ? (trigger.msg.parentChannelId ?? trigger.msg.channelId) === AI_WARROOM_CHANNEL_ID : false);
  // ASKBACK-1 (AB5, AB10): ONE list feeds both the offer and the registry's dispatch check (toolBase below), so a tool that is not offered cannot be called either.
  // A wake run gets `answer_subtask` plus the tools whose declared kind is `read`; every other run never gets `answer_subtask`, and `ask_requester` only when the
  // switch is on (read live), the run owns a task and is not a wake, a meeting or post-only run.
  let askOn = false;
  try {
    askOn = deps.cfg.get('ask.enabled') === true;
  } catch {
    askOn = false;
  }
  const askOffered = askOn && !!deps.ask && !!task && sameActor(task.owner, actor) && !trigger.noAsk && !trigger.askWake && !trigger.inMeeting && !adminRun && !trigger.postOnly;
  // GW-C1: every restriction lives in this ONE function, which feeds both the offer (`tools`) and the registry's dispatch check (`toolBase`): a tool that is not offered cannot be called by name either.
  const allowedFor = (names: readonly string[]): string[] => {
    const base = trigger.askWake ? (deps.ask ? ['answer_subtask', ...names.filter((n) => n !== 'answer_subtask' && deps.tools.kindOf(n) === 'read')] : []) : names.filter((n) => n !== 'answer_subtask' && !(n === 'ask_requester' && !askOffered));
    return base.filter((n) => !(noSay && n === 'warroom_say') && !(trigger.retro && !RETRO_TOOLS.includes(n)));
  };
  const tools = trigger.postOnly ? [] : adminRun ? registry.specsFor([...adminNames]) : deps.tools.specsFor(allowedFor(withProject(deps.org.toolsFor(actor))));
  // R6 MCP-1 (spec 5.5): the fixed note, only when this run is actually offered an external tool.
  const system = adminRun || !tools.some((t) => t.name.startsWith('mcp_')) ? systemBase : `${systemBase}\n\n${MCP_NOTE}`;
  // An admin run reads no department notes or lessons: nothing it did not receive from the admin or from its own tools.
  // LEARN-1 (D1, LL-C3): a tainted note or room entry never reaches ANY non-admin prompt (it stays stored; before this, only retro runs dropped it and one tainted row tainted every later writer).
  // A filter bug here fails closed: the UNVERIFIED backstop below stays unchanged.
  const deptNotes = adminRun ? [] : (await deptNotesFor(deps.notes, profile.deptId)).filter((n) => typeof n === 'string' || n.tainted !== true);
  // Lessons are company-wide and human-confirmed; every non-admin run reads them (the injected knowledge as a whole stays within 1,500 tokens).
  const lessons = (!adminRun && deps.lessons ? await deps.lessons(actor).catch(() => []) : []).filter((l) => !trigger.retro || !l.startsWith('UNVERIFIED: '));
  // TEAMTALK-1: what the team's rooms recorded (database only, within the same budget; LEARN-1: tainted entries are left out here; one that still reached the renderer would taint this run, structurally).
  const roomEntries = !adminRun && deps.rooms && deps.cfg.get('teamtalk.enabled') !== false ? (await roomEntriesFor(deps.rooms, deps.org, actor)).filter((e) => !e.tainted) : [];
  const roomReport = { roomTainted: false };
  // LEARN-1 (D2, LL-C6): the code-built incident block, heads only, never for admin, post-only or retro runs; any fault means no block.
  let incidentText = '';
  if (actor.kind === 'head' && !adminRun && !trigger.postOnly && !trigger.retro && deps.deptIncidents) {
    try {
      incidentText = incidentBlock(await deps.deptIncidents(profile.deptId), (t) => deps.tools.has(t));
    } catch {
      incidentText = '';
    }
  }
  const context = assembleContext({ ...(incidentText ? { incidents: incidentText } : {}), deptNotes, lessons, lessonChars: deps.cfg.get('lessons.promptChars'), budgetBytes: KNOWLEDGE_BUDGET_BYTES, roomEntries, report: roomReport, ...(task ? { task } : {}) });
  const header = !adminRun && actor.kind === 'head' && deps.openTasks ? await ownTasksHeader(actor, deps.openTasks) : '';
  const messages: ChatMessage[] = [firstTurn({
    context, ...(header ? { header } : {}), ...(trigger.instruction ? { instruction: trigger.instruction } : {}), history: trigger.history, ...(trigger.msg ? { msg: trigger.msg } : {}),
    ...(trigger.approvedResults?.length ? { approvedResults: trigger.approvedResults } : {}),
    ...(trigger.approvalNotices?.length ? { approvalNotices: trigger.approvalNotices } : {}),
  })];
  let lastText = '';
  // Origin, source and run state are fixed for the whole run; `direct` is recomputed each round from the current task row.
  const origin = originOf(trigger);
  const source = sourceOf(trigger, deps);
  const dtrigger = directTriggerOf(trigger);
  // HEAL-1 (HL-C5): a person's own message (chat or slash) started this run. Code-derived from the trigger only; false for schedule, task-owner, roll-up, wake, stall, meeting, voice, pool, post-only, ask-wake and admin-console runs.
  const personStarted = dtrigger.kind === 'human_message' && (dtrigger.origin === 'chat' || dtrigger.origin === 'slash') && !adminRun && !trigger.postOnly && !trigger.askWake && !trigger.inMeeting && !trigger.pool;
  const personAdmin = personStarted && trigger.msg?.isAdmin === true;
  const run = (runState = newRunState());
  footerOn = personStarted;
  // R4: approved tool output (e.g. a fetched page) is untrusted text in this run's context, so the run starts tainted.
  if (trigger.approvedResults?.length) run.markTainted();
  // G2-04: so is a run whose history holds anyone else's words, an attachment or a tainted or unknown bot reply, and a run on an
  // outside-content or tainted task (see runStartsTainted).
  if (await runStartsTainted(trigger, deps.provenance && ((ids) => deps.provenance!.lookup(ids)))) run.markTainted();
  // K1: reading an unverified note (written in a run that read outside content) taints this run too; only notes that made it into the prompt count.
  // Unverified lessons (a tainted note promoted to a lesson, G2K-01) carry the same marker.
  if (context.includes('UNVERIFIED: ') || roomReport.roomTainted) run.markTainted();
  if (trigger.postOnly) run.markTainted(); // WS11: the inputs are forum posts written by people, task titles and the previous bot report
  if (run.tainted() && task && !task.tainted) task = (await deps.tasks.update(task.id, { tainted: true })) ?? task;
  // R17: urls the human typed in this run's message may be fetched without approval, even after taint.
  if (trigger.msg?.author.kind === 'human') for (const u of extractUrls(trigger.msg.content)) run.knownUrls.add(u);
  // R-02: a conversation task opened mid-run keeps the run's later taint too (a resume after a rejected approval starts tainted)
  const open = conversationHook(actor, trigger, deps.conversation, run.tainted);
  const base = toolContextBase(actor, deps, origin, source, run, open && (async () => (openedTask = await open())), { ...trigger, noWarroomSay: noSay || undefined } as AgentTrigger, localLiftOn(deps.cfg, resolved.provider.id));
  // WS5: a call with no person behind it (bot talk, meetings, bot-rooted trees) waits behind people's calls for a local slot.
  const priority: 'human' | 'bot' = (await humanBehind(trigger, task, deps)) ? 'human' : 'bot';
  // C3: the registry's per-actor allowlist check sees exactly the admin set, whatever tools.byDept says.
  const toolBase = trigger.postOnly ? { ...base, org: { ...base.org, toolsFor: () => [] as string[] } } : adminRun ? { ...base, org: { ...base.org, toolsFor: () => [...adminNames] } }
    : { ...base, org: { ...base.org, toolsFor: (a: ActorRef) => (sameActor(a, actor) ? allowedFor(withProject(base.org.toolsFor(a))) : base.org.toolsFor(a)) } };
  let modelStart = trigger.onModelStart;
  // F3 / LF8: a mention of a bot that cannot View this channel is posted as plain text and that bot never sees it. Once per run, before the answer is posted,
  // the model is told so with a fixed text (handles from the closed table) and may use warroom_say. Not for personas, meetings, the warroom itself or runs without the tool.
  let hinted = false;
  const viewHint = async (body: string): Promise<string | null> => {
    if (hinted || !deps.canBotView || adminRun || trigger.postOnly || trigger.inMeeting || actor.kind !== 'head') return null;
    if (!source.channelId || source.channelId === AI_WARROOM_CHANNEL_ID || !deps.org.toolsFor(actor).includes('warroom_say')) return null;
    const blind: string[] = [];
    for (const d of handlesIn(body)) {
      if (d === actor.dept) continue;
      if (!(await deps.canBotView(d, source.channelId).catch(() => false))) blind.push(handleOf(d) ?? d);
    }
    if (!blind.length) return null;
    hinted = true;
    return `${blind.join(', ')} cannot see this channel, so the mention is plain text and it will not answer here; use warroom_say to ask it in #ai-warroom.`;
  };

  let lastReq: ChatRequest | undefined;
  for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
    if (deps.halt.isHalted()) return finish(halted());
    if (cancelledNow()) return finish(cancelled());
    if (task && !turnsLifted && !deps.limits.checkTurn(task)) return finish(await turnLimit(task, deps, owns));
    if (apiBlocked()) return finish(await waitsStop());
    const sink = trigger.stream;
    if (sink) {
      if (i === 0) sink.typing();
      sink.segment(new Set(tools.map((t) => t.name))); // every provider call is a new segment: a retried respond overwrites the preview
    }
    const req: ChatRequest = {
      model, system, messages: [...messages], tools, maxTokens: deps.maxTokens ?? DEFAULT_MAX_TOKENS,
      ...(priority === 'bot' ? { priority } : {}),
      ...(sink && tools.some((t) => t.name === 'respond') ? { streamToolInput: true } : {}),
      ...(profile.doc.meta.effort ? { effort: profile.doc.meta.effort } : {}),
    };
    lastReq = req;
    const call = await callProvider(req, resolved.provider, actor, task, deps, modelStart, trigger.pool, sink ? (d) => sink.delta(d) : undefined, openedTask?.id, fbx);
    modelStart = undefined;
    if (call.kind === 'stop') return finish(call.stop);

    turns++;
    costUsd += call.costUsd;
    if (task) {
      const patch = { turnsUsed: task.turnsUsed + 1, ...(task.id !== task.rootId ? { costUsd: task.costUsd + call.costUsd } : {}) };
      task = (await deps.tasks.update(task.id, patch)) ?? task;
    }
    if (call.aborted) return finish(!deps.halt.isHalted() && cancelledNow() ? cancelled() : halted()); // a shutdown or halt abort stays `halted`
    if (cancelledNow()) return finish(cancelled()); // the cancel landed between model calls: the answer is dropped
    if (call.failed !== undefined) {
      if (isQuotaRejection(call.failed)) {
        // OPS-HOLD: the subscription quota rejected the call. Not a fault of the task: it goes back to todo (the scheduler holds Claude-backed work until the reset and offers it again then); the healer never sees it.
        const requeued = !!task && owns;
        if (task && owns) await requeue(deps, task);
        // R8: with no task to re-run, a person whose quota just ran out is told to send the message again when the backup would now serve it (OQ6; nothing is re-dispatched by itself).
        const text = !task && backupNow() ? SEND_AGAIN_TEXT : WAITS_TEXT;
        return finish({ payload: alertPayload(QUOTA_TITLE, text), ...(requeued ? { requeued: 'quota' as const } : {}) });
      }
      // R8: a failed backup call waits for the hold when the error table says so (gate marks, status numbers only; a 400 is a per-task mark, PV-C06); any other failure blocks as before.
      if (fbx?.report({ kind: 'done', failed: call.failed }) === 'wait') return finish(await waitsStop());
      if (task && owns) await block(deps, task, 'error');
      return finish({ payload: alertPayload('Model call failed', 'The model provider failed after retries. Try again later.') });
    }
    fbx?.report({ kind: 'done' }); // R8: the backup served this call (the end alert reports the API spend only then)
    if (call.reason === 'refusal') return finish({ payload: alertPayload('Declined', 'The model declined this request.') });

    if (call.blocks.length) messages.push({ role: 'assistant', content: call.blocks });
    lastText = call.text || lastText;
    const uses = call.blocks.filter((b): b is Extract<ContentBlock, { type: 'tool_use' }> => b.type === 'tool_use');
    if (!uses.length) {
      const payload = textToPayload(call.text);
      const hint = await viewHint(payload.body);
      if (!hint) return finish({ payload });
      messages.push({ role: 'user', content: [{ type: 'text', text: hint }] });
      continue;
    }

    if (deps.halt.isHalted()) return finish(halted()); // halt may land while the model call streams: run no tools
    const ctx: ToolContext = { ...toolBase, task, direct: isDirectHumanRun({ origin, actor, task, trigger: dtrigger }), personStarted, personAdmin, ...otUntilOf(deps, task) };
    const pendingAtRound = run.pending.length; // AA-C15 (C9): approvals filed by this round's tools
    const results: ContentBlock[] = [];
    let terminal: OutboundPayload | undefined;
    for (const u of uses) {
      // ASKBACK-1 (AB4): a question ends the batch: whatever the model called after it is refused without running.
      if (run.asked) {
        results.push({ type: 'tool_result', toolUseId: u.id, content: ASK_REFUSALS.ended, isError: true });
        continue;
      }
      // TA-C10: a cancel that lands mid-batch refuses every later tool (a tool already executing finishes: residual R1)
      if (cancelledNow()) {
        results.push({ type: 'tool_result', toolUseId: u.id, content: 'task cancelled', isError: true });
        continue;
      }
      const pendingBefore = run.pending.length;
      const r = await registry.run(u.name, u.input, ctx);
      // H4: only known tools other than `respond`; a call that became an approval card is neither a failure nor a success.
      if (u.name !== 'respond' && registry.has(u.name) && run.pending.length === pendingBefore) {
        failed.delete(u.name);
        // G2-01: a schema refusal echoes model-chosen text (zod names an unrecognized key), so it shows a fixed reason
        if (r.isError && registry.kindOf(u.name) !== 'read') failed.set(u.name, registry.untrustedOf(u.name) ? FAILED_FIXED : r.content.startsWith('invalid input for ') ? INVALID_FIXED : r.content);
      }
      terminal ??= r.terminal;
      results.push({ type: 'tool_result', toolUseId: u.id, content: r.content, ...(r.isError ? { isError: true } : {}) });
    }
    // LEARN-1 (LL-C1): a kb_search hit taints the run only; the task the run works on carries it too (the opened one already did)
    if (run.tainted() && task && !task.tainted) task = (await deps.tasks.update(task.id, { tainted: true })) ?? task;
    if (run.tainted() && openedTask && !openedTask.tainted) openedTask = (await deps.tasks.update(openedTask.id, { tainted: true })) ?? openedTask;
    // ASKBACK-1 (AB4): a sent question ends the run here; a `respond` earlier in the batch is dropped, and no delivery path posts anything.
    if (run.asked) return finish({ payload: { type: 'chat', body: 'NO_REPLY' }, asked: true });
    const before = task?.status;
    if (task) task = (await deps.tasks.get(task.id)) ?? task;
    else if (openedTask) openedTask = (await deps.tasks.get(openedTask.id)) ?? openedTask;
    if (cancelledNow()) return finish(cancelled());
    // K15: reflect only when this very round moved the actor's own task to done (never stopped, failed, cancelled or admin runs).
    if (task && before !== task.status && task.status === 'done' && owns && !adminRun && deps.reflect) {
      const answer = terminal && 'body' in terminal && typeof terminal.body === 'string' ? terminal.body : lastText;
      costUsd += await deps.reflect({ actor, task, finalAnswer: answer, tainted: run.tainted() });
    }
    if (terminal) {
      const hint = await viewHint(terminal.body);
      if (!hint) return finish({ payload: terminal });
      // not posted yet: the tool result that carried the answer says so, and the model answers again
      results.splice(0, results.length, ...results.map((x) => (x.type === 'tool_result' && x.content === 'sent' ? { ...x, content: `not sent yet: ${hint}` } : x)));
    }
    messages.push({ role: 'user', content: results });
    // AA-C15 (C9): a call that filed an approval which the AI approver decided before this re-read leaves the task `todo`, which ENDS_TURN misses: the run would go on
    // and could end the task (a final report) before the owner run replays the approved call. End the turn instead. The task is the run's own or the conversation
    // task it opened; a card still waiting leaves the row `awaiting_approval` and is handled as before (task: ENDS_TURN; opened task: the model answers, F1).
    // The approved call replays once from the owner run, which waits on the task lock until this run ends.
    const filed = current();
    if (filed && run.pending.length > pendingAtRound && filed.status === 'todo') return finish({ payload: endedPayload('awaiting_approval', lastText) });
    if (task && before !== task.status && ENDS_TURN.includes(task.status)) return finish({ payload: endedPayload(task.status, lastText) });
  }
  // Step cap without an answer: one last call that may only answer, so the person gets a progress report instead of a bare alert.
  const wrap = await wrapUp();
  if (wrap) return finish(wrap);
  return finish({ payload: lastText ? textToPayload(lastText) : alertPayload('Too many steps', 'Stopped after too many tool steps without an answer.'), stopped: 'turns' });

  async function wrapUp(): Promise<Stop | null> {
    if (!lastReq || deps.halt.isHalted() || cancelledNow()) return null;
    if (task && !turnsLifted && !deps.limits.checkTurn(task)) return null;
    const last = messages.at(-1);
    if (!last || last.role !== 'user' || !Array.isArray(last.content)) return null;
    messages[messages.length - 1] = { ...last, content: [...last.content, { type: 'text', text: WRAP_UP_TEXT }] };
    // Only `respond` is offered (the Claude API refuses a history holding tool blocks when no tool is defined); any other call is ignored, never run.
    const only = lastReq.tools.filter((t) => t.name === 'respond');
    const req: ChatRequest = { ...lastReq, messages: [...messages], tools: only.length ? only : lastReq.tools };
    if (apiBlocked()) return waitsStop(); // R8 (PV-C02): the wrap-up is a call too
    const sink = trigger.stream;
    sink?.segment(new Set(req.tools.map((t) => t.name)));
    const call = await callProvider(req, resolved.provider, actor, task, deps, undefined, trigger.pool, sink ? (d) => sink.delta(d) : undefined, openedTask?.id, fbx);
    if (call.kind === 'stop') return call.stop;
    turns++;
    costUsd += call.costUsd;
    if (task) {
      const patch = { turnsUsed: task.turnsUsed + 1, ...(task.id !== task.rootId ? { costUsd: task.costUsd + call.costUsd } : {}) };
      task = (await deps.tasks.update(task.id, patch)) ?? task;
    }
    if (call.failed !== undefined && !call.aborted && fbx?.report({ kind: 'done', failed: call.failed }) === 'wait') return waitsStop();
    if (call.aborted || call.failed !== undefined || call.reason === 'refusal' || cancelledNow()) return null;
    const answer = call.blocks.find((b): b is Extract<ContentBlock, { type: 'tool_use' }> => b.type === 'tool_use' && b.name === 'respond');
    const parsed = answer ? respondInput.safeParse(answer.input) : null;
    if (parsed?.success) return { payload: toPayload(parsed.data), stopped: 'turns' };
    return call.text.trim() ? { payload: textToPayload(call.text), stopped: 'turns' } : null;
  }
}

/** H4 (HL-C15): the reason shown for a tool whose output is untrusted text, or whose error text is empty. */
const FAILED_FIXED = 'the call failed';
/** G2-01: the reason shown for a call the registry refused for its input (the zod text can name model-chosen keys). */
const INVALID_FIXED = 'the call had invalid input';
const FOOTER_LINES = 3;
/**
 * H4 (HL-C15): the code-written "Not done" block. Tool names are registered names (the caller checked), reasons are the tool's error text:
 * redacted with the literal secret list, folded to one line, escaped (mentions defanged, hidden characters made visible), cut to 160, URLs defanged.
 */
export function notDoneFooter(failed: ReadonlyMap<string, string>, secrets: readonly string[]): string {
  const lines = [...failed].slice(0, FOOTER_LINES).map(([tool, reason]) => {
    const text = escapeCardText(reason.replace(/\s+/g, ' ').trim(), 160, secrets).replace(/https?:\/\//gi, (m) => `hxxp${m.slice(4)}`) || FAILED_FIXED;
    return `- ${tool.replace(/[^A-Za-z0-9_.:-]/g, '').slice(0, 40)}: ${text}`;
  });
  if (failed.size > FOOTER_LINES) lines.push(`- and ${failed.size - FOOTER_LINES} more`);
  return `\u26a0\ufe0f Not done:\n${lines.join('\n')}`;
}

/** Fixed text for the answer-only wrap-up call at the step cap. */
const WRAP_UP_TEXT = 'You have no tool steps left in this run. Call no tool except respond. Reply now to the person in their language: what you did, what is still left, and what you need from them to continue.';

/** The shared reserve -> stream -> settle -> audit core (agents/call/call.ts), mapped to this loop's stops and cap approvals. */
async function callProvider(req: ChatRequest, provider: LLMProvider, actor: ActorRef, task: Task | null, deps: AgentDeps, started?: () => Promise<void>, pool?: 'warroom', onDelta?: (c: StreamDelta) => void, trackTaskId?: string, fbx?: { report(o: Parameters<typeof reportFallback>[2]): 'wait' | null; wait(): Promise<Stop> }): Promise<Call> {
  // R8: on the fallback route every call (the wrap-up included) goes out as a fallback request: route flag, and no media block (G8)
  const o = await callCore(fbx ? fallbackRequest(req) : req, provider, actor, task, deps, started, pool, undefined, onDelta, trackTaskId);
  if (o.kind === 'done') return o;
  // R8 (G10): a company, bot or department refusal on the backup holds the actor for the rest of the day or the hold: mark it and requeue. Task, project and price keep their own flows.
  if (o.kind === 'refused' && fbx?.report({ kind: 'refused', scope: o.scope }) === 'wait') return { kind: 'stop', stop: await fbx.wait() };
  if (o.kind === 'refused' && o.scope === 'task' && task) return { kind: 'stop', stop: await treeCapHit(task, o.est, actor, deps) };
  if (o.kind === 'refused' && o.scope === 'local_task' && task) return { kind: 'stop', stop: await localCapHit(task, actor, deps) };
  if (o.kind === 'refused' && o.scope === 'project' && task) return { kind: 'stop', stop: await projectBudgetHit(task, actor, deps) };
  return { kind: 'stop', stop: { payload: alertPayload('Budget', budgetText(o, req.model)), stopped: 'budget' } };
}

/** Gate 1 D1 / R16: tree spend reached its cap, so ask for a bigger cap (the task waits) or block when refused. */
async function treeCapHit(task: Task, est: number, actor: ActorRef, deps: AgentDeps): Promise<Stop> {
  try {
    const a = await deps.approvals.onTreeCapHit({ rootId: task.rootId, taskId: task.id, est, requestedBy: actor });
    const body = a
      ? 'This task tree reached its budget. An approval for a higher cap was requested; the task waits for it.'
      : 'This task tree reached its budget and no higher cap can be requested. The task is blocked.';
    return { payload: alertPayload('Task budget reached', body), stopped: 'budget' };
  } catch {
    await deps.audit({ actor: actorKey(actor), action: 'approval.tree_cap', taskId: task.id, outcome: 'error' });
    return { payload: alertPayload('Task budget reached', 'This task tree reached its budget. Approval could not be requested.'), stopped: 'budget' };
  }
}

/**
 * AUTO-1 (SA-1 3.4): the task's project used its budget. The port blocks the task (reason budget), sends the one notice (exhaust, a claim-first CAS) and never throws
 * out of here; with no port (tests, autopilot not wired) the task is blocked here. The text is fixed and holds nothing from the run.
 */
async function projectBudgetHit(task: Task, actor: ActorRef, deps: AgentDeps): Promise<Stop> {
  try {
    if (deps.autopilot) await deps.autopilot.budgetHit(task);
    else await block(deps, task, 'budget');
  } catch {
    await deps.audit({ actor: actorKey(actor), action: 'project.budget_hit', taskId: task.id, outcome: 'error' });
    try { await block(deps, task, 'budget'); } catch { /* the stop below still ends the run */ }
  }
  return { payload: alertPayload('Project budget used up', 'This project used its budget. The owner was asked to add budget or close the project; this task is blocked until then.'), stopped: 'budget' };
}

/** Gate 1 L8: the tree used its local call cap, so ask for a higher cap (the task waits) or block when refused. */
async function localCapHit(task: Task, actor: ActorRef, deps: AgentDeps): Promise<Stop> {
  const title = 'Local call cap reached';
  try {
    const a = await deps.approvals.onLocalCapHit({ rootId: task.rootId, taskId: task.id, requestedBy: actor });
    const body = a
      ? 'This task tree used its local model call cap. An approval for a higher cap was requested; the task waits for it.'
      : 'This task tree used its local model call cap and no higher cap can be requested. The task is blocked.';
    return { payload: alertPayload(title, body), stopped: 'budget' };
  } catch {
    await deps.audit({ actor: actorKey(actor), action: 'approval.local_cap', taskId: task.id, outcome: 'error' });
    return { payload: alertPayload(title, 'This task tree used its local model call cap. Approval could not be requested.'), stopped: 'budget' };
  }
}

/** What a turn that ended on its task's status change posts when the model gave no respond payload. */
function endedPayload(status: TaskStatus, lastText: string): OutboundPayload {
  if (status === 'awaiting_approval') return alertPayload('Awaiting approval', 'This task waits for an admin decision before any further work.');
  if (lastText) return textToPayload(lastText);
  return status === 'done' ? textToPayload('Task marked done.') : alertPayload('Task cancelled', 'This task was cancelled.');
}

async function turnLimit(task: Task, deps: AgentDeps, owns: boolean): Promise<Stop> {
  if (owns) await block(deps, task, 'turns');
  return { payload: alertPayload('Turn limit', 'This task used all its turns.'), stopped: 'turns' };
}

/**
 * Tools get closures over exactly the methods they may call, never the live objects: a Pick<> type alone would
 * still let a tool reach approvals.decide, TaskRepo.pool or Limits.cfg at runtime (Gate 1 D16).
 */
/**
 * OT-1: create_task asks whether the CURRENT task's tree has approved overtime (the root comes from the task row, never from tool input), as `HH:MM` in
 * `schedule.timezone`. Any fault reads as "none".
 */
export function otUntilOf(deps: AgentDeps, task: Task | null): { otUntil?: () => Promise<string | null> } {
  const ot = deps.ot;
  if (!ot || !task) return {};
  return {
    otUntil: async () => {
      try {
        const d = await ot.until(task.rootId);
        return d ? new Intl.DateTimeFormat('en-GB', { timeZone: deps.cfg.get('schedule.timezone'), hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d) : null;
      } catch {
        return null;
      }
    },
  };
}

function toolContextBase(actor: ActorRef, deps: AgentDeps, origin: ToolOrigin, source: ToolSource, run: ToolContext['run'], ensure?: ToolContext['ensureConversationTask'], trigger?: Pick<AgentTrigger, 'taskGate' | 'inMeeting' | 'onTaskWrite' | 'pool' | 'noWarroomSay' | 'postOnly' | 'noAsk' | 'askWake' | 'admin'>, lifted = false): Omit<ToolContext, 'task' | 'direct'> {
  const { org, tasks, approvals, limits, notes } = deps;
  // G2TW-02: the bot root-task cap gates bot-origin warroom runs (and a meeting close's own gate), never a head answering a person.
  // WS1/WS3: `warroom.rootTasksPerDay` is lifted for a local call; the stall guard resets at most once per stall window, so a task write cannot keep a loop alive.
  const rootGate = trigger?.taskGate ?? (trigger?.pool === 'warroom' && !(lifted && deps.cfg.get('limits.localUnlimited')) ? deps.botRoots : undefined);
  return {
    actor,
    origin,
    source,
    tainted: () => run.tainted(),
    run,
    ...(ensure ? { ensureConversationTask: ensure } : {}),
    ...(deps.canMemberView ? { canMemberView: deps.canMemberView } : {}),
    ...(deps.guildId ? { guildId: deps.guildId } : {}),
    ...(deps.channelIsPublic ? { channelIsPublic: deps.channelIsPublic } : {}),
    ...(deps.approvalChannel ? { approvalChannel: deps.approvalChannel } : {}),
    ...(deps.webGrants ? { webGrants: deps.webGrants } : {}),
    // TG-C6: only a run of the main registry (never the admin console's) carries the task-tree grant port
    ...(deps.treeGrants && trigger?.admin !== true ? { treeGrants: deps.treeGrants } : {}),
    // AUTO-1 (AP-C3): the project autopilot port, non-admin runs only (the registry strips it on the approved path and unless it was built for it)
    ...(deps.autopilot?.projectOf && deps.autopilot.decide && trigger?.admin !== true ? { autopilot: { projectOf: deps.autopilot.projectOf, decide: deps.autopilot.decide, ...(deps.autopilot.companyOn ? { companyOn: deps.autopilot.companyOn } : {}), ...(deps.autopilot.inCompany ? { inCompany: deps.autopilot.inCompany } : {}) } } : {}),
    org: {
      canDelegate: (from, to) => org.canDelegate(from, to),
      toolsFor: (a) => org.toolsFor(a),
      dept: (id) => org.dept(id),
      persona: (id) => org.persona(id),
    },
    tasks: {
      create: async (t) => {
        const made = await tasks.create({ ...t, origin: 'delegated' });
        trigger?.onTaskWrite?.();
        return made;
      },
      get: (id) => tasks.get(id),
      ...(tasks.takeForward ? { takeForward: (root: string, cap: number) => tasks.takeForward!(root, cap) } : {}),
      update: async (id, p, e) => {
        const before = p.status !== undefined && trigger?.onTaskWrite ? (await tasks.get(id))?.status : undefined;
        const moved = await tasks.update(id, p, e);
        if (moved && before !== undefined && moved.status !== before) trigger?.onTaskWrite?.(); // G2TW-05: only a real status change counts
        return moved;
      },
    },
    // TW6: a run with no task (warroom talk, a meeting close) counts its root tasks against the daily cap; TW13: meetings
    ...(rootGate ? { rootTaskGate: rootGate } : {}),
    ...(deps.meetings ? { meetings: deps.meetings } : {}),
    ...(deps.warroomSay ? { warroom: deps.warroomSay } : {}),
    ...(deps.ask ? { ask: deps.ask } : {}),
    ...(deps.heal ? { heal: deps.heal } : {}),
    ...(trigger?.noAsk ? { noAsk: true as const } : {}),
    ...(trigger?.askWake ? { askWake: trigger.askWake } : {}),
    ...(trigger?.noWarroomSay || trigger?.postOnly ? { noWarroomSay: true as const } : {}),
    ...(trigger?.inMeeting ? { inMeeting: true as const } : {}),
    ...(lifted ? { localLifted: true as const } : {}),
    approvals: { needsApproval: (e) => approvals.needsApproval(e), request: (r) => approvals.request(r) },
    limits: { checkDepth: (d) => limits.checkDepth(d), checkChildren: (id) => limits.checkChildren(id), checkOpenTasks: () => limits.checkOpenTasks() },
    // K1: a note carries the taint of the run that wrote it (code reads it from the run, never from tool input)
    notes: { add: (d, t, b) => notes.add(d, t, b, { tainted: run.tainted(), source: 'task' }) },
    bus: deps.bus,
    audit: deps.audit,
    duties: () => deps.cfg.get('duties.byDept'),
    ...(deps.online ? { deptOnline: (d: string) => deps.online!(d) } : {}),
    ...(deps.offDay ? { offDay: () => deps.offDay!() } : {}),
    // TEAMTALK-1: the range check of create_task's `due` reads today's date in the schedule timezone
    today: () => localDay(Date.now(), deps.cfg.get('schedule.timezone')).date,
  };
}

/**
 * The ToolContext for an approved call the scheduler runs before the owner run (R4): the task's own origin and thread,
 * a fresh run state, never direct. `task` is the task the approval belongs to (ctx.task is never left unset).
 */
export function approvedToolContext(actor: ActorRef, task: Task, deps: AgentDeps, projectToolsIn: readonly string[] = []): ToolContext {
  const projectTools = projectToolsIn.filter((t) => !t.startsWith('mcp_')); // R6 MC-C1: a replay never adds an external tool through a project or tree row
  const trigger: AgentTrigger = { route: { actor, reason: 'task_owner', taskId: task.id }, task, history: [] };
  const run = newRunState();
  if (task.tainted) run.markTainted(); // G2-04: a task created by an approved call below inherits the task's taint
  // TG-C6: a replay of an approved call never carries the task-grant port (the registry strips it too: two lines)
  const { treeGrants: _noGrant, autopilot: _noAutopilot, ...base } = toolContextBase(actor, deps, task.origin, sourceOf(trigger, deps), run);
  // AUTO-1 (SA-1 3.8, AP-C7): an approved card for a project tool must pass the allowlist on replay; the union is for this actor only
  const org = projectTools.length ? { ...base.org, toolsFor: (a: ActorRef) => (sameActor(a, actor) ? [...new Set([...base.org.toolsFor(a), ...projectTools])] : base.org.toolsFor(a)) } : base.org;
  return { ...base, org, task, direct: false };
}

const HUMAN_ORIGINS_LOOP: readonly Task['origin'][] = ['chat', 'slash', 'voice'];

/**
 * WS5: whether a person is behind this run: their own message, or a task in a tree a person started (the task or its root has a human
 * origin and requester; roll-ups of such a tree count). Bot talk, meeting turns and bot-rooted trees are not.
 */
async function humanBehind(t: AgentTrigger, task: Task | null, deps: AgentDeps): Promise<boolean> {
  if (t.msg?.author.kind === 'human') return true;
  if (t.pool === 'warroom' || t.inMeeting) return false;
  if (!task) return false;
  try {
    const root = task.id === task.rootId ? task : await deps.tasks.get(task.rootId);
    return !!root && root.requester.kind === 'human' && HUMAN_ORIGINS_LOOP.includes(root.origin);
  } catch {
    return false;
  }
}

/** P1: the task row decides; without one only a human's own message carries a human origin, anything else is delegated. */
function originOf(t: AgentTrigger): ToolOrigin {
  if (t.task) return t.task.origin;
  return t.msg && t.msg.author.kind === 'human' ? t.msg.origin : 'delegated';
}

/** What started the run. An owner run without a message (task.ready, resume after approval, roll-up) is never a human speaking. */
function directTriggerOf(t: AgentTrigger): DirectTrigger {
  if (t.msg?.author.kind === 'human') return { kind: 'human_message', userId: t.msg.author.id, origin: t.msg.origin };
  return t.msg ? { kind: 'child_report' } : { kind: 'owner_run' };
}

function sourceOf(t: AgentTrigger, deps: AgentDeps): ToolSource {
  const { msg, task } = t;
  if (msg) {
    return {
      channelId: msg.threadId ? (msg.parentChannelId ?? msg.channelId) : msg.channelId, threadId: msg.threadId, messageId: msg.id,
      userId: msg.author.kind === 'human' ? msg.author.id : null,
      attachments: msg.attachments.map((a) => ({ url: a.url, name: a.name, size: a.size })),
      ...(msg.replied?.attachments?.length ? { replyAttachments: msg.replied.attachments.map((a) => ({ url: a.url, name: a.name, size: a.size })) } : {}),
      ...(msg.forward?.attachments?.length ? { forwardAttachments: msg.forward.attachments.map((a) => ({ url: a.url, name: a.name, size: a.size })) } : {}),
      ...(t.admin ? { triggerText: msg.content, ...(t.modTier ? { tier: t.modTier, ...(msg.replyToId ? { replyToId: msg.replyToId } : {}) } : {}) } : {}),
    };
  }
  return {
    channelId: task?.channelId ?? (task ? deps.org.dept(task.deptId)?.workChannelId : null) ?? '',
    // WS13: a top-level conversation has no thread (its "thread id" is the channel id), so tools never post to it as a thread
    threadId: task && !isTopLevelConversation(task) ? task.threadId : null, messageId: null, userId: task?.sourceUserId ?? null, attachments: [],
  };
}

/** OPS-HOLD: a task cut by a quota rejection goes back to `todo` (from doing), mirrored as task.changed; any other status is left alone. */
async function requeue(deps: AgentDeps, task: Task): Promise<void> {
  const cur = await deps.tasks.get(task.id);
  if (cur?.status === 'doing') await setStatus(deps, cur, 'todo', 'doing');
}

async function block(deps: AgentDeps, task: Task, reason: BlockReason): Promise<void> {
  const cur = await deps.tasks.get(task.id);
  if (cur && !SETTLED.includes(cur.status)) await setStatus(deps, cur, 'blocked', cur.status, reason);
}

/** Optimistic status change that is mirrored as task.changed; returns the fresh row (or the input if it lost the race). */
async function setStatus(deps: AgentDeps, task: Task, to: TaskStatus, from: TaskStatus, reason?: BlockReason): Promise<Task> {
  const updated = await deps.tasks.update(task.id, { status: to, ...(reason ? { blockedReason: reason } : {}) }, from);
  if (!updated) return task;
  await deps.bus.emit('task.changed', { task: updated, from, to });
  return updated;
}

/**
 * TW7: the actor's own open tasks as a compact header: id, status and department only. Titles and descriptions are left out on purpose,
 * so no text from a tainted run can reach a later run through it. A failed lookup means no header.
 */
async function ownTasksHeader(actor: ActorRef, open: NonNullable<AgentDeps['openTasks']>): Promise<string> {
  try {
    const rows = (await open(actor)).slice(0, 10);
    if (!rows.length) return '';
    const safe = (s: string) => s.replace(/[^\w-]/g, '').slice(0, 24);
    return `Your open tasks (id status dept): ${rows.map((r) => `${safe(r.id).slice(0, 8)} ${safe(r.status)} ${safe(r.deptId)}`).join('; ')}`;
  } catch {
    return '';
  }
}
