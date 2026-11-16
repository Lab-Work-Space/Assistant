import { describe, expect, it, vi } from 'vitest';
import type { MediaJob, NewMediaJob } from '../../../db/repos/media.js';
import { MediaJobService, POLL_DELAYS_MS, VIDEO_TEXT } from './jobs.js';
import { VIDEO_JOB_LIFETIME_MS } from './pins.js';

const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypmp42'), Buffer.alloc(8)]);
const NEW: NewMediaJob = { opName: 'operations/x', requesterId: 'u1', actor: { kind: 'head', dept: 'marketing' }, channelId: 'ch', threadId: 'th', taskId: 't1', reservedUsd: 4, seconds: 8, tainted: true };

function mem() {
  const rows = new Map<string, MediaJob>();
  let n = 0;
  return {
    rows,
    add: async (j: NewMediaJob) => { const id = `j${++n}`; rows.set(id, { ...j, id, status: 'running', createdAt: new Date(0) }); return id; },
    get: async (id: string) => (rows.get(id) ? { ...rows.get(id)! } : null),
    open: async () => [...rows.values()].filter((r) => r.status === 'running' || r.status === 'posting'),
    claimPost: async (id: string) => { const r = rows.get(id); if (r?.status !== 'running') return false; r.status = 'posting'; return true; },
    finish: async (id: string, s: MediaJob['status'], from: 'running' | 'posting' = 'running') => { const r = rows.get(id); if (r?.status !== from) return false; r.status = s; return true; },
  };
}
function rig(o: { poll?: () => Promise<import('../../../providers/gemini/media.js').VideoPoll>; download?: () => Promise<Buffer>; now?: () => number; halted?: () => boolean; view?: boolean; postFails?: boolean } = {}) {
  const repo = mem();
  const sleeps: number[] = [];
  const posts: { text?: string; file?: { name: string; data: Buffer } }[] = [];
  const pollVideo = vi.fn<(n: string, s: AbortSignal) => Promise<import('../../../providers/gemini/media.js').VideoPoll>>(o.poll ?? (async () => ({ done: true as const, uri: 'https://generativelanguage.googleapis.com/v1beta/files/a:download' })));
  const downloadVideo = vi.fn<(u: string, o: { maxBytes: number; hosts: readonly string[] }) => Promise<Buffer>>(o.download ?? (async () => MP4));
  const port = {
    post: vi.fn(async (_a: unknown, _t: unknown, p: { body: string }) => (posts.push({ text: p.body }), 'mp')),
    postFile: vi.fn(async (_a: unknown, _t: unknown, _p: unknown, f: { name: string; data: Buffer }) => { if (o.postFails) throw new Error('x'); posts.push({ file: f }); return 'mf'; }),
    canMemberView: vi.fn(async () => o.view ?? true),
  };
  const records: unknown[][] = [];
  const incidents = { report: vi.fn(() => '') };
  const svc = new MediaJobService({
    repo, client: { pollVideo, downloadVideo }, port: port as never, provenance: { record: async (...a: unknown[]) => void records.push(a) } as never,
    halt: { isHalted: o.halted ?? (() => false), track: () => () => undefined }, log: { info: vi.fn(), warn: vi.fn() }, incidents, clock: o.now ?? (() => 1000),
    sleep: async (ms) => void sleeps.push(ms),
  });
  return { repo, svc, posts, pollVideo, downloadVideo, port, records, incidents, sleeps };
}

describe('RF33 the long-running video job', () => {
  it('polls with a bounded backoff, posts the result ONCE with the job taint, then ends', async () => {
    let calls = 0;
    const r = rig({ poll: async () => (++calls < 4 ? { done: false } : { done: true, uri: 'https://generativelanguage.googleapis.com/v1beta/files/a:download' }) });
    const id = await r.svc.submit(NEW);
    for (let i = 0; i < 20 && r.repo.rows.get(id)!.status === 'running'; i++) await new Promise((x) => setTimeout(x, 5));
    expect(r.repo.rows.get(id)!.status).toBe('posted');
    expect(r.posts.filter((p) => p.file)).toHaveLength(1);
    expect(r.posts[0]!.file!.data).toBe(MP4);
    expect(r.records).toEqual([['mf', 'th', true, 'u1']]);
    expect(r.sleeps).toEqual([10_000, 15_000, 20_000, 30_000]);
  });
  it('the delay list is bounded (last value repeats) and every delay is positive', () => {
    expect(POLL_DELAYS_MS.every((d) => d > 0 && d <= 60_000)).toBe(true);
  });
  it('two racing steps post once: the conditional claim lets only one through', async () => {
    const r = rig();
    const id = await r.repo.add(NEW);
    const out = await Promise.all([r.svc.step(id), r.svc.step(id), r.svc.step(id)]);
    expect(out).toEqual(['ended', 'ended', 'ended']);
    expect(r.posts.filter((p) => p.file)).toHaveLength(1);
    expect(r.port.postFile).toHaveBeenCalledTimes(1);
  });
  it('a finished job is never posted again (an extra step after posted does nothing)', async () => {
    const r = rig();
    const id = await r.repo.add(NEW);
    await r.svc.step(id);
    await r.svc.step(id);
    expect(r.port.postFile).toHaveBeenCalledTimes(1);
  });
  it('lifetime: older than 15 minutes is failed with one fixed notice and one incident, no provider call', async () => {
    const r = rig({ now: () => VIDEO_JOB_LIFETIME_MS + 1 });
    const id = await r.repo.add(NEW);
    expect(await r.svc.step(id)).toBe('ended');
    expect(r.repo.rows.get(id)!.status).toBe('failed');
    expect(r.posts).toEqual([{ text: VIDEO_TEXT.timeout }]);
    expect(r.incidents.report).toHaveBeenCalledTimes(1);
    expect(r.pollVideo).not.toHaveBeenCalled();
    await r.svc.step(id);
    expect(r.posts).toHaveLength(1);
  });
  it('restart: start() resumes running jobs with the deadline from created_at, and fails a job left in posting without re-posting', async () => {
    const r = rig({ now: () => VIDEO_JOB_LIFETIME_MS + 5 });
    const a = await r.repo.add(NEW);
    const b = await r.repo.add(NEW);
    r.repo.rows.get(b)!.status = 'posting';
    await r.svc.start();
    for (let i = 0; i < 20 && r.repo.rows.get(a)!.status === 'running'; i++) await new Promise((x) => setTimeout(x, 5));
    expect(r.repo.rows.get(a)!.status).toBe('failed');
    expect(r.repo.rows.get(b)!.status).toBe('failed');
    expect(r.port.postFile).not.toHaveBeenCalled();
  });
  it('halt cancels polling and posting: no download, no post', async () => {
    let halted = false;
    const r = rig({ halted: () => halted, poll: async () => { halted = true; return { done: true, uri: 'https://generativelanguage.googleapis.com/v1beta/files/a:download' }; } });
    const id = await r.repo.add(NEW);
    await r.svc.step(id);
    expect(r.repo.rows.get(id)!.status).toBe('cancelled');
    expect(r.downloadVideo).not.toHaveBeenCalled();
    expect(r.port.postFile).not.toHaveBeenCalled();
    const r2 = rig({ halted: () => true });
    const id2 = await r2.repo.add(NEW);
    await r2.svc.step(id2);
    expect(r2.repo.rows.get(id2)!.status).toBe('cancelled');
    expect(r2.pollVideo).not.toHaveBeenCalled();
  });
  it('G2RF5-05: a halt that aborts the download posts no failure notice and files no incident', async () => {
    let halted = false;
    const r = rig({ halted: () => halted, download: async () => { halted = true; throw new Error('aborted'); } });
    const id = await r.repo.add(NEW);
    await r.svc.step(id);
    expect(r.repo.rows.get(id)!.status).toBe('cancelled');
    expect(r.posts).toEqual([]);
    expect(r.incidents.report).not.toHaveBeenCalled();
  });
  it('at post time the requester must still see the channel; otherwise nothing is downloaded or posted', async () => {
    const r = rig({ view: false });
    const id = await r.repo.add(NEW);
    await r.svc.step(id);
    expect(r.port.canMemberView).toHaveBeenCalledWith('u1', 'th');
    expect(r.repo.rows.get(id)!.status).toBe('cancelled');
    expect(r.downloadVideo).not.toHaveBeenCalled();
    expect(r.port.postFile).not.toHaveBeenCalled();
  });
  it('download only through the allowlisted hosts with the size cap; a non-mp4 is never posted', async () => {
    const r = rig({ download: async () => Buffer.from('<html>login page</html>') });
    const id = await r.repo.add(NEW);
    await r.svc.step(id);
    expect(r.downloadVideo.mock.calls[0]![1]).toMatchObject({ maxBytes: 10_000_000, hosts: expect.arrayContaining(['generativelanguage.googleapis.com']) });
    expect(r.repo.rows.get(id)!.status).toBe('failed');
    expect(r.port.postFile).not.toHaveBeenCalled();
    expect(r.posts).toEqual([{ text: VIDEO_TEXT.failed }]);
  });
  it('a safety-blocked result is a fixed message, status blocked, no incident', async () => {
    const r = rig({ poll: async () => ({ done: true, filtered: true }) });
    const id = await r.repo.add(NEW);
    await r.svc.step(id);
    expect(r.repo.rows.get(id)!.status).toBe('blocked');
    expect(r.posts).toEqual([{ text: VIDEO_TEXT.blocked }]);
    expect(r.incidents.report).not.toHaveBeenCalled();
  });
  it('five consecutive poll errors fail the job; fewer keep polling; a post failure ends it without a re-post', async () => {
    const r = rig({ poll: async () => { throw new Error('net'); } });
    const id = await r.repo.add(NEW);
    for (let i = 0; i < 4; i++) expect(await r.svc.step(id)).toBe('continue');
    expect(await r.svc.step(id)).toBe('ended');
    expect(r.repo.rows.get(id)!.status).toBe('failed');
    expect(r.incidents.report).toHaveBeenCalledTimes(1);
    const p = rig({ postFails: true });
    const id2 = await p.repo.add(NEW);
    await p.svc.step(id2);
    await p.svc.step(id2);
    expect(p.repo.rows.get(id2)!.status).toBe('failed');
    expect(p.port.postFile).toHaveBeenCalledTimes(1);
  });
});
