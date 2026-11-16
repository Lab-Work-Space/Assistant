import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderBoard, renderStatus, TaskBoard } from './task-board.js';

type Snap = Parameters<typeof renderBoard>[0];
const empty = (): Snap => ({ doing: { total: 0, rows: [] }, blocked: { total: 0, rows: [] }, review: { total: 0, rows: [] }, todo: { total: 0, rows: [] }, done: { total: 0, rows: [] } });
const row = (i: number, title = `task ${i}`) => ({ id: `${String(i).padStart(8, '0')}-aaaa`, deptId: 'software', title });

describe('renderBoard', () => {
  it('sections Doing / Blocked / Review / Todo / Done today with `#id dept title` lines', () => {
    const s = empty();
    s.doing = { total: 1, rows: [row(1, 'Build `x`\nnow')] };
    s.done = { total: 1, rows: [row(2)] };
    const p = renderBoard(s);
    expect(p.body).toBe('**Doing (1)**\n#00000001 software Build x now\n\n**Done today (1)**\n#00000002 software task 2');
    expect(renderBoard(empty()).body).toBe('No open tasks.');
  });

  it('a section over its row cap ends with "+N more" and the whole board stays under the size cap', () => {
    const s = empty();
    s.todo = { total: 500, rows: Array.from({ length: 12 }, (_, i) => row(i)) };
    s.doing = { total: 40, rows: Array.from({ length: 12 }, (_, i) => row(i, 'x'.repeat(200))) };
    const body = renderBoard(s).body;
    expect(body).toContain('+488 more');
    expect(body).toContain('+28 more');
    expect(body.length).toBeLessThan(4000);
  });
});

describe('TaskBoard debounce', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  const mk = () => {
    const calls: string[] = [];
    const port = { upsertBoard: vi.fn(async (_k: string, p: { body: string }) => void calls.push(p.body)) };
    const tasks = { boardSnapshot: vi.fn(async () => empty()) };
    const board = new TaskBoard({ tasks, port, log: { error: vi.fn() }, now: () => Date.now() });
    return { board, port, tasks };
  };

  it('at most one edit per 60 s however many changes arrive; changes inside the window collapse into one run at its end', async () => {
    const t = mk();
    for (let i = 0; i < 20; i++) t.board.touch();
    await vi.advanceTimersByTimeAsync(0);
    expect(t.port.upsertBoard).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 50; i++) { t.board.touch(); await vi.advanceTimersByTimeAsync(1000); }
    expect(t.port.upsertBoard).toHaveBeenCalledTimes(1); // 50 s into the window
    await vi.advanceTimersByTimeAsync(10_000);
    expect(t.port.upsertBoard).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(t.port.upsertBoard).toHaveBeenCalledTimes(2); // nothing changed: no run at all
    t.board.touch();
    await vi.advanceTimersByTimeAsync(0);
    expect(t.port.upsertBoard).toHaveBeenCalledTimes(3);
  });

  it('a failing update is logged, not thrown, and still counts toward the interval; stop() cancels the pending run', async () => {
    const t = mk();
    t.port.upsertBoard.mockRejectedValueOnce(new Error('discord down'));
    t.board.touch();
    await vi.advanceTimersByTimeAsync(0);
    t.board.touch();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(t.port.upsertBoard).toHaveBeenCalledTimes(1);
    t.board.stop();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(t.port.upsertBoard).toHaveBeenCalledTimes(1);
  });
});

describe('WS10 the status dashboard shows counts only', () => {
  const counts = { open: 7, blocked: 2, review: 1, doneToday: 4, pendingByCategory: [{ categoryId: '1570000000000000001', n: 2 }, { categoryId: null, n: 1 }] };
  it('renders task counts, pending approvals per category and bot status; no title, no spend', () => {
    const p = renderStatus(counts, new Map([['1570000000000000001', 'Software *House*']]), { online: 8, total: 10, paused: false, halted: false });
    expect(p.body).toContain('open 7 | blocked 2 | review 1 | done today 4');
    expect(p.body).toContain('Approvals pending** 3');
    expect(p.body).toContain('Software House: 2');
    expect(p.body).toContain('no category: 1');
    expect(p.body).toContain('8/10 online');
    expect(p.body.toLowerCase()).not.toContain('spend');
    expect(p.body).not.toContain('$');
    expect(p.origin).toBe('governance');
    expect(renderStatus(counts, new Map(), { online: 0, total: 10, paused: false, halted: true }).body).toContain('HALTED');
  });

  it('a category name cannot carry a mention or markdown', () => {
    const p = renderStatus(counts, new Map([['1570000000000000001', '@everyone <@123> #x `y`']]), { online: 1, total: 1, paused: false, halted: false });
    expect(p.body).not.toMatch(/[@<>`#]\w/);
  });
});

describe('WS10 the dashboard board: its own key and channel, one edit per 60 s, off without a channel', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  it('upserts under its key into the configured channel at most once a minute; a null channel does nothing', async () => {
    let channel: string | null = '1570000000000000555';
    const port = { upsertBoard: vi.fn(async () => undefined) };
    const build = vi.fn(async () => ({ type: 'task' as const, origin: 'governance' as const, title: 'Company status', body: 'x' }));
    const board = new TaskBoard({ tasks: { boardSnapshot: vi.fn() }, port, log: { error: vi.fn() }, key: 'status-board', build, channelId: () => channel });
    for (let i = 0; i < 30; i++) { board.touch(); await vi.advanceTimersByTimeAsync(1000); }
    expect(port.upsertBoard.mock.calls.length).toBe(1 + 0); // 30 s: the first run only
    await vi.advanceTimersByTimeAsync(40_000);
    expect(port.upsertBoard).toHaveBeenCalledTimes(2);
    expect(port.upsertBoard.mock.calls[0]).toMatchObject(['status-board', { title: 'Company status' }, '1570000000000000555']);
    channel = null;
    board.touch();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(port.upsertBoard).toHaveBeenCalledTimes(2);
    expect(build).toHaveBeenCalledTimes(2);
  });
});
