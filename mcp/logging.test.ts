import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { McpHost } from './host.js';
import { FakeMcpDocker, fixtureSpawner, pinned } from './test-helpers.js';
import { StuckLatch } from './sandbox.js';
import { Slots } from './slots.js';
import { buildSnapshot } from './snapshot.js';
import { createMcpToolFactory, type McpToolDeps } from './tool.js';
import type { McpRow } from '../db/repos/mcp.js';
import type { ToolContext, ToolPlugin } from '../tools/types.js';

/**
 * MCP-AC25 and MC-C18 (R6 BE3): no logger call under mcp/ passes server text, stderr or a zod error. Two halves: a scan of every call site (balanced parentheses, so a multi-line call is
 * read whole) and a run of the hostile fixture scenarios with a capturing logger.
 */
const dir = dirname(fileURLToPath(import.meta.url));
const SOURCES = readdirSync(dir).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && f !== 'test-helpers.ts' && f !== 'spawner-fixture.ts');
const CALL = /\b(?:log|logger|console)\w*\s*\.\s*(?:error|warn|info|debug|log|trace)\s*\(/g;

function callsOf(src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(CALL)) {
    let depth = 1;
    let i = m.index! + m[0].length;
    const start = i;
    let q: string | null = null;
    for (; i < src.length && depth > 0; i++) {
      const ch = src[i]!;
      if (q) { if (ch === '\\') i++; else if (ch === q) q = null; continue; }
      if (ch === "'" || ch === '"' || ch === '`') q = ch;
      else if (ch === '(') depth++;
      else if (ch === ')') depth--;
    }
    out.push(src.slice(start, i - 1));
  }
  return out;
}

describe('MCP-AC25 (static): every logger call in mcp/', () => {
  const all = SOURCES.flatMap((f) => callsOf(readFileSync(join(dir, f), 'utf8')).map((c) => ({ f, c })));
  it('the scan finds the known call sites (a broken regex would pass vacuously)', () => {
    expect(all.length).toBeGreaterThanOrEqual(8);
  });
  it('takes an object of errName (the error class name only), code or slug, then one fixed string with no interpolation', () => {
    for (const { f, c } of all) {
      const m = /^\s*\{([^{}]*)\}\s*,\s*'([^'$`\\]*)'\s*$/.exec(c);
      expect(m, `${f}: ${c}`).not.toBeNull();
      const pairs = m![1]!.split(',').map((p) => p.trim()).filter(Boolean);
      for (const p of pairs) expect(p, `${f}: ${c}`).toMatch(/^(?:errName: errName\(\w+\)|code|slug)$/);
    }
  });
  it('never names a message, stack, stderr, stdout, text, issues (zod) or a raw error member in a call', () => {
    for (const { f, c } of all) expect(c, f).not.toMatch(/\.message|\.stack|\bstderr\b|\bstdout\b|\.text\b|\.issues\b|ZodError|\.format\(|\berr\b\s*[,}]|\berror\s*:|\bresult\b|\braw\b|\bline\b/);
  });
  it('mcp/ never writes to console or the process streams outside a logger call', () => {
    for (const f of SOURCES) expect(readFileSync(join(dir, f), 'utf8'), f).not.toMatch(/\bconsole\.|process\.(?:stdout|stderr)\.write/);
  });
  it('errName is a function that returns only the class name', () => {
    for (const f of SOURCES) {
      const src = readFileSync(join(dir, f), 'utf8');
      for (const m of src.matchAll(/const errName = ([^\n]+)/g)) expect(m[1], f).toBe("(e: unknown): string => (e instanceof Error ? e.name : 'unknown');");
    }
  });
});

describe('MCP-AC25 (run): hostile server text, stderr and a zod error never reach the logger', () => {
  const RAW = [{ name: 'echo', description: 'd', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }];
  const IMG = `sha256:${'c'.repeat(64)}`;
  const row = (): McpRow => {
    const b = buildSnapshot(RAW, { slug: 'srv', toolClass: 'write' });
    return pinned({ id: 7, slug: 'srv', title: 't', imageId: IMG, imageRef: null, command: [], env: {}, toolClass: 'write', timeoutMs: 5000, maxCallsPerDay: 50, snapshot: b.raw, snapshotSha256: b.sha256, status: 'active', source: 'admin', releaseId: null, addedBy: '9', addedAt: new Date(), approvedBy: '9', approvedAt: new Date(), quarantineReason: null, quarantinedAt: null, disabledBy: null, disabledAt: null, updatedAt: new Date(), depts: ['software'] } as never);
  };
  const SCENARIOS = ['rpcerror', 'toolerror', 'nonjson', 'batch', 'bigline', 'wrongid', 'dupresp', 'exitcall', 'deep', 'requests'] as const;
  it.each(SCENARIOS)('scenario %s: the logged objects hold no text from the server', async (scenario) => {
    const logs: unknown[] = [];
    const sp = fixtureSpawner({ MCP_SCENARIO: scenario, MCP_TOOLS: 'base' });
    const d: McpToolDeps = {
      host: undefined as never,
      repo: { get: async () => row(), claim: async () => 'ok', quarantine: async () => ({ ok: true, expired: [] }) },
      sandbox: { docker: new FakeMcpDocker(), spawn: sp, isHalted: () => false, latch: new StuckLatch(), newSuffix: () => 'abcdef01', haltPollMs: 15, clientGraceMs: 40, hardTimeoutMs: 3000 },
      slots: new Slots({ waitMs: 200 }), enabled: () => true, halted: () => false, tz: () => 'Asia/Bangkok', caps: () => ({ tree: 40, day: 200 }),
      audit: async () => undefined, secrets: () => [], notify: async () => undefined, log: { error: (x: unknown) => logs.push(x) },
    };
    const host = new McpHost({ repo: { activeRows: async () => [row()] }, makeTool: (s, t) => createMcpToolFactory(d)(s, t), secrets: () => [], incident: () => undefined, log: { error: (x: unknown) => logs.push(x) } });
    d.host = host;
    await host.load();
    const p = host.get('mcp_w_srv_echo') as ToolPlugin<{ text: string }>;
    const ctx = { actor: { kind: 'head', dept: 'software' }, task: { id: 't', rootId: '00000000-0000-4000-8000-000000000001' }, direct: false, tainted: () => false } as unknown as ToolContext;
    await p.run({ text: 'x' }, ctx).catch(() => undefined);
    const s = JSON.stringify(logs);
    for (const bad of ['server text', 'LEAKY', 'not json', 'no such method', 'xxxxxxxx', 'jsonrpc', 'ZodError', 'invalid_type']) expect(s).not.toContain(bad);
    for (const l of logs) for (const k of Object.keys(l as object)) expect(['errName', 'code', 'slug']).toContain(k);
  });
  it('a zod rejection (a tool input the schema refuses) is not logged either', async () => {
    const { z } = await import('zod');
    const r = z.strictObject({ text: z.string() }).safeParse({ text: 5, extra: 'sk-ant-api03-ZODLEAK' });
    expect(r.success).toBe(false);
    const all = SOURCES.flatMap((f) => callsOf(readFileSync(join(dir, f), 'utf8')));
    for (const c of all) expect(c).not.toMatch(/safeParse|\.error\b|issues/);
  });
});
