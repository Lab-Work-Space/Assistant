import type { OutboundPayload } from '../loop/payload.js';
import type { TaskRepo } from '../../db/repos/tasks.js';
import type { DiscordPort } from '../../discord/port.js';

/** `board_messages.key` of the summary board in #📋-tasks. */
export const BOARD_KEY = 'tasks-board';
export const BOARD_MIN_INTERVAL_MS = 60_000;
const SECTIONS = [['doing', 'Doing'], ['blocked', 'Blocked'], ['review', 'Review'], ['todo', 'Todo'], ['done', 'Done today']] as const;
const LINES_PER_SECTION = 12;
const TITLE_MAX = 60;
/** Under Discord's 4096-character embed description, with room for the section headers. */
const BODY_MAX = 3600;

type Snapshot = Awaited<ReturnType<TaskRepo['boardSnapshot']>>;

const oneLine = (t: string) => t.replace(/[\r\n`]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, TITLE_MAX);

/** Sections Doing / Blocked / Review / Todo / Done today; lines `#id dept title`; a section or the whole board ends with "+N more" at its cap. Pure. */
export function renderBoard(snap: Snapshot): OutboundPayload {
  const parts: string[] = [];
  let size = 0;
  for (const [key, name] of SECTIONS) {
    const sec = snap[key];
    if (sec.total === 0) continue;
    const head = `**${name} (${sec.total})**`;
    const lines: string[] = [];
    let shown = 0;
    for (const r of sec.rows.slice(0, LINES_PER_SECTION)) {
      const line = `#${r.id.slice(0, 8)} ${r.deptId} ${oneLine(r.title)}`;
      if (size + head.length + lines.join('\n').length + line.length + 40 > BODY_MAX) break;
      lines.push(line);
      shown++;
    }
    if (sec.total > shown) lines.push(`+${sec.total - shown} more`);
    const block = [head, ...lines].join('\n');
    parts.push(block);
    size += block.length + 2;
  }
  return { type: 'task', origin: 'governance', title: 'Task board', body: parts.length ? parts.join('\n\n') : 'No open tasks.' };
}

export interface TaskBoardDeps {
  tasks: Pick<TaskRepo, 'boardSnapshot'>;
  port: Pick<DiscordPort, 'upsertBoard'>;
  /** Work-style §5 (WS10): another board on the same debounce: its `board_messages` key, the payload to render, and the live channel (null = off). Default: the tasks board in #📋-tasks. */
  key?: string;
  build?: () => Promise<OutboundPayload>;
  channelId?: () => string | null;
  log: { error(o: unknown, m?: string): void };
  minIntervalMs?: number;
  now?: () => number;
}

/**
 * The pinned summary board, debounced: at most one edit per `minIntervalMs`, a single timer (Gate 1 TW15). touch() is cheap and
 * may be called on every task change; changes inside the window collapse into the one run at its end.
 */
export class TaskBoard {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private again = false;
  private stopped = false;
  private lastRun = Number.NEGATIVE_INFINITY;
  private readonly interval: number;
  private readonly now: () => number;

  constructor(private readonly d: TaskBoardDeps) {
    this.interval = d.minIntervalMs ?? BOARD_MIN_INTERVAL_MS;
    this.now = d.now ?? Date.now;
  }

  touch(): void {
    if (this.stopped || this.timer) return;
    if (this.running) {
      this.again = true;
      return;
    }
    const wait = Math.max(0, this.lastRun + this.interval - this.now());
    this.timer = setTimeout(() => void this.run(), wait);
    this.timer.unref?.();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private async run(): Promise<void> {
    this.timer = null;
    if (this.stopped) return;
    this.running = true;
    this.lastRun = this.now();
    try {
      const channel = this.d.channelId ? this.d.channelId() : undefined;
      if (channel === null) return; // a board with no channel configured is off
      const payload = this.d.build ? await this.d.build() : renderBoard(await this.d.tasks.boardSnapshot(LINES_PER_SECTION));
      await (channel ? this.d.port.upsertBoard(this.d.key ?? BOARD_KEY, payload, channel) : this.d.port.upsertBoard(this.d.key ?? BOARD_KEY, payload));
    } catch (err) {
      this.d.log.error({ err }, 'task board update failed');
    } finally {
      this.running = false;
      if (this.again) {
        this.again = false;
        this.touch();
      }
    }
  }
}

type Counts = Awaited<ReturnType<TaskRepo['dashboardCounts']>>;

/** WS10: counts only. No task title, approval text or spend appears here (spend stays off #📢-announcements until the owner decides otherwise). Pure. */
export function renderStatus(c: Counts, cats: ReadonlyMap<string, string>, bots: { online: number; total: number; paused: boolean; halted: boolean }): OutboundPayload {
  const name = (id: string | null) => (id ? (cats.get(id) ?? `category ${id.slice(-4)}`) : 'no category').replace(/[\r\n`*_~|<>@#]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 30);
  const pending = c.pendingByCategory.reduce((a, r) => a + r.n, 0);
  const lines = [
    `**Tasks** open ${c.open} | blocked ${c.blocked} | review ${c.review} | done today ${c.doneToday}`,
    `**Approvals pending** ${pending}${c.pendingByCategory.length ? `\n${c.pendingByCategory.map((r) => `${name(r.categoryId)}: ${r.n}`).join('\n')}` : ''}`,
    `**Bots** ${bots.online}/${bots.total} online${bots.halted ? ' | HALTED' : bots.paused ? ' | paused' : ''}`,
  ];
  return { type: 'task', origin: 'governance', title: 'Company status', body: lines.join('\n') };
}
