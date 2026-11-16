import { readFileSync, readdirSync, mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { McpRow } from '../db/repos/mcp.js';
import type { ToolContext, ToolPlugin } from '../tools/types.js';
import { MCP_TEXT } from './errors.js';
import { McpHost } from './host.js';
import { StuckLatch } from './sandbox.js';
import { Slots } from './slots.js';
import { buildSnapshot } from './snapshot.js';
import { FakeMcpDocker, fixtureSpawner, pinned } from './test-helpers.js';
import { CONFIG_NOTICE } from './quarantine.js';
import { QUARANTINE_NOTICE, createMcpToolFactory, screenInput, type McpToolDeps } from './tool.js';

const IMG = `sha256:${'c'.repeat(64)}`;
const RAW = [
  { name: 'echo', description: 'Echoes the text back.', inputSchema: { type: 'object', properties: { text: { type: 'string', maxLength: 100, description: 'what to echo' } }, required: ['text'] }, annotations: { readOnlyHint: true } },
  { name: 'add.numbers', description: 'Adds two numbers.', inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'] } },
];
const mkRow = (cls: 'read' | 'write' = 'write', o: Partial<McpRow> = {}): McpRow => {
  const b = buildSnapshot(RAW, { slug: 'srv', toolClass: cls });
  return pinned({ id: 7, slug: 'srv', title: 't', imageId: IMG, imageRef: null, command: [], env: {}, toolClass: cls, timeoutMs: 5000, maxCallsPerDay: 50, snapshot: b.raw, snapshotSha256: b.sha256, status: 'active', source: 'admin', releaseId: null, addedBy: '900000000000000001', addedAt: new Date(), approvedBy: '900000000000000001', approvedAt: new Date(), quarantineReason: null, quarantinedAt: null, disabledBy: null, disabledAt: null, updatedAt: new Date(), depts: ['software'], ...o });
};

type Claim = Parameters<McpToolDeps['repo']['claim']>[0];
async function setup(o: { cls?: 'read' | 'write'; env?: Record<string, string>; rows?: () => McpRow[]; claim?: (a: Claim) => Promise<'ok' | 'tree' | 'day' | 'server'>; enabled?: () => unknown; halted?: () => boolean; tz?: () => string; waitMs?: number; secrets?: string[]; quarantineOk?: boolean; now?: () => Date } = {}) {
  let rows = o.rows ?? (() => [mkRow(o.cls ?? 'write')]);
  const claims: Claim[] = [];
  const audits: { actor: string; action: string; tool?: string | null; outcome?: string | null; taskId?: string | null }[] = [];
  const logs: unknown[] = [];
  const notices: string[] = [];
  const quarantines: { id: number; slug: string; snapshotSha256: string }[] = [];
  const docker = new FakeMcpDocker();
  const sp = fixtureSpawner(o.env ?? {});
  const slots = new Slots({ waitMs: o.waitMs ?? 200 });
  const d: McpToolDeps = {
    host: undefined as never,
    repo: { get: async (slug) => rows().find((r) => r.slug === slug) ?? null, claim: async (a) => { claims.push(a); return o.claim ? o.claim(a) : 'ok'; }, quarantine: async (a) => { quarantines.push(a); return o.quarantineOk === false ? { ok: false } : { ok: true, expired: [] }; } },
    sandbox: { docker, spawn: sp, isHalted: () => false, latch: new StuckLatch(), newSuffix: () => 'abcdef01', haltPollMs: 15, clientGraceMs: 40, hardTimeoutMs: 5000 },
    slots, enabled: o.enabled ?? (() => true), halted: o.halted ?? (() => false), tz: o.tz ?? (() => 'Asia/Bangkok'), caps: () => ({ tree: 40, day: 200 }),
    audit: async (e) => void audits.push(e), secrets: () => o.secrets ?? [], notify: async (t) => void notices.push(t), log: { error: (x: unknown) => logs.push(x) }, ...(o.now ? { now: o.now } : {}),
  };
  const host = new McpHost({ repo: { activeRows: async () => rows() }, makeTool: (s, t) => createMcpToolFactory(d)(s, t), secrets: () => [], incident: () => undefined, log: { error: () => undefined } });
  d.host = host;
  await host.load();
  const ctx = (over: Partial<ToolContext> = {}): ToolContext => ({ actor: { kind: 'head', dept: 'software' }, task: { id: 'task-1', rootId: '00000000-0000-4000-8000-000000000001' }, direct: false, tainted: () => false, ...over } as never);
  return { d, host, docker, sp, claims, audits, logs, notices, quarantines, ctx, setRows: (r: () => McpRow[]) => { rows = r; }, plugin: (n = 'mcp_w_srv_echo') => host.get(n) as ToolPlugin<{ text: string }> };
}
const stdinMethods = (sp: ReturnType<typeof fixtureSpawner>) => sp.log.stdin.map((l) => (JSON.parse(l) as { method?: string }).method);

describe('MCP-AC15: approval (spec 3.4)', () => {
  it('a read tool never needs approval; a write tool always does, with a fixed reason, in a direct untainted chat too', async () => {
    const r = await setup({ cls: 'read' });
    expect(r.plugin('mcp_r_srv_echo').requiresApproval({ text: 'x' }, r.ctx())).toBe(false);
    expect(r.plugin('mcp_r_srv_echo').requiresApproval({ text: 'x' }, r.ctx({ direct: true }))).toBe(false);
    const w = await setup({ cls: 'write' });
    for (const direct of [false, true]) expect(w.plugin().requiresApproval({ text: 'x' }, w.ctx({ direct }))).toEqual({ reason: 'external tool mcp_w_srv_echo (MCP server srv, write class)' });
    expect(w.plugin()).toMatchObject({ kind: 'write', untrustedOutput: true, untrustedSource: 'mcp' });
    expect(r.plugin('mcp_r_srv_echo')).toMatchObject({ kind: 'read', untrustedOutput: true, untrustedSource: 'mcp' });
  });
});

describe('MCP-AC14: precheck is non-mutating and refuses with fixed text (spec 3.4)', () => {
  it('off (false, undefined, anything but exactly true, a throwing read) is E_OFF; halted is E_HALTED', async () => {
    for (const en of [() => false, () => undefined, () => 'true', () => 1, () => { throw new Error('read'); }]) {
      const s = await setup({ enabled: en });
      expect(await s.plugin().precheck!({ text: 'x' }, s.ctx())).toEqual({ refuse: MCP_TEXT.E_OFF });
    }
    const h = await setup({ halted: () => true });
    expect(await h.plugin().precheck!({ text: 'x' }, h.ctx())).toEqual({ refuse: MCP_TEXT.E_HALTED });
    expect(h.claims).toEqual([]);
    expect(h.sp.log.spawned).toBe(0);
  });
  it('a name the host no longer holds, or holds with another hash, is E_GONE', async () => {
    const s = await setup();
    const p = s.plugin();
    s.setRows(() => []);
    await s.host.refresh();
    expect(await p.precheck!({ text: 'x' }, s.ctx())).toEqual({ refuse: MCP_TEXT.E_GONE });
    const t = await setup();
    const q = t.plugin();
    t.setRows(() => [mkRow('write', { snapshot: [...mkRow().snapshot, { name: 'extra', inputSchema: { type: 'object' } }] as never, snapshotSha256: 'f'.repeat(64) })]);
    // an edited row that no longer hashes is not loaded at all
    await t.host.refresh();
    expect(await q.precheck!({ text: 'x' }, t.ctx())).toEqual({ refuse: MCP_TEXT.E_GONE });
  });
  it('the input screen refuses a secret-like string, hidden characters (INVISIBLE and HIDDEN, raw), and canonical input over 8000 characters; a clean input passes', async () => {
    const s = await setup();
    const p = s.plugin();
    const bad = ['key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123', 'a​b', '﻿x', 'a b', 'tag\u{E0041}', 'vs️', 'api_key=abcdefgh', 'Bearer abcdefghijklmnopqrstuvwxyz0123', 'x‮y'];
    for (const t of bad) expect(await p.precheck!({ text: t }, s.ctx()), JSON.stringify(t)).toEqual({ refuse: MCP_TEXT.E_INPUT });
    expect(await s.plugin('mcp_w_srv_add_numbers').precheck!({ a: 1, b: 2 } as never, s.ctx())).toBeNull();
    expect(await p.precheck!({ text: 'hello world' }, s.ctx())).toBeNull();
    expect(s.claims).toEqual([]);
    expect(s.sp.log.spawned).toBe(0);
    expect(s.audits).toEqual([]);
    const lit = await setup({ secrets: ['literal-secret-9'] });
    expect(await lit.plugin().precheck!({ text: 'has literal-secret-9 inside' }, lit.ctx())).toEqual({ refuse: MCP_TEXT.E_INPUT });
  });
  it('screenInput: a nested string, the 8000-character canonical cap and an unserialisable value', () => {
    expect(screenInput({ a: { b: ['ok', 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123'] } }, [])).toBe(false);
    expect(screenInput({ a: 'x'.repeat(7900) }, [])).toBe(true);
    expect(screenInput({ a: 'x'.repeat(7992) }, [])).toBe(true); // {"a":"..."} is exactly 8000 characters
    expect(screenInput({ a: 'x'.repeat(7993) }, [])).toBe(false); // 8001: refused
    expect(screenInput({ n: 1, b: true, z: null }, [])).toBe(true);
    const cyc: Record<string, unknown> = {};
    cyc['self'] = cyc;
    expect(screenInput(cyc, [])).toBe(false);
  });
});

describe('MCP-AC12 / MC-C13: the run path', () => {
  it('happy path: claim first (tree key = the task root), then the container, tools/list before tools/call, the text back, an end row', async () => {
    const s = await setup({ now: () => new Date('2026-11-12T20:30:00Z') });
    const input = { text: 'hi' };
    expect(await s.plugin().precheck!(input, s.ctx())).toBeNull();
    const res = await s.plugin().run(input, s.ctx());
    expect(res).toEqual({ content: 'echo:hi' });
    expect(s.claims).toEqual([{ treeKey: '00000000-0000-4000-8000-000000000001', dayKey: '2026-11-13', slug: 'srv', treeCap: 40, dayCap: 200, serverCap: 50, actor: 'head:software', tool: 'mcp_w_srv_echo', taskId: 'task-1' }]);
    expect(stdinMethods(s.sp)).toEqual(['initialize', 'notifications/initialized', 'tools/list', 'tools/call']);
    expect(s.audits).toEqual([{ actor: 'head:software', action: 'mcp.call.end', tool: 'mcp_w_srv_echo', taskId: 'task-1', outcome: 'ok' }]);
    expect(JSON.parse(s.sp.log.stdin[3]!)).toMatchObject({ params: { name: 'echo', arguments: { text: 'hi' } } });
  });
  it('the original tool name from the snapshot is what is called (add.numbers)', async () => {
    const s = await setup();
    const res = await s.plugin('mcp_w_srv_add_numbers').run({ a: 2, b: 3 } as never, s.ctx());
    expect(res.content).toBe('5');
    expect(JSON.parse(s.sp.log.stdin[3]!)).toMatchObject({ params: { name: 'add.numbers' } });
  });
  it('no task: the tree scope is skipped (treeKey null, taskId null)', async () => {
    const s = await setup();
    await s.plugin().run({ text: 'x' }, s.ctx({ task: null }));
    expect(s.claims[0]).toMatchObject({ treeKey: null, taskId: null });
  });
  it('a cap means no container and no end row, with the fixed text for the scope', async () => {
    for (const [r, code] of [['tree', 'E_CAP_TREE'], ['day', 'E_CAP_DAY'], ['server', 'E_CAP_SERVER']] as const) {
      const s = await setup({ claim: async () => r });
      expect(await s.plugin().run({ text: 'x' }, s.ctx())).toEqual({ content: MCP_TEXT[code], isError: true });
      expect(s.sp.log.spawned).toBe(0);
      expect(s.audits).toEqual([]);
    }
  });
  it('an unreadable or invalid schedule.timezone is E_CAP_DAY with no claim and no container', async () => {
    for (const tz of [() => 'Not/AZone', () => '', () => { throw new Error('read'); }]) {
      const s = await setup({ tz });
      expect(await s.plugin().run({ text: 'x' }, s.ctx())).toEqual({ content: MCP_TEXT.E_CAP_DAY, isError: true });
      expect(s.claims).toEqual([]);
      expect(s.sp.log.spawned).toBe(0);
    }
  });
  it('a claim that throws is E_INTERNAL with nothing run; only the error name is logged', async () => {
    const s = await setup({ claim: async () => { throw Object.assign(new Error('db: password=hunter2'), { name: 'PgError' }); } });
    expect(await s.plugin().run({ text: 'x' }, s.ctx())).toEqual({ content: MCP_TEXT.E_INTERNAL, isError: true });
    expect(s.sp.log.spawned).toBe(0);
    expect(JSON.stringify(s.logs)).not.toContain('hunter2');
    expect(JSON.stringify(s.logs)).toContain('PgError');
  });
  it('busy: a full slot gives E_BUSY after the wait with nothing claimed; the slot is released afterwards and never refunded counters', async () => {
    const s = await setup({ waitMs: 30 });
    const held = await s.d.slots.acquire('srv');
    expect(await s.plugin().run({ text: 'x' }, s.ctx())).toEqual({ content: MCP_TEXT.E_BUSY, isError: true });
    expect(s.claims).toEqual([]);
    held.release();
    expect((await s.plugin().run({ text: 'x' }, s.ctx())).content).toBe('echo:x');
    expect(s.d.slots.state()).toEqual({ running: 0, waiting: 0 });
  });
  it('the slot is released in finally when the run fails', async () => {
    const s = await setup({ env: { MCP_SCENARIO: 'exitcall' } });
    expect((await s.plugin().run({ text: 'x' }, s.ctx())).content).toBe(MCP_TEXT.E_EXIT);
    expect(s.d.slots.state()).toEqual({ running: 0, waiting: 0 });
    expect(s.claims).toHaveLength(1); // spent, never refunded
  });
  it('failures map to fixed texts and end rows: E_EXIT and E_PROTOCOL; none echoes server text', async () => {
    for (const [env, code] of [[{ MCP_SCENARIO: 'exitcall' }, 'E_EXIT'], [{ MCP_SCENARIO: 'rpcerror' }, 'E_PROTOCOL'], [{ MCP_SCENARIO: 'wrongid' }, 'E_PROTOCOL']] as const) {
      const s = await setup({ env });
      const res = await s.plugin().run({ text: 'x' }, s.ctx());
      expect(s.audits.at(-1)!.outcome).toBe(code);
      expect(res).toEqual({ content: MCP_TEXT[code], isError: true });
      expect(JSON.stringify(res)).not.toContain('server text');
    }
  });
  it('a hung call is E_TIMEOUT at the server timeout (the end row says so)', async () => {
    const s = await setup({ env: { MCP_SCENARIO: 'hang' }, rows: () => [mkRow('write', { timeoutMs: 5000 })] });
    s.d.sandbox.hardTimeoutMs = 150;
    const res = await s.plugin().run({ text: 'x' }, s.ctx());
    expect(res).toEqual({ content: MCP_TEXT.E_TIMEOUT, isError: true });
    expect(s.audits.at(-1)!.outcome).toBe('E_TIMEOUT');
  });
  it('a halt during the call ends it with the end row `halted`', async () => {
    let halted = false;
    const s = await setup({ env: { MCP_SCENARIO: 'hang' } });
    s.d.sandbox.isHalted = () => halted;
    setTimeout(() => { halted = true; }, 80);
    const res = await s.plugin().run({ text: 'x' }, s.ctx());
    expect(res.isError).toBe(true);
    expect(s.audits.at(-1)!.outcome).toBe('halted');
  });
  it('an isError result is a ToolResult with isError, redacted, with the end row tool_error', async () => {
    const s = await setup({ env: { MCP_SCENARIO: 'toolerror' } });
    const res = await s.plugin().run({ text: 'x' }, s.ctx());
    expect(res.isError).toBe(true);
    expect(res.content).toBe('it failed: [REDACTED]');
    expect(s.audits.at(-1)!.outcome).toBe('tool_error');
  });
  it('the result is processed: hidden characters stripped, non-text items marked, the text cut at 8000', async () => {
    const a = await setup({ env: { MCP_SCENARIO: 'content' } });
    expect((await a.plugin().run({ text: 'x' }, a.ctx())).content).toBe('one\n[image content omitted]\n[resource content omitted]\n[other content omitted]');
    const b = await setup({ env: { MCP_SCENARIO: 'hugetext' } });
    const t = (await b.plugin().run({ text: 'x' }, b.ctx())).content;
    expect(t.startsWith('y'.repeat(8000))).toBe(true);
    expect(t).toMatch(/\[cut: \d+ more characters\]$/);
  });
});

describe('MCP-AC08: a changed tool list quarantines and nothing is called', () => {
  it('on a hash mismatch no tools/call is written, the row is quarantined by compare-and-set, the host drops the tools, the notice is posted and E_CHANGED is returned', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcptee-'));
    const tee = join(dir, 'tee.log');
    const s = await setup({ env: { MCP_TOOLS: 'changed', MCP_TEE: tee } });
    const row = mkRow();
    const res = await s.plugin().run({ text: 'x' }, s.ctx());
    expect(res).toEqual({ content: MCP_TEXT.E_CHANGED, isError: true });
    expect(stdinMethods(s.sp)).toEqual(['initialize', 'notifications/initialized', 'tools/list']);
    expect(readFileSync(tee, 'utf8').trim().split('\n')).toEqual(['initialize', 'notifications/initialized', 'tools/list']);
    expect(s.quarantines).toEqual([{ id: 7, slug: 'srv', snapshotSha256: row.snapshotSha256 }]);
    s.setRows(() => []);
    expect(s.notices).toEqual([QUARANTINE_NOTICE('srv')]);
    expect(s.audits.at(-1)!.outcome).toBe('E_CHANGED');
    expect(existsSync(tee)).toBe(true);
  });
  it('the host refresh runs after the quarantine (the tools are gone when the call returns); a stale quarantine (no row changed) posts no notice but still returns E_CHANGED', async () => {
    let active = true;
    const s = await setup({ env: { MCP_TOOLS: 'changed' }, rows: () => (active ? [mkRow()] : []) });
    s.d.repo.quarantine = async () => { active = false; return { ok: true, expired: [] }; };
    await s.plugin().run({ text: 'x' }, s.ctx());
    expect(s.host.get('mcp_w_srv_echo')).toBeUndefined();
    const t = await setup({ env: { MCP_TOOLS: 'changed' }, quarantineOk: false });
    expect((await t.plugin().run({ text: 'x' }, t.ctx())).content).toBe(MCP_TEXT.E_CHANGED);
    expect(t.notices).toEqual([]);
  });
  it('a live list that cannot be hashed (Infinity, a bad name) is a change as well', async () => {
    const s = await setup({ env: { MCP_TOOLS: 'bad' } });
    expect((await s.plugin().run({ text: 'x' }, s.ctx())).content).toBe(MCP_TEXT.E_CHANGED);
    expect(stdinMethods(s.sp)).not.toContain('tools/call');
  });
});

describe('MC-C8: the host entry captured at precheck is the object run uses', () => {
  it('after a refresh between precheck and run, run still uses the captured entry (its hash and its original names)', async () => {
    const s = await setup();
    const p = s.plugin();
    const input = { text: 'cap' };
    expect(await p.precheck!(input, s.ctx())).toBeNull();
    s.setRows(() => [mkRow('write', { snapshotSha256: 'e'.repeat(64) })]); // an edited row: not loaded after the refresh
    await s.host.refresh();
    expect(s.host.entry('mcp_w_srv_echo')).toBeUndefined();
    expect(await p.run(input, s.ctx())).toEqual({ content: MCP_TEXT.E_STALE, isError: true }); // G2-MCP-R3: the captured entry is still the one run holds, and it no longer matches the row: refused, nothing claimed
    const other = { text: 'nocapture' };
    expect(await p.run(other, s.ctx())).toEqual({ content: MCP_TEXT.E_GONE, isError: true }); // no capture and no host entry: E_GONE
    expect(s.claims).toHaveLength(0);
  });
});

describe('MCP-AC25 / MC-C18: logging and writes', () => {
  const src = (f: string) => readFileSync(new URL(`./${f}`, import.meta.url), 'utf8');
  const files = readdirSync(new URL('./', import.meta.url)).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && f !== 'test-helpers.ts');
  it('no logger call in mcp/ carries server text, stderr, a zod error or a raw error object: only { errName } and fixed strings', () => {
    let calls = 0;
    for (const f of files) {
      for (const m of src(f).matchAll(/\blog\??\.(?:error|warn|info|debug)\(([^;]*)\)/g)) {
        calls++;
        const a = m[1]!;
        expect(a, `${f}: ${a}`).not.toMatch(/\bmessage\b|stderr|stdout|\.text\b|issues|prettifyError|\bdescription\b|\.content\b|\berr\s*[,}]|\{\s*err\b|\bsnapshot\b|\binput\b|\bresult\b/);
        expect(a, `${f}: ${a}`).toMatch(/errName\(|^'[^']*'$|^\{[^}]*(?:code|slug|stage)[^}]*\}(?:, '[^']*')?$/);
      }
    }
    expect(calls).toBeGreaterThan(3);
  });
  it('nothing under mcp/ writes memory, KB, lessons, skills, tasks or workspace files, imports providers/, or touches the filesystem', () => {
    for (const f of files) {
      const s = src(f);
      expect(s, f).not.toMatch(/from '\.\.\/(providers|knowledge\/(?!screen)|skills|workspaces\/(?!runner)|agents|grow|company|executor)/);
      expect(s, f).not.toMatch(/node:fs|writeFile|appendFile/);
      for (const m of s.matchAll(/from '\.\.\/db\/([^']+)'/g)) expect(m[1], `${f}: only the MCP repo (and its types) may be imported from db/`).toBe('repos/mcp.js');
    }
  });
});

describe('047: the per-call check recomputes the config hash from the row and its grants', () => {
  const OTHER = `sha256:${'d'.repeat(64)}`;
  const tamper: [string, Partial<McpRow>][] = [
    ['image_id', { imageId: OTHER }],
    ['command', { command: ['--evil'] }],
    ['env', { env: { A: 'b' } }],
    ['tool_class', { toolClass: 'read' }],
    ['a grant row', { depts: ['software', 'hq'] }],
  ];
  const edited = (o: Partial<McpRow>): McpRow => ({ ...mkRow('write'), ...o }) as McpRow; // the pin stays the one of the approved config
  it.each(tamper)('precheck: %s edited after the load is refused E_CONFIG, quarantined (config_changed), the notice is posted, nothing is claimed or spawned', async (_n, over) => {
    const s = await setup();
    s.setRows(() => [edited(over)]);
    expect(await s.plugin().precheck!({ text: 'x' }, s.ctx())).toEqual({ refuse: MCP_TEXT.E_CONFIG });
    expect(s.quarantines).toEqual([{ id: 7, slug: 'srv', snapshotSha256: mkRow().snapshotSha256, reason: 'config_changed' }]);
    expect(s.notices).toEqual([CONFIG_NOTICE('srv')]);
    expect(s.claims).toEqual([]);
    expect(s.docker.execs).toEqual([]);
    expect(s.sp.log.stdin).toEqual([]);
    expect(s.host.names()).toEqual([]); // the refresh dropped the tools
  });
  it.each(tamper)('run (a write card approved hours ago): %s edited since is refused E_CONFIG before any slot, claim or container', async (_n, over) => {
    const s = await setup();
    const p = s.plugin();
    s.setRows(() => [edited(over)]);
    expect(await p.run({ text: 'x' }, s.ctx())).toEqual({ content: MCP_TEXT.E_CONFIG, isError: true });
    expect(s.quarantines.map((q) => (q as { reason?: string }).reason)).toEqual(['config_changed']);
    expect(s.claims).toEqual([]);
    expect(s.docker.execs).toEqual([]);
    expect(s.sp.log.stdin).toEqual([]);
    expect(s.audits.filter((a) => a.action.startsWith('mcp.call'))).toEqual([]);
  });
  it('an unedited row passes both checks; a row that is gone or not active is E_GONE (no quarantine); a read error is E_INTERNAL with only the error name logged', async () => {
    const s = await setup();
    expect(await s.plugin().precheck!({ text: 'x' }, s.ctx())).toBeNull();
    s.setRows(() => [mkRow('write', { status: 'quarantined' })]);
    expect(await s.plugin().precheck!({ text: 'y' }, s.ctx())).toEqual({ refuse: MCP_TEXT.E_GONE });
    expect(s.quarantines).toEqual([]);
    const t = await setup();
    const p = t.plugin();
    t.d.repo.get = async () => { throw new Error('db down: secret detail'); };
    expect(await p.precheck!({ text: 'x' }, t.ctx())).toEqual({ refuse: MCP_TEXT.E_INTERNAL });
    expect(JSON.stringify(t.logs)).not.toContain('secret detail');
  });
  it('a NULL pin on an active row (impossible under the CHECK, but never trusted) is quarantined and refused', async () => {
    const s = await setup();
    s.setRows(() => [edited({ approvedConfigSha256: null })]);
    expect(await s.plugin().precheck!({ text: 'x' }, s.ctx())).toEqual({ refuse: MCP_TEXT.E_CONFIG });
    expect(s.quarantines).toHaveLength(1);
  });
  it('a stale quarantine (the row already left active) posts no notice but still refuses E_CONFIG', async () => {
    const s = await setup({ quarantineOk: false });
    s.setRows(() => [edited({ command: ['x'] })]);
    expect(await s.plugin().precheck!({ text: 'x' }, s.ctx())).toEqual({ refuse: MCP_TEXT.E_CONFIG });
    expect(s.notices).toEqual([]);
  });
});

describe('G2-MCP-R3: run compares the config it holds in memory with the row it re-reads', () => {
  const OTHER = `sha256:${'d'.repeat(64)}`;
  // A consistent edit: the row AND its pin say the new config (a DB editor who also rewrote the pin), so the 047 pin check alone passes.
  const consistent: [string, Partial<McpRow>][] = [
    ['image_id', { imageId: OTHER }],
    ['command', { command: ['--evil'] }],
    ['env', { env: { A: 'b' } }],
    ['tool_class', { toolClass: 'read' }],
    ['grants', { depts: ['software', 'hq'] }],
    ['snapshot hash', { snapshotSha256: 'e'.repeat(64) }],
  ];
  const repinned = (o: Partial<McpRow>): McpRow => pinned({ ...mkRow('write'), ...o, approvedConfigSha256: undefined } as never);
  it.each(consistent)('run: %s differs from the loaded server although the pin matches the row: E_STALE before any slot, claim or container', async (_n, over) => {
    const s = await setup();
    const p = s.plugin();
    s.setRows(() => [repinned(over)]);
    expect(await p.run({ text: 'x' }, s.ctx())).toEqual({ content: MCP_TEXT.E_STALE, isError: true });
    expect(s.claims).toEqual([]);
    expect(s.docker.execs).toEqual([]);
    expect(s.sp.log.stdin).toEqual([]);
    expect(s.audits.filter((a) => a.action.startsWith('mcp.call'))).toEqual([]);
  });
  it('a legitimate edit (the pin follows) is refused without a quarantine: the next refresh picks the new config up', async () => {
    const s = await setup();
    s.setRows(() => [repinned({ depts: ['software', 'hq'] })]);
    expect(await s.plugin().precheck!({ text: 'x' }, s.ctx())).toEqual({ refuse: MCP_TEXT.E_STALE });
    expect(s.quarantines).toEqual([]);
    expect(s.notices).toEqual([]);
  });
});

describe('G2-MCP-R3 text: a legitimate change is not called a quarantine (R7 BE1 note)', () => {
  it('E_STALE says a Bot Admin changed the configuration and nothing was run; E_CONFIG keeps the quarantine wording', () => {
    expect(MCP_TEXT.E_STALE).toBe('The server configuration was changed by a Bot Admin since this was requested, so nothing was run. Ask again if it is still needed.');
    expect(MCP_TEXT.E_STALE).not.toMatch(/quarantine/i);
    expect(MCP_TEXT.E_CONFIG).toMatch(/quarantined/);
  });
});
