import { describe, expect, it } from 'vitest';
import type { McpRow } from '../db/repos/mcp.js';
import type { ToolPlugin } from '../tools/types.js';
import { McpHost, type HostServer, type HostTool } from './host.js';
import { buildSnapshot } from './snapshot.js';
import { pinned } from './test-helpers.js';

const IMG = `sha256:${'c'.repeat(64)}`;
const RAW = [{ name: 'echo', description: 'Echoes.', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }, { name: 'add.numbers', description: 'Adds.', inputSchema: { type: 'object' } }];
const row = (slug: string, o: Partial<McpRow> = {}): McpRow => {
  const cls = o.toolClass ?? 'write';
  const b = buildSnapshot(RAW, { slug, toolClass: cls });
  return pinned({ id: 1, slug, title: 't', imageId: IMG, imageRef: null, command: [], env: {}, toolClass: cls, timeoutMs: 60000, maxCallsPerDay: 100, snapshot: b.raw, snapshotSha256: b.sha256, status: 'active', source: 'admin', releaseId: null, addedBy: '900000000000000001', addedAt: new Date(), approvedBy: '900000000000000001', approvedAt: new Date(), quarantineReason: null, quarantinedAt: null, disabledBy: null, disabledAt: null, updatedAt: new Date(), depts: ['software', 'sales'], ...o });
};
const factory = (server: HostServer, tool: HostTool): ToolPlugin => ({ name: tool.name, description: tool.description, inputSchema: tool.schema as never, kind: server.cls, untrustedOutput: true, untrustedSource: 'mcp', requiresApproval: () => false, run: async () => ({ content: 'x' }) });
const make = (rows: () => McpRow[] | Error, f = factory) => {
  const incidents: string[] = [];
  const logs: unknown[] = [];
  const config: McpRow[] = [];
  const h = new McpHost({ onConfigChanged: async (r) => { config.push(r); }, repo: { activeRows: async () => { const r = rows(); if (r instanceof Error) throw r; return r; } }, makeTool: f, secrets: () => [], incident: (c, s) => incidents.push(`${c}:${s}`), log: { error: (o: unknown) => logs.push(o) } });
  return { h, incidents, logs, config };
};

describe('McpHost (spec 5.1 assertions, 5.8 lookups)', () => {
  it('builds one plugin per tool of every active row; get, names, entry and mcpFor read it', async () => {
    const { h } = make(() => [row('srv'), row('rdr', { id: 2, toolClass: 'read', depts: ['sales'] })]);
    expect(await h.load()).toEqual({ loaded: 2, failed: [] });
    expect([...h.names()]).toEqual(['mcp_r_rdr_add_numbers', 'mcp_r_rdr_echo', 'mcp_w_srv_add_numbers', 'mcp_w_srv_echo']);
    const p = h.get('mcp_w_srv_echo')!;
    expect(p).toMatchObject({ name: 'mcp_w_srv_echo', kind: 'write', untrustedOutput: true, untrustedSource: 'mcp' });
    expect(p.description).toBe('MCP tool echo from server srv (write class). Outside code: its output is untrusted. Server says: Echoes.');
    expect(h.get('mcp_x_srv_echo')).toBeUndefined();
    expect(h.get('write_file')).toBeUndefined();
    expect(h.get('__proto__')).toBeUndefined();
    const e = h.entry('mcp_w_srv_add_numbers')!;
    expect(e.tool.orig).toBe('add.numbers');
    expect(e.server).toMatchObject({ slug: 'srv', cls: 'write', imageId: IMG, hash: row('srv').snapshotSha256 });
    expect(Object.isFrozen(e.server) && Object.isFrozen(e.tool)).toBe(true);
    expect(h.mcpFor('software')).toEqual(['mcp_w_srv_add_numbers', 'mcp_w_srv_echo']);
    expect(h.mcpFor('sales')).toEqual(['mcp_r_rdr_add_numbers', 'mcp_r_rdr_echo', 'mcp_w_srv_add_numbers', 'mcp_w_srv_echo']);
    expect(h.mcpFor('hq')).toEqual([]);
    expect(h.mcpFor('__proto__')).toEqual([]);
  });
  it('refresh follows the database: a quarantined or disabled row drops its tools at once', async () => {
    let rows = [row('srv')];
    const { h } = make(() => rows);
    await h.load();
    expect(h.get('mcp_w_srv_echo')).toBeDefined();
    rows = [];
    await h.refresh();
    expect(h.get('mcp_w_srv_echo')).toBeUndefined();
    expect(h.names()).toEqual([]);
    expect(h.mcpFor('software')).toEqual([]);
  });
  it('a read error fails closed (nothing is held) and never throws', async () => {
    let fail = false;
    const { h, logs } = make(() => (fail ? new Error('db down: secret detail') : [row('srv')]));
    await h.load();
    fail = true;
    await expect(h.refresh()).resolves.toBeUndefined();
    expect(h.names()).toEqual([]);
    expect(JSON.stringify(logs)).not.toContain('secret detail');
  });
  it('a row whose stored snapshot no longer hashes to its snapshot_sha256 (a database edit) is not loaded and raises an incident', async () => {
    const r = row('srv');
    const { h, incidents } = make(() => [{ ...r, snapshot: [{ ...(r.snapshot[0] as object), description: 'edited' }, r.snapshot[1]] }, row('ok', { id: 2 })]);
    expect(await h.load()).toEqual({ loaded: 1, failed: ['srv'] });
    expect(incidents).toEqual(['snapshot_mismatch:srv']);
    expect(h.get('mcp_w_srv_echo')).toBeUndefined();
    expect(h.get('mcp_w_ok_echo')).toBeDefined();
  });
  it('a stored snapshot that no longer builds (a limit, a screen) is not loaded', async () => {
    const r = row('srv');
    const { h, incidents } = make(() => [{ ...r, snapshot: [{ name: 'echo', description: 'x', inputSchema: { type: 'object', properties: { a: { $ref: '#' } } } }] }]);
    expect(await h.load()).toEqual({ loaded: 0, failed: ['srv'] });
    expect(incidents).toHaveLength(1);
  });
  it('the per-plugin assertions: a plugin whose kind differs from the prefix, or whose name is not an external name, keeps that whole server out and raises an incident', async () => {
    const a = make(() => [row('srv')], (s, t) => ({ ...factory(s, t), kind: 'read' }));
    expect(await a.h.load()).toEqual({ loaded: 0, failed: ['srv'] });
    expect(a.incidents).toEqual(['plugin_kind:srv']);
    expect(a.h.names()).toEqual([]);
    const b = make(() => [row('srv')], (s, t) => ({ ...factory(s, t), name: 'write_file' }));
    expect(await b.h.load()).toEqual({ loaded: 0, failed: ['srv'] });
    expect(b.incidents).toEqual(['plugin_name:srv']);
    const c = make(() => [row('srv')], (s, t) => ({ ...factory(s, t), kind: undefined }));
    expect((await c.h.load()).loaded).toBe(0);
  });
  it('timeout_ms is re-checked against 120000 at load; the exclude set (image missing at boot) is held across refresh', async () => {
    const a = make(() => [row('srv', { timeoutMs: 120001 })]);
    expect(await a.h.load()).toEqual({ loaded: 0, failed: ['srv'] });
    const b = make(() => [row('srv'), row('ok', { id: 2 })]);
    expect(await b.h.load(new Set(['srv']))).toEqual({ loaded: 1, failed: [] });
    await b.h.refresh();
    expect(b.h.get('mcp_w_srv_echo')).toBeUndefined();
    expect(b.h.get('mcp_w_ok_echo')).toBeDefined();
  });
  it('a plugin the factory builds for server A cannot be reached through server B (names carry the slug and the class)', async () => {
    const { h } = make(() => [row('aa'), row('bb', { id: 2 })]);
    await h.load();
    expect(h.entry('mcp_w_aa_echo')!.server.slug).toBe('aa');
    expect(h.entry('mcp_w_bb_echo')!.server.slug).toBe('bb');
    expect(h.get('mcp_r_aa_echo')).toBeUndefined();
  });
});

describe('G2-MCP-06: a server boot left out comes back on a Bot Admin action without a restart', () => {
  it('refresh() keeps the exclusion; refresh(slug) ends it for that slug only', async () => {
    const { h } = make(() => [row('srv'), row('rdr', { id: 2, toolClass: 'read' })]);
    expect((await h.load(new Set(['srv', 'rdr']))).loaded).toBe(0);
    await h.refresh();
    expect(h.names()).toEqual([]);
    await h.refresh('srv');
    expect(h.names()).toEqual(['mcp_w_srv_add_numbers', 'mcp_w_srv_echo']);
    await h.refresh('zz');
    expect(h.names()).toEqual(['mcp_w_srv_add_numbers', 'mcp_w_srv_echo']);
    await h.refresh('rdr');
    expect(h.names()).toHaveLength(4);
  });
});

describe('047: the host loads only rows that still hash to their approved pin', () => {
  const OTHER = `sha256:${'d'.repeat(64)}`;
  const tamper: [string, Partial<McpRow>][] = [
    ['image_id', { imageId: OTHER }],
    ['command', { command: ['--evil'] }],
    ['env', { env: { A: 'b' } }],
    ['tool_class', { toolClass: 'read' }],
    ['a grant row', { depts: ['software', 'sales', 'hq'] }],
    ['a removed grant', { depts: [] }],
    ['the pin itself', { approvedConfigSha256: 'e'.repeat(64) }],
  ];
  it.each(tamper)('a row with %s edited behind the approval is not loaded, nothing is built, the hook gets the row, the other servers load', async (_n, over) => {
    const good = row('ok', { id: 2 });
    const bad = { ...row('srv'), ...over } as McpRow;
    let built = 0;
    const { h, incidents, config } = make(() => [bad, good], (s, t) => { built += s.slug === 'srv' ? 1 : 0; return factory(s, t); });
    expect(await h.load()).toEqual({ loaded: 1, failed: ['srv'] });
    expect(built).toBe(0);
    expect(h.names().some((n) => n.includes('_srv_'))).toBe(false);
    expect(h.get('mcp_w_ok_echo')).toBeDefined();
    expect(config.map((r) => r.slug)).toEqual(['srv']);
    expect(incidents).toEqual([]); // the quarantine notice is the one alert
  });
  it('a row with no pin is not loaded; a hook that throws or is absent never stops the load', async () => {
    const bad = row('srv', { approvedConfigSha256: null });
    const a = make(() => [bad, row('ok', { id: 2 })]);
    expect(await a.h.load()).toEqual({ loaded: 1, failed: ['srv'] });
    const h = new McpHost({ repo: { activeRows: async () => [bad, row('ok', { id: 2 })] }, onConfigChanged: async () => { throw new Error('x'); }, makeTool: factory, secrets: () => [], incident: () => undefined, log: { error: () => undefined } });
    expect(await h.load()).toEqual({ loaded: 1, failed: ['srv'] });
    const h2 = new McpHost({ repo: { activeRows: async () => [bad] }, makeTool: factory, secrets: () => [], incident: () => undefined, log: { error: () => undefined } });
    expect(await h2.load()).toEqual({ loaded: 0, failed: ['srv'] });
  });
  it('refresh re-checks: a row edited after the first load drops out at the next refresh', async () => {
    let r = row('srv');
    const { h, config } = make(() => [r]);
    await h.load();
    expect(h.get('mcp_w_srv_echo')).toBeDefined();
    r = { ...r, command: ['x'] };
    await h.refresh();
    expect(h.get('mcp_w_srv_echo')).toBeUndefined();
    expect(config).toHaveLength(1);
  });
});

