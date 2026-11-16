import { describe, expect, it } from 'vitest';
import { errorClass, hintFor, IncidentError, IncidentReporter, sanitizeText } from './incidents.js';

function mk(o: { fail?: boolean; max?: number } = {}) {
  let clock = 1_800_000_000_000;
  const posts: { channelId: string; title: string; body: string }[] = [];
  const logs: Record<string, unknown>[] = [];
  const timers: { fn: () => void; ms: number }[] = [];
  const r = new IncidentReporter({
    port: { post: async (_a, t, p) => { if (o.fail) throw new Error('boom'); posts.push({ channelId: t.channelId, title: p.title, body: p.body }); return 'm'; } },
    channelId: '999', log: { error: (x) => logs.push(x as Record<string, unknown>), warn: () => undefined },
    now: () => clock, ...(o.max ? { maxPerWindow: o.max } : {}),
    timer: (fn, ms) => { timers.push({ fn, ms }); },
  });
  return { r, posts, logs, timers, advance: (ms: number) => (clock += ms) };
}
const base = { source: 'provider claude-code-local', stage: 'llm.call', dept: 'software', taskId: '1a2b3c4d-5e6f', taskTitle: 'Write the report' };

describe('sanitizeText', () => {
  it('masks token-like strings and env values', () => {
    const t = 'failed with ghp_abcdefghijklmnopqrstuvwxyz0123 and Bearer abcdefghijklmnop1234 and API_KEY=hunter2hunter2 token: s3cr3tvalue sk-ant-abcdefgh12345678 ' + 'a1'.repeat(20);
    const s = sanitizeText(t);
    for (const bad of ['ghp_abc', 'abcdefghijklmnop1234', 'hunter2', 's3cr3tvalue', 'sk-ant-abc', 'a1a1a1a1a1a1']) expect(s).not.toContain(bad);
    expect(s).toContain('[REDACTED]');
  });
  it('masks the literal secrets it is given', () => {
    expect(sanitizeText('boom swordfish-1234 end', 300, ['swordfish-1234'])).not.toContain('swordfish');
  });
  it('shortens home paths', () => {
    const s = sanitizeText('ENOENT /Users/pakawat.tan/Desktop/x/y.ts and /home/bob/app and C:\\Users\\Al\\z');
    expect(s).not.toMatch(/pakawat|bob|Al\\/);
    expect(s).toContain('~/Desktop/x/y.ts');
  });
  it('neutralises mentions', () => {
    const s = sanitizeText('hi <@123456789012345678> <@&1234567890> @everyone @here @CTO <#12345678901>');
    expect(s).not.toMatch(/<@/);
    expect(s).not.toMatch(/@(everyone|here|CTO)/);
    expect(s).toContain('[mention]');
  });
  it('is one line and capped', () => {
    const s = sanitizeText(`a\nb\n${'x'.repeat(500)}`, 100);
    expect(s).not.toContain('\n');
    expect(s.length).toBeLessThanOrEqual(100);
  });
  it('keeps ordinary words that follow "token"', () => {
    expect(sanitizeText('token not set')).toBe('token not set');
  });
  it('G2BL-01: bounds work on huge input and never shows a half-cut secret', () => {
    const t0 = Date.now();
    const s = sanitizeText('a'.repeat(200_000));
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(s.length).toBeLessThanOrEqual(300);
    const secret = 'zq-literal-secret-value-0123456789';
    const pad = ' '.repeat(4096 - 10); // whitespace collapses, so the cut point would land inside the secret
    const out = sanitizeText(`err${pad}${secret} tail`, 300, [secret]);
    expect(out).not.toContain('zq-lit');
  });
  it('G2BL-02: breaks masked links and is idempotent', () => {
    const s = sanitizeText('[Re-auth the bot](https://evil.example/x)');
    expect(s).not.toContain('](');
    expect(sanitizeText(s)).toBe(s);
  });
});

describe('hints and class', () => {
  it('maps known faults', () => {
    expect(hintFor({ source: 'discord', stage: 'post', channelId: '123' }, Object.assign(new Error('Missing Permissions'), { code: 50013 }))).toMatch(/Send Messages.*channel 123/);
    expect(hintFor({ source: 'provider x', stage: 'resolve' }, new Error('provider not registered'))).toContain('probe-local-cli.sh');
    expect(hintFor({ source: 'tool', stage: 'render' }, Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:9222'), { code: 'ECONNREFUSED' }))).toContain('npm run local:render');
    expect(hintFor({ source: 'scheduler', stage: 'task run' }, Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), { code: 'ECONNREFUSED' }))).toContain('npm run local:db');
    expect(hintFor({ source: 'provider openai', stage: 'llm.call' }, Object.assign(new Error('x'), { status: 401 }))).toMatch(/credentials/);
    expect(hintFor({ source: 'x', stage: 'run' }, Object.assign(new Error('x'), { name: 'AbortError' }))).toMatch(/timeout/);
    expect(hintFor({ source: 'x', stage: 'run' }, new Error('plain'))).toBeUndefined();
  });
  it('class never includes message text', () => {
    expect(errorClass(Object.assign(new Error('secret message'), { code: 'EPIPE' }))).toBe('Error EPIPE');
    expect(errorClass(Object.assign(new Error('m'), { name: 'ProviderError', status: 529 }))).toBe('ProviderError status=529');
  });
});

describe('IncidentReporter', () => {
  it('posts one sanitised message with dept, task, where, cause, hint and incident id; logs the same id', async () => {
    const t = mk();
    const err = Object.assign(new Error('CLI exited 1 in /Users/pakawat.tan/proj token=abcd1234efgh <@123456789012345678>'), { name: 'ProviderError', diag: 'exit=1 sk-ant-zzzzzzzzzz', status: 500 });
    const id = t.r.report({ ...base, err });
    await t.r.idle();
    expect(t.posts).toHaveLength(1);
    const p = t.posts[0]!;
    expect(p.channelId).toBe('999');
    expect(p.title).toBe(`Incident ${id}`);
    expect(p.body).toMatch(/when: \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \(Asia\/Bangkok\)/);
    expect(p.body).toContain('bot: software · task #1a2b3c4d "Write the report"');
    expect(p.body).toContain('where: provider claude-code-local · llm.call');
    expect(p.body).toContain('error: ProviderError status=500');
    expect(p.body).toContain('cause: CLI exited 1 in ~/proj');
    expect(p.body).toContain(`grep incident=${id}`);
    expect(p.body).toMatch(/fix: /);
    for (const bad of ['pakawat', 'abcd1234efgh', '<@', 'sk-ant']) expect(p.body).not.toContain(bad);
    expect(p.body.split('\n').length).toBeLessThanOrEqual(12);
    expect(t.logs[0]).toMatchObject({ incident: id, source: 'provider claude-code-local', stage: 'llm.call', dept: 'software' });
  });
  it('truncates the task title to 80', async () => {
    const t = mk();
    t.r.report({ ...base, taskTitle: 'T'.repeat(200), err: new Error('x') });
    await t.r.idle();
    expect(t.posts[0]!.body).toContain(`"${'T'.repeat(79)}…"`);
  });
  it('suppresses the same incident inside 10 min but still logs it, then says "repeated N times"', async () => {
    const t = mk();
    const err = new IncidentError('X', 'same');
    for (let i = 0; i < 4; i++) t.r.report({ ...base, err });
    await t.r.idle();
    expect(t.posts).toHaveLength(1);
    expect(t.logs).toHaveLength(4);
    t.advance(10 * 60_000 + 1);
    t.r.report({ ...base, err });
    await t.r.idle();
    expect(t.posts).toHaveLength(2);
    expect(t.posts[1]!.body).toContain('repeated 3 times');
  });
  it('does not suppress a different dept, stage or error class', async () => {
    const t = mk();
    t.r.report({ ...base, err: new Error('a') });
    t.r.report({ ...base, dept: 'cto', err: new Error('a') });
    t.r.report({ ...base, stage: 'other', err: new Error('a') });
    t.r.report({ ...base, err: new IncidentError('Z', 'a') });
    await t.r.idle();
    expect(t.posts).toHaveLength(4);
  });
  it('G2BL-01: logs a bounded copy of the error', () => {
    const t = mk();
    t.r.report({ source: 'tool', stage: 'run', toolName: 'x', err: new Error('a'.repeat(200_000)) });
    const err = t.logs[0]!.err as { message: string; stack: string };
    expect(err.message.length).toBeLessThanOrEqual(4096);
    expect(err.stack.length).toBeLessThanOrEqual(4096);
  });
  it('G2BL-03: does not suppress a different tool or channel', async () => {
    const t = mk();
    t.r.report({ source: 'tool', stage: 'run', toolName: 'a_tool', err: new Error('x') });
    t.r.report({ source: 'tool', stage: 'run', toolName: 'b_tool', err: new Error('x') });
    t.r.report({ source: 'discord', stage: 'post', channelId: '111', err: Object.assign(new Error('x'), { code: 50013 }) });
    t.r.report({ source: 'discord', stage: 'post', channelId: '222', err: Object.assign(new Error('x'), { code: 50013 }) });
    await t.r.idle();
    expect(t.posts).toHaveLength(4);
    expect(t.posts[1]!.body).toContain('b_tool');
  });
  it('posts a follow-up when the window closes (timer) and then reports fresh', async () => {
    const t = mk();
    t.r.report({ ...base, err: new Error('a') });
    t.r.report({ ...base, err: new Error('a') });
    t.r.report({ ...base, err: new Error('a') });
    expect(t.timers).toHaveLength(1);
    t.advance(10 * 60_000);
    t.timers[0]!.fn();
    await t.r.idle();
    expect(t.posts).toHaveLength(2);
    expect(t.posts[1]!.body).toContain('repeated 2 times');
    t.r.report({ ...base, err: new Error('a') });
    await t.r.idle();
    expect(t.posts).toHaveLength(3);
  });
  it('caps the window and sends one flood message', async () => {
    const t = mk({ max: 3 });
    for (let i = 0; i < 8; i++) t.r.report({ source: `s${i}`, stage: 'x', err: new Error('e') });
    await t.r.idle();
    expect(t.posts).toHaveLength(4);
    expect(t.posts[3]!.title).toBe('Incident flood');
    expect(t.logs).toHaveLength(8);
  });
  it('never throws when the post fails and does not recurse', async () => {
    const t = mk({ fail: true });
    expect(() => t.r.report({ ...base, err: new Error('a') })).not.toThrow();
    await t.r.idle();
    expect(t.logs).toHaveLength(1);
  });
  it('uses the hint of an IncidentError', async () => {
    const t = mk();
    t.r.report({ source: 'boot', stage: 'x', err: new IncidentError('c', 'why', 'do this') });
    await t.r.idle();
    expect(t.posts[0]!.body).toContain('fix: do this');
  });
  it('G2BL-04: a Postgres SQLSTATE error shows class and code only, never its message', async () => {
    const t = mk();
    t.r.report({ source: 'tool', stage: 'run', toolName: 'x', err: Object.assign(new Error('invalid input syntax for type uuid: "PRIVATE-ROW-TEXT"'), { code: '22P02' }) });
    t.r.report({ source: 'tool', stage: 'run2', err: Object.assign(new Error('write EPIPE detail'), { code: 'EPIPE' }) });
    await t.r.idle();
    expect(t.posts[0]!.body).toContain('SQLSTATE 22P02');
    expect(t.posts[0]!.body).not.toContain('PRIVATE-ROW-TEXT');
    expect(t.posts[1]!.body).toContain('write EPIPE detail'); // errno names are not SQLSTATEs
  });
  it('G2BL-07: only IncidentError with ping is posted as a governance alert; others and follow-ups are not', async () => {
    const origins: (string | undefined)[] = [];
    const r = new IncidentReporter({ port: { post: async (_a, _t, p) => { origins.push(p.origin); return 'm'; } }, channelId: '1', log: { error: () => undefined } });
    r.report({ source: 'boot', stage: 'a', err: new IncidentError('c', 'security', 'fix', undefined, true) });
    r.report({ source: 'boot', stage: 'b', err: new IncidentError('c', 'plain', 'fix') });
    r.report({ source: 'x', stage: 'c', err: new Error('e') });
    await r.idle();
    expect(origins).toEqual(['governance', undefined, undefined]);
  });
});
