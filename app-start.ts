import { buildSha } from './core/build.js';
import type { Message } from 'discord.js';
import type { Scheduler } from './agents/index.js';
import { OffDayWatch, syncChannelMap, type Calendar, type Org, type OrgRepos } from './company/index.js';
import { createHash } from 'node:crypto';
import { DEPT_IDS, IncidentError, type AppEvents, type Env, type EventBus, type IncidentSink, type Logger } from './core/index.js';
import type { HealRepo, RetroRepo, Pool, TaskChange, TaskRepo } from './db/index.js';
import {
  handleInteraction, registerCommands, toInteractionLike, type ClientManager, type CommandDeps, type DiscordPort, type HqPresence,
  registerPrawCommands, handlePrawInteraction, type PrawCommandDeps, type StartResult,
} from './discord/index.js';
import type { IncomingMessage } from './company/index.js';
import type { Approvals, Budget, Halt } from './governance/index.js';
import { startHealth, type HealthServer } from './health.js';

export interface StartDeps {
  /** The literal secret list masked in every interaction reply (P24). */
  secrets?: readonly string[];
  env: Env;
  log: Logger;
  pool: Pool;
  org: Org;
  orgRepos: OrgRepos;
  tasks: TaskRepo;
  halt: Halt;
  approvals: Approvals;
  budget: Budget;
  scheduler: Scheduler;
  port: DiscordPort;
  clients: ClientManager;
  presence: HqPresence;
  inbound: (m: Message) => Promise<IncomingMessage | null>;
  commands: CommandDeps;
  /** R7: deps of Praw's own command path (handled on the praw client only). */
  prawCommands: PrawCommandDeps;
  bus: EventBus<AppEvents>;
  /** G2-03: boot recovery closes open heal decide tasks (named in a wake claim) before the doing reset; absent = nothing is closed. */
  healRepo?: Pick<HealRepo, 'closeOpenDecideTasks'>;
  /** GROW-1 (GW-C6): boot recovery cancels every open retro task named in retro_runs before the doing reset; absent = nothing is closed. */
  retroRepo?: Pick<RetroRepo, 'closeOpenRetroTasks'>;
  /** Gate 1 L9: whether provider.default names a registered provider (no loops run while it does not). */
  provider: { ready(): boolean; current(): string; watch(fn: () => void): () => void };
  /** The local provider guard refused for a reason whose fix is the probe re-run: one hq alert and one audit row per boot. */
  localRefused?: { code: string; audit: () => Promise<unknown> };
  /** Prompt frontmatter tool names that no registered tool answers to (warn only; they grant nothing). */
  unknownTools?: string[];
  /** R13: plugin groups left off at boot (missing keys); reported only when the set changed since the last boot, or when a group is off because of an error. */
  toolGroups?: { id: string; why: string; error?: true }[];
  /** BOTLOG-1: #bot-log is an incident log: every boot problem is rendered through it. */
  incidents: IncidentSink;
  /** BOTLOG-1: remembers a digest per key across boots (KnowledgeStateRepo.bootNoteChanged); absent = every boot counts as changed. */
  bootNotes?: { bootNoteChanged(key: string, digest: string): Promise<boolean> };
  /** Resolves false when the GitHub denied-repo ids could not be resolved at startup (writes fail closed); one alert, never blocks start. */
  denylistCheck?: Promise<boolean>;
  healthPort: number;
  healthHost: string;
  /** Off days (company/calendar.ts) and the clock they are judged by; absent = never off. */
  calendar?: { cal: Calendar; now: () => number };
  /** OT-1: the overtime sweep (pending requests past their day end; their cards close) and the workday close (pending requests become moot). Absent: neither. */
  ot?: { sweep(): Promise<void>; closeMoot(): Promise<void> };
}

const HOUR_MS = 60 * 60 * 1000;
const DB_CHECK_TIMEOUT_MS = 2000;
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * start(): clears stale reservations (single process, before any loop), connects the clients, registers commands,
 * syncs the channel map, posts startup alerts, recovers tasks, starts approval expiry, the off-day watch and /healthz. When an off
 * day ends the scheduler releases its held roll-ups and task recovery re-schedules the `todo` tasks that waited.
 */
export async function startApp(d: StartDeps): Promise<{ health: HealthServer; expiry: NodeJS.Timeout; offDays: OffDayWatch | null }> {
  const { log, scheduler } = d;
  const recoverNow = taskRecovery(d);
  // DEFECT-001: a recovery a trigger starts in the background is a scheduler job, so idle() waits until it has scheduled what it found (a bare `void` left /resume racing idle()).
  const recoverTracked = () => void scheduler.track('task recovery', recoverNow);
  const recover = recoverNow;
  d.bus.on('halt.changed', (e) => {
    if (!e.halted) recoverTracked();
  });
  d.presence.onRecover(recoverTracked);
  d.provider.watch(() => {
    if (d.provider.ready()) recoverTracked();
  });

  await d.budget.clearStaleReservations();
  const started = await d.clients.start(
    d.env.botTokens,
    async (m) => {
      const msg = await d.inbound(m);
      if (msg) await scheduler.onMessage(msg);
    },
    // The only interaction path: ClientManager listens on hq only and drops other guilds (D5).
    async (i) => {
      const like = toInteractionLike(i, d.secrets ?? []);
      if (like) await handleInteraction(like, d.commands);
    },
    // R7: Praw's own path (guild, denylist, rate limit; no admin gate). Config handlers are never reachable from here.
    async (i) => {
      const like = toInteractionLike(i, d.secrets ?? []);
      if (like) await handlePrawInteraction(like, d.prawCommands);
    },
  );
  const hq = d.clients.client('hq');
  d.presence.watch(hq);
  if (hq) await registerCommands(hq, d.env.guildId).catch((err: unknown) => log.warn({ err: errText(err) }, 'slash command registration failed'));

  const praw = d.clients.client('praw');
  if (praw) await registerPrawCommands(praw, d.env.guildId).catch((err: unknown) => log.warn({ err: errText(err) }, 'praw command registration failed'));

  try {
    if (await syncChannelMap(await d.port.listGuildChannels(), d.orgRepos)) await d.org.reload();
  } catch (err) {
    log.warn({ err: errText(err) }, 'channel map sync failed');
  }

  await startupAlerts(d, started);
  await interruptedCalls(d); // before recovery: an owner run would mark them delivered
  await recover();
  if (!d.halt.isHalted()) await d.approvals.resumeApproved().catch((err: unknown) => log.error({ err }, 'resume approved failed'));

  const expire = async () => {
    await d.approvals.expireOld().then(() => undefined, (err: unknown) => log.error({ err }, 'approval expiry failed'));
    // OPS-HOLD: stale `review` tasks (nothing open under them) are closed by code after review.autoCloseHours; it shares this hourly timer
    await d.scheduler.autoCloseReviews().then(() => undefined, (err: unknown) => log.error({ errName: err instanceof Error ? err.name : 'error' }, 'review autoclose failed'));
    // OT-1: the sweep shares this timer; the SQL expiry check guards every click regardless of when it runs
    await d.ot?.sweep().catch((err: unknown) => log.error({ errName: err instanceof Error ? err.name : 'error' }, 'overtime sweep failed'));
  };
  await expire();
  const expiry = setInterval(() => void expire(), HOUR_MS);
  expiry.unref();

  const cal = d.calendar;
  const offDays = cal ? new OffDayWatch({
    calendar: cal.cal, clock: cal.now, log,
    onWorkday: async () => {
      // OT-1: a day that is a workday needs no overtime: pending requests are moot and their cards close (best effort; recovery must still run)
      await d.ot?.closeMoot().catch((err: unknown) => log.error({ errName: err instanceof Error ? err.name : 'error' }, 'overtime close failed'));
      await recover(); // releases held work and re-schedules waiting todo tasks, once nothing blocks them
    },
  }) : null;
  offDays?.start();

  const health = await startHealth({
    port: d.healthPort,
    host: d.healthHost,
    check: async () => {
      const off = cal?.cal.isOffDay(cal.now());
      const state = {
        clients: d.clients.online(), halted: d.halt.isHalted(), provider: d.provider.ready() ? ('ok' as const) : ('unavailable' as const),
        ...(buildSha() ? { build: buildSha()! } : {}),
        ...(off ? { offDay: off.off, ...(off.reason ? { offDayReason: off.reason } : {}) } : {}),
      };
      const ping = d.pool.query('SELECT 1');
      ping.catch(() => undefined);
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error('db timeout')), DB_CHECK_TIMEOUT_MS)));
      try {
        await Promise.race([ping, timeout]);
        return { db: 'ok' as const, ...state };
      } catch {
        return { db: 'error' as const, ...state };
      } finally {
        clearTimeout(timer);
      }
    },
  });
  log.info({ online: started.online, failed: started.failed.map((f) => f.dept), disabled: started.disabled.map((x) => x.dept) }, 'assistant started');
  return { health, expiry, offDays };
}

/**
 * Crash recovery (spec §12): `doing` -> `todo` once, tasks blocked by a halt -> `todo` (R35), then every `todo` task
 * is scheduled. Does nothing while halted or while hq is offline (D9); it runs again on /resume, when hq comes
 * back and when an off day ends, picking up work skipped meanwhile (including roll-ups the scheduler held over the off day). Every move is mirrored as task.changed.
 */
function taskRecovery(d: StartDeps): () => Promise<void> {
  let bootDone = false;
  let running: Promise<void> | null = null;
  const once = async () => {
    // PROV-1: provider.default being missing no longer stops recovery: the scheduler holds back each owner whose own provider is missing (the task stays todo).
    if (d.halt.isHalted() || d.presence.paused()) return;
    d.scheduler.dayTurned(); // work held over an off day (no-op while it still is one)
    const moved: TaskChange[] = [];
    if (!bootDone) {
      bootDone = true;
      // ASKBACK-1 (AB2 option b): open questions are closed and unresumed rows claimed in the same step as the reset (concurrently, one round trip): both are done before any
      // owner run is scheduled below, so the owner run the reset schedules is the single resume and its own question is never refused as "open".
      // G2-03: a decide task named in a wake claim is closed, never reset: reset would turn it into a plain owner run (uncapped, ask_requester offered)
      // GW-C6: a retro task (code-made `doing`) is cancelled whatever its claim row says, also one whose close failed; the reset would make it a plain full-tool owner run.
      // Both closes run in ONE step (no extra round trip before the reset: the resume-after-halt boot test depends on that timing).
      const [closed0, retros0] = await Promise.all([d.healRepo?.closeOpenDecideTasks(), d.retroRepo?.closeOpenRetroTasks()]);
      const closed = closed0 ?? [];
      const retros = retros0 ?? [];
      if (closed.length) d.log.info({ tasks: closed.length }, 'closed heal decide tasks');
      for (const task of closed) await d.bus.emit('task.changed', { task, from: 'doing', to: 'cancelled' });
      if (retros.length) d.log.info({ tasks: retros.length }, 'closed weekly retro tasks');
      for (const task of retros) await d.bus.emit('task.changed', { task, from: 'doing', to: 'cancelled' });
      const [, reset] = await Promise.all([d.scheduler.bootAsk(), d.tasks.resetDoingToTodo()]);
      if (reset.length) d.log.info({ tasks: reset.length }, 'recovered doing tasks');
      moved.push(...reset.map((task) => ({ task, from: 'doing' as const })));
    }
    moved.push(...(await d.tasks.unblockHalted()).map((task) => ({ task, from: 'blocked' as const })));
    for (const { task, from } of moved) await d.bus.emit('task.changed', { task, from, to: task.status });
    for (const t of await d.tasks.listByStatus('todo')) void d.scheduler.onTaskReady(t.id);
    await d.scheduler.sweepReview(); // close stuck conversation tasks in review without re-running them (after scheduling: keeps recovery timing)
  };
  // A request that arrives during a pass (e.g. the day turns while an off-day pass runs) gets one more pass, which its caller awaits too.
  let again = false;
  const passes = async () => {
    do {
      again = false;
      await once().catch((err: unknown) => d.log.error({ err }, 'task recovery failed'));
    } while (again);
  };
  return () => {
    if (running) {
      again = true;
      return running;
    }
    return (running = passes().finally(() => {
      running = null;
    }));
  };
}

/** Digest of the disabled set (ids + reasons, order independent). */
export const toolGroupsDigest = (groups: { id: string; why: string }[]): string =>
  createHash('sha256').update(groups.map((g) => `${g.id}\u0000${g.why}`).sort().join('\n')).digest('hex').slice(0, 32);

/**
 * D8 / §12 / R13: boot problems as incidents (same format as runtime faults). Tool groups that are merely not configured are reported
 * once per change of the disabled set (digest kept in the database), never on every boot; a group off because of an error is reported each boot.
 */
export async function startupAlerts(d: StartDeps, r: StartResult): Promise<void> {
  const rep = (stage: string, err: IncidentError, dept?: string) => d.incidents.report({ source: 'boot', stage, err, ...(dept ? { dept } : {}) });
  for (const x of r.disabled) rep('discord clients', new IncidentError('client_disabled', `the ${x.dept} bot was turned off because its permissions are unsafe: ${x.warnings.join('; ')}`, 'Fix the Discord permissions of that bot, then restart.', undefined, true), x.dept);
  const offline = [
    ...DEPT_IDS.filter((id) => !d.env.botTokens[id] && d.org.dept(id)?.enabled).map((dept) => ({ dept, why: `no BOT_TOKEN_${dept.toUpperCase()} set` })),
    ...r.failed.map((f) => ({ dept: f.dept, why: f.error })),
  ];
  if (offline.length) rep('discord clients', new IncidentError('client_offline', `bots did not start: ${offline.map((o) => `${o.dept} (${o.why})`).join(', ')}`, 'Set the bot token (npm run tokens:local) or fix the login error, then restart; the other bots run normally.'), offline.length === 1 ? offline[0]!.dept : undefined);
  if (d.localRefused) await localRefusedAlert(d, rep);
  if (!d.provider.ready() && !d.localRefused) rep('provider', new IncidentError('provider_unavailable', `provider.default is ${d.provider.current().replace(/[^a-z0-9-]/gi, '').slice(0, 64)}, which is not available in this process; no agent runs`, 'Run scripts/probe-local-cli.sh (npm run probe:local), or change it with /provider default.', undefined, true));
  if (d.unknownTools?.length) rep('prompts', new IncidentError('unknown_tools', `prompt tool names not registered (they grant nothing): ${d.unknownTools.slice(0, 20).map((n) => n.replace(/[^a-z0-9_-]/gi, '').slice(0, 64)).join(', ')}`, 'Fix the tool names in the prompt frontmatter or load the plugin.'));
  await toolGroupsNotice(d, rep);
  void d.denylistCheck?.then((ok) => (ok ? undefined : rep('github', new IncidentError('denylist_unavailable', 'the denied repositories could not be resolved at startup; every GitHub write is refused until a lookup succeeds', 'Check the GitHub App credentials and installation; reads are unaffected.', undefined, true))));
}

const alerted = new WeakSet<object>();
/** WS-BE4: fixed text only (reason code + fixed command); never CLI output, versions or paths. Once per boot even if called again. */
async function localRefusedAlert(d: StartDeps, rep: (stage: string, err: IncidentError) => void): Promise<void> {
  const lr = d.localRefused!;
  if (alerted.has(lr)) return;
  alerted.add(lr);
  const code = lr.code.replace(/[^a-z_]/g, '').slice(0, 32);
  await lr.audit().catch((err: unknown) => d.log.warn({ err: errText(err) }, 'provider.local.refused audit failed'));
  const noAgent = !d.provider.ready() && d.provider.current() === 'claude-code-local';
  rep('provider', new IncidentError('local_provider_refused', `the local Claude provider was refused at boot (reason: ${code}).${noAgent ? ' No agent runs until this is fixed.' : ''}`, 'Run: bash scripts/probe-local-cli.sh --yes, then restart the app.', undefined, true));
}

async function toolGroupsNotice(d: StartDeps, rep: (stage: string, err: IncidentError) => void): Promise<void> {
  const groups = d.toolGroups ?? [];
  let changed = true;
  try {
    changed = d.bootNotes ? await d.bootNotes.bootNoteChanged('tool-groups', toolGroupsDigest(groups)) : true;
  } catch (err) {
    d.log.warn({ err: errText(err) }, 'tool group digest could not be stored; reporting as changed');
  }
  const errored = groups.filter((g) => g.error);
  const shown = changed ? groups : errored;
  if (!shown.length) return;
  const list = shown.slice(0, 20).map((g) => `${g.id.replace(/[^a-z0-9_-]/gi, '').slice(0, 64)} (${g.why.replace(/[`\r\n]/g, ' ').slice(0, 110)})`).join('; ');
  const hint = errored.length ? 'A group is off because a check FAILED: fix the reason shown (e.g. npm run local:render for docs) and restart.' : 'Set the missing key to enable the group, or ignore if intended. Shown only when this set changes.';
  rep('tool groups', new IncidentError(errored.length ? 'tool_group_error' : 'tool_groups_changed', `disabled tool groups: ${list}`, hint, 900));
}

/** R4 (M3): approved calls claimed before a crash with no recorded outcome are logged and alerted, never re-run. */
async function interruptedCalls(d: StartDeps): Promise<void> {
  try {
    const rows = await d.approvals.interruptedToolCalls();
    if (!rows.length) return;
    d.log.warn({ approvals: rows.map((r) => r.approvalId) }, 'approved tool calls interrupted before their outcome was recorded');
    d.incidents.report({ source: 'boot', stage: 'approved tool calls', err: new IncidentError('interrupted_calls', `${rows.length} approved call(s) were claimed but no outcome was recorded (the process stopped): ${rows.slice(0, 10).map((r) => `approval #${r.approvalId} ${r.name.replace(/[^\w-]/g, '').slice(0, 64)}`).join(', ')}`, 'They were NOT re-run: check the target system for each, then re-request if needed.', undefined, true) });
  } catch (err) {
    d.log.error({ err }, 'interrupted tool call check failed');
  }
}
