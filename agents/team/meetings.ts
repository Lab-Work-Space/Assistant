import type { ConfigStore } from '../../config/store.js';
import { localDay } from '../../company/calendar.js';
import { redactText, DEPT_IDS, type DeptId } from '../../core/index.js';
import type { ActorRef } from '../../company/types.js';
import type { MeetingPort, RootTaskGate } from '../../tools/types.js';
import type { OutboundPayload } from '../loop/payload.js';

/**
 * Gate 1 TW13 (and TW6, TW7): meetings in #💬-ai-warroom.
 *
 * - Weekly meetings are started by CODE from `meetings.weekly` (validated in config/schema.ts), never by a model, and skip off days. Each
 *   (date, kind, time) is claimed in the database before it starts, so a restart cannot start it twice.
 * - An ad-hoc `meeting_start` is capped per day, refused inside any meeting thread and while another meeting is open. Asked from a run
 *   that read outside text it needs approval on top of the cap (the tool's requiresApproval), and the caps are re-checked at replay.
 * - A meeting is at most 9 invitees (heads, de-duplicated, never personas), 2 rounds and 1 CEO close, so it costs at most invitees x 2 + 1
 *   runs, all drawn from the warroom pool (TW4). Mentions and continuation routing are off in its thread until the close is posted.
 * - The close creates at most MAX_CLOSE_TASKS tasks, each through create_task (the existing estimate gate and the daily root-task cap).
 * - Meeting state is in memory: a restart abandons an open meeting (its thread simply stays; the next weekly claim is not repeated).
 */
export const MAX_INVITEES = 9;
export const MAX_AGENDA_POINTS = 5;
export const MAX_CLOSE_TASKS = 10;
const ROUNDS = 2;
/** A weekly meeting still starts when the process was down at its minute, up to this long after it. */
const CATCH_UP_MIN = 120;
const AGENDA_POINT_MAX = 200;
const KNOWN_THREADS_MAX = 200;

export interface MeetingHost {
  canRun(): boolean;
  offDay(): boolean;
  online(dept: DeptId): boolean;
  /** A thread in #💬-ai-warroom started by the CEO; returns its id. */
  openThread(name: string): Promise<string>;
  /** Posts as the CEO into the meeting thread. */
  post(threadId: string, p: OutboundPayload): Promise<string | null>;
  /** One run of `dept` in the thread (pool warroom, tainted, `inMeeting`); resolves when its answer is delivered. */
  turn(dept: DeptId, threadId: string, t: { instruction: string; content: string }, o: { taskGate: RootTaskGate }): Promise<void>;
  /** Ids only: tasks blocked (not by a halt) and open tasks without an update for a few days ("overdue": tasks have no due date). */
  openWork(): Promise<{ blocked: string[]; overdue: string[] }>;
  /** Runs `fn` as a tracked background job. */
  spawn(what: string, fn: () => Promise<void>): void;
}

export interface MeetingsDeps {
  cfg: Pick<ConfigStore, 'get'>;
  now: () => number;
  /** True exactly once per key (the knowledge state table's claimWeek). */
  claim: (key: string) => Promise<boolean>;
  /** Heads that may be invited: enabled departments, in a fixed order. */
  heads: () => DeptId[];
  /** TW6: the daily cap on bot-created root tasks. */
  roots?: RootTaskGate;
  log: { error(o: unknown, m?: string): void; info?(o: unknown, m?: string): void };
}

type Spec = { topic: string; agenda: string[]; invitees: DeptId[]; kind: 'adhoc' | 'planning' | 'progress' | 'review' };

const NO_TASKS: RootTaskGate = { acquire: async () => null };
const clean = (s: string, max: number) => redactText(s).replace(/[\r\n]+/g, ' ').trim().slice(0, max);
const minutesOf = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));

export class Meetings implements MeetingPort {
  private host: MeetingHost | null = null;
  /** Threads of meetings whose close has not been posted. */
  private readonly open = new Set<string>();
  /** Every meeting thread seen (open or closed), bounded: a meeting is never started from inside one. */
  private readonly known: string[] = [];
  private starting = 0;
  private adHoc: { day: string; n: number } = { day: '', n: 0 };

  constructor(private readonly d: MeetingsDeps) {}

  bind(host: MeetingHost): void {
    this.host = host;
  }

  /** TW13: routing in this thread is off (a meeting is running there). */
  isOpen(threadId: string | null): boolean {
    return threadId !== null && this.open.has(threadId);
  }

  private isMeetingThread(threadId: string | null): boolean {
    return threadId !== null && this.known.includes(threadId);
  }

  private today(): string {
    return new Date(this.d.now()).toISOString().slice(0, 10);
  }

  /** The non-mutating checks of an ad-hoc meeting; run before the approval question and again at replay. */
  refusal(from: { threadId: string | null }, lifted = false): string | null {
    const h = this.host;
    if (!h) return 'meetings are not available';
    if (this.isMeetingThread(from.threadId)) return 'a meeting cannot be started from inside a meeting thread';
    if (this.open.size > 0 || this.starting > 0) return 'another meeting is open';
    if (h.offDay()) return 'today is an off day; meetings start on a workday';
    const used = this.adHoc.day === this.today() ? this.adHoc.n : 0;
    // WS1: `meetings.adHocPerDay` is lifted for a local call (`lifted`, decided by the loop); the structure checks above stay.
    if (!(lifted && this.d.cfg.get('limits.localUnlimited')) && used >= this.d.cfg.get('meetings.adHocPerDay')) return `the daily limit of ${this.d.cfg.get('meetings.adHocPerDay')} ad-hoc meetings is reached`;
    return null;
  }

  async start(req: { topic: string; agenda: string[]; invitees: DeptId[]; actor: ActorRef; from?: { threadId: string | null }; lifted?: boolean }): Promise<{ ok: true; id: string } | { ok: false; reason: string }> {
    if (req.actor.kind !== 'head' || req.actor.dept !== 'hq') return { ok: false, reason: 'only the CEO starts meetings' };
    const lifted = !!req.lifted && this.d.cfg.get('limits.localUnlimited') === true;
    const why = this.refusal(req.from ?? { threadId: null }, lifted);
    if (why) return { ok: false, reason: why };
    const spec = this.specOf('adhoc', req.topic, req.agenda, req.invitees);
    if (!spec) return { ok: false, reason: 'no invitee is available' };
    // The daily cap also lives in the database (one claim per slot), so a restart does not give the CEO two more meetings.
    const cap = this.d.cfg.get('meetings.adHocPerDay');
    let slot = false;
    if (lifted) slot = await this.d.claim(`adhoc|${this.today()}|lifted|${this.d.now()}`); // WS1: no daily slot is used up; the counter below still counts
    for (let n = 1; n <= cap && !slot && !lifted; n++) slot = await this.d.claim(`adhoc|${this.today()}|${n}`);
    if (!slot) return { ok: false, reason: `the daily limit of ${cap} ad-hoc meetings is reached` };
    const day = this.today();
    this.adHoc = { day, n: (this.adHoc.day === day ? this.adHoc.n : 0) + 1 };
    this.launch(spec);
    return { ok: true, id: `meeting-${this.d.now()}` };
  }

  /** Validated spec: topic and agenda cleaned and capped, invitees = known online heads, de-duplicated, no CEO, at most 9. Null when nobody is left. */
  private specOf(kind: Spec['kind'], topic: string, agenda: string[], invitees: readonly string[]): Spec | null {
    const online = new Set(this.d.heads().filter((h) => this.host?.online(h) ?? false));
    const list = [...new Set(invitees)].filter((i): i is DeptId => (DEPT_IDS as readonly string[]).includes(i) && i !== 'hq' && online.has(i as DeptId)).slice(0, MAX_INVITEES);
    if (!list.length) return null;
    const points = agenda.map((a) => clean(a, AGENDA_POINT_MAX)).filter(Boolean).slice(0, MAX_AGENDA_POINTS);
    return { kind, topic: clean(topic, 100) || 'Meeting', agenda: points.length ? points : ['Open discussion'], invitees: list };
  }

  private launch(spec: Spec): void {
    this.starting++;
    this.host!.spawn('meeting', async () => {
      try {
        await this.run(spec);
      } catch (err) {
        this.d.log.error({ err }, 'meeting failed');
      } finally {
        this.starting--;
      }
    });
  }

  private async run(spec: Spec): Promise<void> {
    const host = this.host!;
    const date = localDay(this.d.now(), this.d.cfg.get('schedule.timezone')).date;
    const threadId = await host.openThread(clean(`Meeting: ${spec.topic} (${date})`, 100));
    this.open.add(threadId);
    this.known.push(threadId);
    if (this.known.length > KNOWN_THREADS_MAX) this.known.shift();
    try {
      const list = spec.agenda.map((a) => `- ${a}`).join('\n');
      await host.post(threadId, { type: 'chat', title: `Agenda: ${spec.topic}`.slice(0, 256), body: list });
      for (let round = 1; round <= ROUNDS; round++) {
        for (const dept of spec.invitees) {
          if (!host.canRun()) return;
          // TW6: only the CEO's close creates tasks; a round turn gets a gate that always refuses.
          await host.turn(dept, threadId, { instruction: this.invite(round), content: this.brief(spec, list) }, { taskGate: NO_TASKS });
        }
      }
      if (!host.canRun()) return;
      let made = 0;
      const gate: RootTaskGate = {
        acquire: async () => {
          if (made >= MAX_CLOSE_TASKS) return null;
          made++; // taken before the first await, so concurrent calls cannot pass the cap together
          const release = this.d.roots ? await this.d.roots.acquire() : () => undefined;
          if (!release) made--;
          return release ?? null;
        },
      };
      await host.turn('hq', threadId, { instruction: this.closing(), content: this.brief(spec, list) }, { taskGate: gate });
    } finally {
      this.open.delete(threadId); // the close is posted (or the meeting stopped): TW1-TW3 apply to the thread again
    }
  }

  /** The topic and agenda are outside text (a model wrote them): they go to the invitees as the message, which the context builder wraps as untrusted. */
  private brief(spec: Spec, list: string): string {
    return `Meeting topic: ${spec.topic}\nAgenda:\n${list}`;
  }

  // Code-written, shown outside the wrapper. No topic or agenda text in it.
  private invite(round: number): string {
    return `You are in a company meeting, round ${round} of ${ROUNDS}. The topic and agenda are in the new message. ` +
      (round === 1 ? 'Give your department\'s view in at most 5 short lines.' : 'Add only what is new since round 1, in at most 3 lines.') +
      ' Answer NO_REPLY if you have nothing to add. Do not mention other heads and do not create tasks; the CEO closes the meeting.';
  }

  private closing(): string {
    return `You are the chair of this company meeting and you close it now. The topic and agenda are in the new message; the round answers are in the recent conversation. ` +
      `Post the decisions as lines in the form "who does what by which working day" (at most ${MAX_CLOSE_TASKS}). ` +
      'Create one task with create_task per decision that needs an owner (one line, one task). End with a one-line summary.';
  }

  /**
   * TW13: the weekly meetings of `meetings.weekly`, started by code. Call about once a minute. Nothing starts on an off day, while the
   * company is halted, or while another meeting is open; each (date, kind, time) is claimed once.
   */
  async tick(): Promise<void> {
    const host = this.host;
    if (!host || !host.canRun() || host.offDay()) return;
    const tz = this.d.cfg.get('schedule.timezone');
    const nowMs = this.d.now();
    const { date, weekday } = localDay(nowMs, tz);
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(nowMs);
    const nowMin = minutesOf(parts);
    for (const e of this.d.cfg.get('meetings.weekly')) {
      const at = minutesOf(e.time);
      if (e.day !== weekday || nowMin < at || nowMin >= at + CATCH_UP_MIN) continue;
      if (this.open.size > 0 || this.starting > 0) return; // retried on the next tick, inside the window
      if (!(await this.d.claim(`${date}|${e.kind}|${e.time}`))) continue;
      const spec = await this.weeklySpec(e);
      if (spec) this.launch(spec);
    }
  }

  private async weeklySpec(e: { kind: 'planning' | 'progress' | 'review'; topic: string }): Promise<Spec | null> {
    const invitees = this.d.heads();
    if (e.kind === 'planning') return this.specOf('planning', e.topic, ['Goals for the week', 'Progress against last week', 'Blockers and decisions needed'], invitees);
    if (e.kind === 'review') return this.specOf('review', e.topic, ['What was delivered this week', 'What was not delivered and why', 'What to change next week'], invitees);
    // Wednesday: only when something is blocked or overdue; the agenda holds ids, never titles.
    const work = await this.host!.openWork();
    if (!work.blocked.length && !work.overdue.length) {
      this.d.log.info?.({ kind: e.kind }, 'progress meeting skipped: nothing blocked or overdue');
      return null;
    }
    const ids = (a: string[]) => a.slice(0, 10).map((i) => i.slice(0, 8)).join(', ');
    return this.specOf('progress', e.topic, [
      ...(work.blocked.length ? [`Blocked tasks (${work.blocked.length}): ${ids(work.blocked)}`] : []),
      ...(work.overdue.length ? [`Overdue tasks (${work.overdue.length}): ${ids(work.overdue)}`] : []),
      'Who unblocks what, by which working day',
    ], invitees);
  }
}
