import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { canonical } from '../config/store.js';
import type { CallResult } from '../vps/ssh.js';
import { makeTar } from '../vps/static.js';
import { DeployService, safeText } from './deploy.js';

const SHA = 'a'.repeat(40);
const CARD = 'c'.repeat(32);
const CHAN = '1565667791938387969';

function rig(script: (obj: Record<string, unknown>, stream?: Buffer) => CallResult, o: { upload?: Buffer | null; now?: () => number } = {}) {
  const calls: { obj: Record<string, unknown>; stream?: Buffer | undefined; line: string }[] = [];
  const pushed: { kind: string; payload: Record<string, unknown> }[] = [];
  const audits: { actor: string; action: string; tool?: string | null; outcome?: string | null }[] = [];
  const jobs = new Map<string, string>();
  const uploads = new Map<string, Buffer>();
  if (o.upload) uploads.set(createHash('sha256').update(o.upload).digest('hex'), o.upload);
  let t = 1_000_000;
  const svc = new DeployService({
    client: { call: async (line, stream) => { const obj = JSON.parse(line) as Record<string, unknown>; calls.push({ obj, stream, line }); return script(obj, stream); } },
    repo: {
      getUpload: async (s) => { const d = uploads.get(s); return d ? { size: d.length, data: d } : null; }, deleteUpload: async (s) => void uploads.delete(s),
      addJob: async (j, _c, _o, _ch) => void jobs.set(j, 'queued'), finishJob: async (j, s) => void jobs.set(j, s), openJobs: async () => [...jobs].filter(([, s]) => s === 'queued').map(([job]) => ({ job, cardId: CARD, op: 'add', channelId: CHAN, createdAt: new Date() })),
    },
    exec: { push: async (kind, payload) => void pushed.push({ kind: kind as string, payload }) },
    audit: async (e) => void audits.push(e), log: { error() {} }, sleep: async () => { t += 15_000; }, now: o.now ?? (() => t), pollEveryMs: 1, maxPollMs: 60_000,
  });
  return { svc, calls, pushed, audits, jobs, uploads, advance: (ms: number) => void (t += ms) };
}
const ok = (data: Record<string, unknown>): CallResult => ({ ok: true, data });
const vpsLine = (calls: { line: string }[]): string => calls.at(-1)!.line;
const resolveOk = (obj: Record<string, unknown>): CallResult => (obj.op === 'resolve' ? ok({ ok: true, msg: 'ok', data: { sha: SHA } }) : ok({}));

describe('propose (V12, V22)', () => {
  it('add: resolves the branch head on the VPS and stores THAT sha on the card', async () => {
    const x = rig(resolveOk);
    const r = await x.svc.propose({ op: 'add', repo: 'blog', category: 'apps' }, 'u1');
    expect(r).toMatchObject({ ok: true, payload: { op: 'add', repo: 'blog', category: 'apps', name: 'blog', sha: SHA } });
    expect(x.calls[0]!.obj).toMatchObject({ op: 'resolve', repo: 'blog', branch: 'main' });
    if (r.ok) expect(r.items[0]!.neu).toContain(`blog@${SHA.slice(0, 12)}`);
    if (r.ok) expect(r.items[0]!.neu).toContain('https://blog.labworkspace.net/');
  });
  it('refuses a model-supplied sha and any malformed request before talking to the VPS', async () => {
    const x = rig(resolveOk);
    expect(await x.svc.propose({ op: 'add', repo: 'blog', category: 'apps', sha: SHA }, 'u1')).toMatchObject({ ok: false });
    expect(await x.svc.propose({ op: 'add', repo: 'a/b', category: 'apps' }, 'u1')).toMatchObject({ ok: false });
    expect(await x.svc.propose({ op: 'add', repo: 'x', category: 'main' }, 'u1')).toMatchObject({ ok: false });
    expect(x.calls).toHaveLength(0);
  });
  it('redeploy and remove ask the registry first; a foreign app is refused at propose', async () => {
    const x = rig((o) => (o.op === 'status' ? ok({ ok: true, msg: 'ok', data: { apps: [{ app: 'apps/blog', repo: 'blog', branch: 'main', kind: 'app' }] } }) : resolveOk(o)));
    expect(await x.svc.propose({ op: 'redeploy', app: 'apps/blog' }, 'u1')).toMatchObject({ ok: true, payload: { op: 'redeploy', app: 'apps/blog', sha: SHA } });
    expect(await x.svc.propose({ op: 'remove', app: 'apps/blog' }, 'u1')).toMatchObject({ ok: true, payload: { op: 'remove', app: 'apps/blog' } });
    const y = rig(() => ok({ ok: false, msg: 'not an assistant-owned app', data: {} }));
    expect(await y.svc.propose({ op: 'remove', app: 'apps/aurora' }, 'u1')).toMatchObject({ ok: false, error: expect.stringContaining('not an assistant-owned app') });
  });
  it('a failed resolve is a refusal, not a guess', async () => {
    const x = rig(() => ok({ ok: false, msg: 'branch not found', data: {} }));
    expect(await x.svc.propose({ op: 'add', repo: 'blog', category: 'apps' }, 'u1')).toMatchObject({ ok: false, error: expect.stringContaining('could not be resolved') });
  });
  it('add without a name derives one here; an underivable repo name asks for a name', async () => {
    const x = rig(resolveOk);
    expect(await x.svc.propose({ op: 'add', repo: 'My_Site.v2', category: 'apps' }, 'u1')).toMatchObject({ ok: true, payload: { name: 'my-site-v2' } });
    expect(await x.svc.propose({ op: 'add', repo: '___', category: 'apps' }, 'u1')).toMatchObject({ ok: false, error: expect.stringContaining('give the site a name') });
  });
  const statusRows = (apps: unknown[]) => (o: Record<string, unknown>): CallResult => (o.op === 'status' ? ok({ ok: true, msg: 'ok', data: { apps } }) : resolveOk(o));
  it('preview: the base comes from the registry, the preview name is computed here and shown as a URL', async () => {
    const x = rig(statusRows([{ app: 'apps/blog', kind: 'app', repo: 'blog', branch: 'main' }, { app: 'apps/shop', kind: 'app', repo: 'shop', branch: 'main' }]));
    const r = await x.svc.propose({ op: 'preview', repo: 'blog', branch: 'feat/x' }, 'u1');
    expect(r).toMatchObject({ ok: true, payload: { op: 'preview', repo: 'blog', branch: 'feat/x', base: 'blog', name: 'blog--feat-x', sha: SHA } });
    if (r.ok) expect(r.items[0]!.neu).toContain('https://blog--feat-x.labworkspace.net/');
    const line = JSON.parse(vpsLine(x.calls)) as Record<string, unknown>;
    expect(line.op).toBe('resolve');
  });
  it('preview is refused without a registry app of that repo, or when two exist and none is named', async () => {
    expect(await rig(statusRows([])).svc.propose({ op: 'preview', repo: 'blog', branch: 'b' }, 'u1')).toMatchObject({ ok: false, error: expect.stringContaining('deploy it first') });
    expect(await rig(statusRows([{ app: 'apps/blog--x', kind: 'preview', repo: 'blog' }, { app: 'api/blog', kind: 'app', repo: 'blog' }])).svc.propose({ op: 'preview', repo: 'blog', branch: 'b' }, 'u1')).toMatchObject({ ok: false }); // previews are of apps/ apps only (V13)
    const two = statusRows([{ app: 'apps/blog', kind: 'app', repo: 'blog' }, { app: 'apps/blog2', kind: 'app', repo: 'blog' }, { app: 'apps/blog--x', kind: 'preview', repo: 'blog' }]);
    expect(await rig(two).svc.propose({ op: 'preview', repo: 'blog', branch: 'b' }, 'u1')).toMatchObject({ ok: false, error: expect.stringContaining('several apps') });
    expect(await rig(two).svc.propose({ op: 'preview', repo: 'blog', branch: 'b', base: 'blog2' }, 'u1')).toMatchObject({ ok: true, payload: { base: 'blog2', name: 'blog2--b' } });
  });
  it('a reply of "queued" to a read means the worker is busy with a build: said plainly, not "not an assistant-owned app"', async () => {
    const x = rig(() => ok({ queued: 'J-0123456789abcdef' }));
    expect(await x.svc.propose({ op: 'remove', app: 'apps/blog' }, 'u1')).toMatchObject({ ok: false, error: expect.stringContaining('busy with another job') });
    expect(await x.svc.read('u1', { kind: 'status' })).toMatchObject({ ok: false, error: expect.stringContaining('busy with another job') });
  });
  it('publish_static needs the stored archive and re-validates it', async () => {
    const tar = makeTar([{ path: 'index.html', data: Buffer.from('<p>x</p>') }]);
    const x = rig(resolveOk, { upload: tar });
    const sha256 = createHash('sha256').update(tar).digest('hex');
    expect(await x.svc.propose({ op: 'publish_static', name: 'landing', category: 'apps', sha256, size: tar.length }, 'u1')).toMatchObject({ ok: true });
    expect(await x.svc.propose({ op: 'publish_static', name: 'landing', category: 'apps', sha256: 'b'.repeat(64), size: tar.length }, 'u1')).toMatchObject({ ok: false });
    const bad = Buffer.from(tar);
    bad[156] = '2'.charCodeAt(0);
    const y = rig(resolveOk, { upload: bad });
    const s2 = createHash('sha256').update(bad).digest('hex');
    expect(await y.svc.propose({ op: 'publish_static', name: 'landing', category: 'apps', sha256: s2, size: bad.length }, 'u1')).toMatchObject({ ok: false, error: expect.stringContaining('not acceptable') });
  });
  it('V22: reads are capped at 10 per minute per user', async () => {
    const x = rig(resolveOk);
    for (let i = 0; i < 10; i++) expect(await x.svc.propose({ op: 'add', repo: 'blog', category: 'apps' }, 'u1')).toMatchObject({ ok: true });
    expect(await x.svc.propose({ op: 'add', repo: 'blog', category: 'apps' }, 'u1')).toMatchObject({ ok: false, error: expect.stringContaining('per minute') });
    expect(await x.svc.propose({ op: 'add', repo: 'blog', category: 'apps' }, 'u2')).toMatchObject({ ok: true });
  });
  it('V22: 60 reads per hour overall', async () => {
    let t = 1_000_000;
    const x = rig(resolveOk, { now: () => t });
    for (let i = 0; i < 60; i++) { t += 7000; expect(await x.svc.propose({ op: 'add', repo: 'blog', category: 'apps' }, `u${i % 10}`)).toMatchObject({ ok: true }); }
    t += 7000;
    expect(await x.svc.propose({ op: 'add', repo: 'blog', category: 'apps' }, 'u99')).toMatchObject({ ok: false, error: expect.stringContaining('per hour') });
  });
});

describe('apply (V22, V23)', () => {
  const stored = { op: 'add', repo: 'blog', category: 'apps', name: 'blog', sha: SHA } as const;
  const cardOf = (payload: unknown, snapshot?: unknown) => ({ id: CARD, payload, snapshot: snapshot ?? { canon: canonical(payload) }, channelId: CHAN });

  it('sends exactly the stored op with the card id, queues the job and reports the result through the outbox', async () => {
    let polls = 0;
    const x = rig((o) => {
      if (o.op === 'add') return ok({ queued: 'J-0123456789abcdef' });
      if (o.op === 'result') return ++polls < 3 ? ok({ state: 'pending' }) : ok({ ok: true, msg: 'ok', data: { app: 'apps/blog', url: 'https://blog.labworkspace.net/', sha: SHA } });
      return ok({});
    });
    const r = await x.svc.apply(cardOf(stored), 'u1');
    expect(r).toMatchObject({ kind: 'done', ok: true, lines: [expect.stringContaining('J-0123456789abcdef')] });
    expect(x.calls[0]!.line).toBe(`{"op":"add","card_id":"${CARD}","repo":"blog","category":"apps","sha":"${SHA}","name":"blog"}\n`);
    await vi.waitFor(() => expect(x.pushed).toHaveLength(1));
    expect(x.pushed[0]).toMatchObject({ kind: 'deploy.result', payload: { cardId: CARD, channelId: CHAN, text: expect.stringContaining('https://blog.labworkspace.net/') } });
    expect(x.jobs.get('J-0123456789abcdef')).toBe('done');
    expect(x.audits.map((a) => a.action)).toEqual(expect.arrayContaining(['deploy.add', 'deploy.result']));
    expect(x.audits.find((a) => a.action === 'deploy.add')!.outcome).toContain(`card:${CARD}`);
  });
  it('refuses a card whose stored op differs from the one that was shown (forged row)', async () => {
    const x = rig(resolveOk);
    const r = await x.svc.apply(cardOf({ ...stored, repo: 'other' }, { canon: canonical(stored) }), 'u1');
    expect(r).toMatchObject({ kind: 'refused', why: expect.stringContaining('differs') });
    expect(x.calls).toHaveLength(0);
  });
  it('refuses a stored op outside the vocabulary or without a sha', async () => {
    const x = rig(resolveOk);
    expect(await x.svc.apply(cardOf({ op: 'add', repo: 'blog', category: 'apps', name: 'blog' }), 'u1')).toMatchObject({ kind: 'refused' });
    expect(await x.svc.apply(cardOf({ op: 'add', repo: 'blog', category: 'setting', name: 'blog', sha: SHA }), 'u1')).toMatchObject({ kind: 'refused' });
    expect(await x.svc.apply(cardOf({ op: 'exec', cmd: 'id' }), 'u1')).toMatchObject({ kind: 'refused' });
    expect(x.calls).toHaveLength(0);
  });
  it('a failed ssh (bad key, unreachable) queues nothing and says why', async () => {
    const x = rig(() => ({ ok: false, code: 'KEY' }));
    const r = await x.svc.apply(cardOf(stored), 'u1');
    expect(r).toMatchObject({ kind: 'done', ok: false, applied: 0, lines: [expect.stringContaining('deploy key')] });
    expect(x.jobs.size).toBe(0);
  });
  it('one deploy at a time: a second card is refused while a job is being watched', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const x = rig((o) => (o.op === 'add' ? ok({ queued: 'J-0123456789abcdef' }) : o.op === 'result' ? ok({ state: 'pending' }) : ok({})));
    let first = true;
    (x.svc as unknown as { d: { sleep: () => Promise<void> } }).d.sleep = async () => { if (first) { first = false; await gate; } x.advance(15_000); };
    expect(await x.svc.apply(cardOf(stored), 'u1')).toMatchObject({ kind: 'done', ok: true });
    expect(x.svc.busy()).toBe(true);
    expect(await x.svc.apply(cardOf(stored), 'u1')).toMatchObject({ kind: 'refused', why: expect.stringContaining('still running') });
    release();
  });
  it('publish_static streams the stored archive after the request line and deletes it', async () => {
    const tar = makeTar([{ path: 'index.html', data: Buffer.from('<p>x</p>') }]);
    const sha256 = createHash('sha256').update(tar).digest('hex');
    const op = { op: 'publish_static', name: 'landing', category: 'apps', sha256, size: tar.length } as const;
    const x = rig((o) => (o.op === 'publish_static' ? ok({ queued: 'J-1111111111111111' }) : ok({ ok: true, msg: 'ok', data: {} })), { upload: tar });
    expect(await x.svc.apply(cardOf(op), 'u1')).toMatchObject({ kind: 'done', ok: true });
    expect(x.calls[0]!.stream!.equals(tar)).toBe(true);
    await vi.waitFor(() => expect(x.uploads.size).toBe(0));
  });
  it('publish_static whose stored archive changed is refused', async () => {
    const tar = makeTar([{ path: 'index.html', data: Buffer.from('<p>x</p>') }]);
    const op = { op: 'publish_static', name: 'landing', category: 'apps', sha256: 'b'.repeat(64), size: tar.length } as const;
    const x = rig(resolveOk, { upload: tar });
    expect(await x.svc.apply(cardOf(op), 'u1')).toMatchObject({ kind: 'refused' });
  });
  it('a result nobody reports within the deadline becomes a "no result" message, not silence', async () => {
    const x = rig((o) => (o.op === 'add' ? ok({ queued: 'J-0123456789abcdef' }) : ok({ state: 'pending' })));
    await x.svc.apply(cardOf(stored), 'u1');
    await vi.waitFor(() => expect(x.pushed).toHaveLength(1), { timeout: 3000 });
    expect(x.pushed[0]!.payload.text).toContain('no result');
    expect(x.jobs.get('J-0123456789abcdef')).toBe('lost');
  });
  it('V21: build-log text from the VPS is redacted again, defanged and capped', async () => {
    const x = rig((o) => (o.op === 'add' ? ok({ queued: 'J-0123456789abcdef' }) : ok({ ok: false, msg: 'deploy failed: @everyone token=abcdefghijklmnop ghp_abcdefghijklmnopqrstuvwxyz0123456789 ' + 'x'.repeat(3000), data: {} })));
    await x.svc.apply(cardOf(stored), 'u1');
    await vi.waitFor(() => expect(x.pushed).toHaveLength(1));
    const t = x.pushed[0]!.payload.text as string;
    expect(t).not.toContain('ghp_abc');
    expect(t).not.toContain('@everyone');
    expect(t.length).toBeLessThan(1700);
  });
  it('resume() polls jobs that were queued before a restart', async () => {
    const x = rig((o) => (o.op === 'result' ? ok({ ok: true, msg: 'ok', data: {} }) : ok({})));
    x.jobs.set('J-aaaaaaaaaaaaaaaa', 'queued');
    expect(await x.svc.resume()).toBe(1);
    await vi.waitFor(() => expect(x.pushed).toHaveLength(1));
  });
});

describe('read (V21)', () => {
  it('returns redacted, capped text', async () => {
    const x = rig(() => ok({ ok: true, msg: 'ok', data: { text: 'line password=hunter2hunter2 ghp_abcdefghijklmnopqrstuvwxyz0123456789 ' + 'y'.repeat(30000) } }));
    const r = await x.svc.read('u1', { kind: 'logs', app: 'apps/blog' });
    expect(r.ok && r.text.length).toBeLessThanOrEqual(16 * 1024 + 20);
    expect(r.ok && r.text).not.toContain('ghp_abc');
  });
  it('refuses a bad request and a VPS refusal', async () => {
    const x = rig(() => ok({ ok: false, msg: 'not an assistant-owned app', data: {} }));
    expect(await x.svc.read('u1', { kind: 'logs' })).toMatchObject({ ok: false });
    expect(await x.svc.read('u1', { kind: 'logs', app: 'apps/aurora' })).toMatchObject({ ok: false, error: expect.stringContaining('assistant-owned') });
  });
  it('safeText defangs mentions', () => expect(safeText('@here hi')).toBe('@​here hi'));
});
