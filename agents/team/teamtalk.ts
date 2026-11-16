import { KeyedLock } from '../scheduler/jobs.js';
import { discordLink } from '../../company/forward.js';
import type { ActorRef } from '../../company/types.js';
import type { ErrorSink } from '../../core/events.js';
import type { IncidentSink } from '../../core/incidents.js';
import { redactText } from '../../core/logger.js';
import type { Task, TaskRepo } from '../../db/repos/tasks.js';
import { COUNTED_LIFECYCLE_KINDS, NOTE_KINDS, ROOM_LIFECYCLE_MAX, ROOM_NOTES_MAX, ROOM_TERMINAL_MAX, TERMINAL_KINDS, type RoomEntryStore, type RoomKind } from '../../db/repos/room-entries.js';
import type { DiscordPort } from '../../discord/port.js';
import { ownUserOf } from '../context.js';
import { actorLabel } from '../scheduler/notices.js';
import type { OutboundPayload } from '../loop/payload.js';

/**
 * TEAMTALK-1: what makes the delegation chain and the persona rooms visible. Everything here is CODE-written text around model text; nothing is a
 * model tool. The text is plain (no embeds), goes through the port's `noHandles` path (no live handle, no `<@id>`, no link embeds), is posted as the owner
 * of the thread or room it lands in (so a gateway echo never routes), and every post carries a provenance row with `answer: false`.
 */

export const HANDOFF_TITLE_MAX = 120;
export const HANDOFF_ACCEPT_MAX = 200;
/** Spec: a room line is at most 400 characters. */
export const ROOM_LINE_MAX = 400;
const ENTRY_BODY_MAX = 300;
export const ROOM_SUMMARY_MAX = 250;
export const BOARD_MAX = 1900;
export const BOARD_INTERVAL_MS = 60_000;
/** The owner's final report shown to the roll-up run (H4) and kept in memory: first characters only. */
export const REPORT_EXCERPT_MAX = 1500;
const FINALS_MAX = 200;

const oneLine = (t: string): string => t.replace(/\s+/g, ' ').trim();
const cut = (t: string, n: number): string => (t.length <= n ? t : `${t.slice(0, Math.max(0, n - 1))}…`);

type Target = { channelId: string; threadId?: string };
export type Prov = { tainted: boolean; userId: string | null; answer: false };

/** What the scheduler lends: a post as `actor` that records provenance and never throws (it returns null on failure). */
export interface TeamTalkHost {
  post(actor: ActorRef, target: Target, p: OutboundPayload, prov: Prov): Promise<string | null>;
}

export interface TeamTalkDeps {
  port: Pick<DiscordPort, 'upsertRoomBoard'>;
  tasks: Pick<TaskRepo, 'get' | 'setResultMessage' | 'openOwnedBy'>;
  rooms: RoomEntryStore;
  org: { persona(id: string): { id: string; name: string; deptId: string; directChannelId: string | null } | null };
  halt: { isHalted(): boolean };
  /** Literal secrets masked in everything stored (T10); the port masks again on send. */
  secrets?: readonly string[];
  /** The kill switch `teamtalk.enabled`, read at every use. Absent = on. A read error counts as off. */
  enabled?: () => boolean;
  guildId?: string;
  log: ErrorSink;
  incidents?: IncidentSink;
  /** Records the taint of a board message (the scheduler records every other post itself). */
  provenance?: { record(messageId: string, channelId: string, tainted: boolean, triggerUserId: string | null, answer?: boolean): Promise<void> };
  now?: () => number;
  boardIntervalMs?: number;
}

type Final = { text: string; tainted: boolean };
type BoardState = { timer: ReturnType<typeof setTimeout> | null; last: number; running: boolean; again: boolean };

const LABEL: Record<RoomKind, string> = { assigned: 'New', done: 'Done', blocked: 'Blocked', cancelled: 'Cancelled', idea: 'Idea', decision: 'Decision' };
const EMOJI: Record<RoomKind, string> = { assigned: '📥', done: '✅', blocked: '⛔', cancelled: '🚫', idea: '💡', decision: '📌' };

export class TeamTalk {
  private host: TeamTalkHost | null = null;
  private readonly finals = new Map<string, Final>();
  private readonly boards = new Map<string, BoardState>();
  private readonly failed = new Set<string>();
  private readonly pinWarned = new Set<string>();
  private readonly perTask = new KeyedLock();
  private stopped = false;
  private readonly now: () => number;
  private readonly interval: number;

  constructor(private readonly d: TeamTalkDeps) {
    this.now = d.now ?? Date.now;
    this.interval = d.boardIntervalMs ?? BOARD_INTERVAL_MS;
  }

  bind(host: TeamTalkHost): void {
    this.host = host;
  }

  /** The kill switch, read live: off = no handoff line, room line, board or room memory. */
  enabled(): boolean {
    try {
      return this.d.enabled?.() ?? true;
    } catch {
      return false;
    }
  }

  /** G2TT-02: secrets are masked at the source, BEFORE any cut or slice, so a cut can never leave a partial prefix of one. */
  private red(t: string): string {
    return redactText(t, this.d.secrets ?? []);
  }

  /** A link built from ids only; null without a guild id. */
  link(channelId: string | null | undefined, messageId?: string | null): string | null {
    return discordLink(this.d.guildId, channelId, messageId);
  }

  // ---- H1 / H2 ------------------------------------------------------------------------------------------------------------------

  /** The handoff line of `child` (H1): plain text, at most 600 characters; `held` = an off day keeps the task waiting. */
  handoffPayload(child: Task, o: { held: boolean; /** ASKBACK-1: who the owner waits for (a label made by code from the question row). */ asking?: string }): OutboundPayload {
    const link = this.link(child.threadId);
    const status = o.asking ? `${child.status} · ❓ waiting for ${o.asking}` : o.held && child.status === 'todo' ? 'todo (starts next workday)' : child.status;
    const lines = [
      `➜ Handoff #${child.id.slice(0, 8)}: ${actorLabel(child.requester)} → ${actorLabel(child.owner)}`,
      `Ask: ${cut(oneLine(this.red(child.title)), HANDOFF_TITLE_MAX)}`,
      `Done when: ${child.acceptance ? cut(oneLine(this.red(child.acceptance)), HANDOFF_ACCEPT_MAX) : 'see brief'}`,
      `Due: ${child.dueOn ?? 'none'}   Status: ${status}`,
      ...(link ? [`Thread: ${link}`] : []),
    ];
    return { type: 'chat', body: lines.join('\n'), noHandles: true };
  }

  /** Where a child's card points back to: its parent's thread (H2). */
  backLink(parent: Pick<Task, 'threadId' | 'channelId'> | null): string | null {
    return parent?.threadId ? this.link(parent.threadId) : null;
  }

  // ---- the owner's final report (T6) ---------------------------------------------------------------------------------------------

  /** Called with what the owner's run delivered: the message id goes to the task row, the text and taint stay in process (never read back from Discord). */
  async finalReport(task: Pick<Task, 'id'>, messageId: string | null, text: string, tainted: boolean): Promise<void> {
    if (messageId) await this.d.tasks.setResultMessage(task.id, messageId);
    this.finals.delete(task.id);
    this.finals.set(task.id, { text: redactText(text, this.d.secrets ?? []).slice(0, REPORT_EXCERPT_MAX), tainted });
    if (this.finals.size > FINALS_MAX) this.finals.delete(this.finals.keys().next().value as string);
  }

  /** The text and taint of the owner's last delivered report, or undefined (restart, halt, never delivered). */
  final(taskId: string): Final | undefined {
    return this.finals.get(taskId);
  }

  /** Link to the owner's final report, from the row the caller just read. */
  resultLink(child: Pick<Task, 'threadId' | 'resultMessageId'>): string | null {
    return child.resultMessageId ? this.link(child.threadId, child.resultMessageId) : null;
  }

  // ---- room lines (T9, T10, T12) -------------------------------------------------------------------------------------------------

  async assigned(child: Task): Promise<void> {
    const due = child.dueOn ? ` · due ${child.dueOn}` : '';
    await this.line(child, 'assigned', `${oneLine(this.red(child.title))} from ${actorLabel(child.requester)}${due}`, child.tainted, this.link(child.threadId));
  }

  /** done / blocked / cancelled of a persona-owned task; `child` is the fresh row read after the owner's run ended. */
  async ended(child: Task, to: 'done' | 'cancelled' | 'blocked', summary?: string, reason?: string | null): Promise<void> {
    const tainted = child.tainted || this.final(child.id)?.tainted === true;
    if (to === 'done') {
      await this.line(child, 'done', `${oneLine(this.red(child.title))}: ${cut(oneLine(this.red(summary ?? '(no summary)')), ROOM_SUMMARY_MAX)}`, tainted, this.resultLink(child) ?? this.link(child.threadId));
    } else if (to === 'blocked') {
      // TASKADMIN-1 (TA-C15): an owner block shows its reason (the event summary, masked before the cut)
      const why = (reason ?? child.blockedReason) === 'owner' && summary ? `: ${cut(oneLine(this.red(summary)), ROOM_SUMMARY_MAX)}` : '';
      await this.line(child, 'blocked', `${oneLine(this.red(child.title))}${(reason ?? child.blockedReason) ? ` (${reason ?? child.blockedReason})` : ''}${why}`, tainted, this.link(child.threadId));
    } else await this.line(child, 'cancelled', oneLine(this.red(child.title)), tainted, this.link(child.threadId));
  }

  /** Ideas and decisions of a persona-owned task, three of each at most (the tool schema), six lines per task (the store). Dropped for any other owner. */
  async notes(task: Task, e: { ideas?: string[]; decisions?: string[]; runTainted?: boolean }): Promise<void> {
    if (task.owner.kind !== 'persona') return;
    const tainted = e.runTainted === true || task.tainted;
    for (const [kind, list] of [['idea', e.ideas], ['decision', e.decisions]] as const) {
      for (const t of (list ?? []).slice(0, 3)) await this.line(task, kind, oneLine(this.red(t)).slice(0, 200), tainted, this.link(task.threadId));
    }
  }

  /** One line at a time per task: the per-task caps count rows in the database (READ COMMITTED would let two concurrent inserts both pass), and the lines keep their order. */
  private line(task: Task, kind: RoomKind, text: string, tainted: boolean, link: string | null): Promise<void> {
    return this.perTask.run(task.id, () => this.lineNow(task, kind, text, tainted, link));
  }

  private async lineNow(task: Task, kind: RoomKind, text: string, tainted: boolean, link: string | null): Promise<void> {
    if (task.owner.kind !== 'persona' || !this.enabled() || this.d.halt.isHalted() || !this.host) return;
    const personaId = task.owner.personaId;
    const persona = this.d.org.persona(personaId);
    const room = persona?.directChannelId;
    if (!persona || !room) return;
    // T10: masked and cut BEFORE the insert, so neither the database nor a later prompt holds a literal secret.
    const body = redactText(text, this.d.secrets ?? []).slice(0, ENTRY_BODY_MAX);
    const entry = await this.d.rooms.add(
      { personaId, deptId: persona.deptId, kind, taskId: task.id, body, tainted },
      TERMINAL_KINDS.includes(kind) ? { kinds: TERMINAL_KINDS, max: ROOM_TERMINAL_MAX }
        : COUNTED_LIFECYCLE_KINDS.includes(kind) ? { kinds: COUNTED_LIFECYCLE_KINDS, max: ROOM_LIFECYCLE_MAX }
        : { kinds: NOTE_KINDS, max: ROOM_NOTES_MAX },
    );
    if (!entry) return; // the per-task cap is reached (counted in the database)
    const head = `${EMOJI[kind]} ${LABEL[kind]}: ${body}`;
    const text2 = link ? `${cut(head, ROOM_LINE_MAX - link.length - 3)} · ${link}` : cut(head, ROOM_LINE_MAX);
    const id = await this.host.post({ kind: 'persona', personaId }, { channelId: room }, { type: 'chat', body: text2, noHandles: true }, { tainted, userId: ownUserOf({ task }), answer: false });
    if (id) await this.d.rooms.setMessage(entry.id, id);
    this.touchBoard(personaId);
  }

  // ---- the work board (one pinned message per room) ------------------------------------------------------------------------------

  /** Cheap; call on every change. At most one board write per room per interval, one timer per room. */
  touchBoard(personaId: string): void {
    if (this.stopped || !this.enabled()) return;
    const st = this.boards.get(personaId) ?? { timer: null, last: Number.NEGATIVE_INFINITY, running: false, again: false };
    this.boards.set(personaId, st);
    if (st.timer) return;
    if (st.running) {
      st.again = true;
      return;
    }
    const wait = Math.max(0, st.last + this.interval - this.now());
    st.timer = setTimeout(() => void this.runBoard(personaId), wait);
    st.timer.unref?.();
  }

  /** Runs every pending board now (tests and shutdown). */
  async flush(): Promise<void> {
    const pending = [...this.boards.entries()].filter(([, s]) => s.timer);
    for (const [, s] of pending) {
      clearTimeout(s.timer!);
      s.timer = null;
    }
    for (const [id] of pending) await this.runBoard(id);
  }

  stop(): void {
    this.stopped = true;
    for (const s of this.boards.values()) if (s.timer) clearTimeout(s.timer);
  }

  private async runBoard(personaId: string): Promise<void> {
    const st = this.boards.get(personaId);
    if (!st || this.stopped) return;
    st.timer = null;
    st.running = true;
    st.last = this.now();
    try {
      if (!this.enabled() || this.d.halt.isHalted()) return; // nothing new is posted while halted or switched off; the next change after /resume writes it
      const persona = this.d.org.persona(personaId);
      const room = persona?.directChannelId;
      if (!persona || !room) return;
      const body = await this.boardText(persona);
      const prov = this.d.provenance;
      const res = await this.d.port.upsertRoomBoard({ kind: 'persona', personaId }, room, { type: 'chat', body }, {
        // the board aggregates many sources and is edited in place: always tainted, no person's words (T5)
        onSent: (ids) => ids.forEach((id) => void prov?.record(id, room, true, null, false).catch(() => undefined)),
      });
      if (res.pin !== 'ok' && res.pin !== 'skipped' && !this.pinWarned.has(room)) {
        this.pinWarned.add(room);
        (this.d.log.warn ?? this.d.log.error).call(this.d.log, { channelId: room, reason: res.pin }, 'the room board is not pinned: grant the head Pin Messages on this room (never Manage Messages)');
      }
    } catch (err) {
      this.fail('room board', this.d.org.persona(personaId)?.directChannelId ?? personaId, err);
    } finally {
      st.running = false;
      if (st.again && !this.stopped) {
        st.again = false;
        this.touchBoard(personaId);
      }
    }
  }

  /** Now (open tasks), Done, Ideas, Decisions: plain text under the 2000-character message limit, trimmed from the bottom. */
  private async boardText(persona: { id: string; name: string }): Promise<string> {
    const [open, done, ideas, decisions] = await Promise.all([
      this.d.tasks.openOwnedBy(persona.id, 8),
      this.d.rooms.last(persona.id, ['done'], 5),
      this.d.rooms.last(persona.id, ['idea'], 5),
      this.d.rooms.last(persona.id, ['decision'], 5),
    ]);
    const sec = (title: string, rows: string[]): string[] => [title, ...(rows.length ? rows : ['• none'])];
    const lines = [
      `📋 ${persona.name}: work board`,
      ...sec(`Now (${open.length}):`, open.map((t) => `• #${t.id.slice(0, 8)} ${cut(oneLine(this.red(t.title)), 80)} [${t.status}]${t.dueOn ? ` · due ${t.dueOn}` : ''}`)),
      ...sec(`Done (last ${done.length}):`, done.map((e) => `• ${cut(e.body, 110)}`)),
      ...sec(`Ideas (last ${ideas.length}):`, ideas.map((e) => `• ${cut(e.body, 110)}`)),
      ...sec(`Decisions (last ${decisions.length}):`, decisions.map((e) => `• ${cut(e.body, 110)}`)),
    ];
    let text = lines.join('\n');
    while (text.length > BOARD_MAX && lines.length > 1) {
      lines.pop();
      text = lines.join('\n');
    }
    return cut(text, BOARD_MAX);
  }

  /** One incident per channel; ids and the stage only, never the body. */
  fail(stage: string, channelId: string, err: unknown): void {
    this.d.log.error({ stage, channelId, code: (err as { code?: unknown } | null)?.code }, 'teamtalk step failed');
    if (this.failed.has(channelId)) return;
    if (this.failed.size >= 500) this.failed.clear();
    this.failed.add(channelId);
    this.d.incidents?.report({ source: 'teamtalk', stage, err, channelId });
  }
}
