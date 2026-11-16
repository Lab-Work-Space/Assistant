import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { FakeConfig } from '../governance/test-helpers.js';
import { createToolPolicy } from '../tools/policy.js';
import { ToolRegistry } from '../tools/registry.js';
import { mcpCommandDeps, mcpDigestDeps } from './admin.js';

/** R6 MCP-1 BE2 wiring (spec 6, MC-C14, MCP-AC17, MCP-AC19). Lives under mcp/ so devjob/paths.ts protects it. */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const app = readFileSync(join(ROOT, 'app.ts'), 'utf8');
const lines = app.split('\n');

describe('the closures hand out exactly what the spec names', () => {
  it('mcpCommandDeps exposes exactly list, show, add, approve, test, disable, depts: own properties only, plain prototype, never the admin itself', async () => {
    const sink = new Error('forwarded');
    const admin = { list: async () => ['l'], show: async () => 's', add: async () => 'a', approve: async () => 'p', test: async () => 't', disable: async () => 'd', depts: async () => 'dp', stage: () => { throw sink; }, probe: () => { throw sink; } };
    const d = mcpCommandDeps(admin as never);
    const names = ['add', 'approve', 'depts', 'disable', 'list', 'show', 'test'];
    expect(Object.keys(d).sort()).toEqual(names);
    expect(Object.getOwnPropertyNames(d).sort()).toEqual(names);
    expect(Object.getPrototypeOf(d)).toBe(Object.prototype);
    expect(d).not.toBe(admin);
    expect(await d.list()).toEqual(['l']);
    expect(await d.depts('s', 'x', { kind: 'admin', userId: '1' })).toBe('dp');
    expect((d as Record<string, unknown>)['stage']).toBeUndefined();
  });
  it('mcpDigestDeps exposes `day` and nothing else of the repo', async () => {
    const r = { day: async (tz: string) => ({ calls: 1, failed: 0, quarantined: 0, tz }), claim: () => { throw new Error('reachable'); }, quarantine: () => { throw new Error('reachable'); } };
    const d = mcpDigestDeps(r as never);
    expect(Object.keys(d)).toEqual(['day']);
    expect(Object.getOwnPropertyNames(d)).toEqual(['day']);
    expect(await d.day('UTC')).toMatchObject({ calls: 1 });
  });
});

describe('app.ts: the run-time holders of McpAdmin are the CommandDeps closure only (spec 6)', () => {
  it('every mention of `mcpAdmin` is its construction, the one `mcpCommandDeps(mcpAdmin)` call or (R7, PF-C19) the one `forgeStageDeps(mcpAdmin)` closure held by ForgeService (forge/wiring.test.ts pins that side)', () => {
    const hits = lines.filter((l) => /\bmcpAdmin\b/.test(l));
    expect(hits.length).toBeGreaterThanOrEqual(2);
    for (const l of hits) expect(/const mcpAdmin = new McpAdmin\(/.test(l) || /mcp: mcpCommandDeps\(mcpAdmin\)/.test(l) || /stage: forgeStageDeps\(mcpAdmin\)/.test(l), l).toBe(true);
    expect(app.match(/mcpCommandDeps\(mcpAdmin\)/g)).toHaveLength(1);
    expect(app.match(/forgeStageDeps\(mcpAdmin\)/g)).toHaveLength(1);
  });
  it('CommandDeps carries it as `mcp`; the object the AdminConsole gets (adminCmd) and the console block never mention mcp', () => {
    expect(app).toMatch(/const commands: CommandDeps = \{ \.\.\.adminCmd, releases: releaseCommandDeps\(releaseService\), mcp: mcpCommandDeps\(mcpAdmin\), forge: forgeCommandDeps\(forgeService\) \};/);
    const adminAt = app.indexOf('const adminCmd');
    expect(adminAt).toBeGreaterThan(0);
    expect(app.slice(adminAt, app.indexOf('const commands: CommandDeps'))).not.toMatch(/mcp/i);
    const block = app.slice(app.indexOf('new AdminConsole({'), app.indexOf('afterApply'));
    expect(block).not.toMatch(/mcp/i);
    expect(block).toContain('cmd: adminCmd');
  });
  it('the digest gets the {day} closure, never the repo; the host and the registry take the host, not the admin', () => {
    expect(app).toContain('mcp: mcpDigestDeps(mcpRepo)');
    expect(app).not.toMatch(/mcp: mcpRepo\b/);
    expect(app).not.toMatch(/mcp: mcpHost\b/);
  });
});

describe('app.ts: external tools reach the main registry only', () => {
  it('the main registry is built with `external`, the admin registry is not; `external:` appears once', () => {
    expect(app).toMatch(/const tools = new ToolRegistry\(\{ halt, incidents, treeGrants: true, autopilot: true, external: \{ get: \(n\) => mcpHost\.get\(n\), names: \(\) => mcpHost\.names\(\) \} \}\);/);
    expect(app).toContain('const adminRegistry = new ToolRegistry({ halt, incidents });');
    expect(app.match(/\bexternal:/g)).toHaveLength(1);
  });
  it('every `registered` the grant and policy read is the static `tools.names()`, never an external list', () => {
    const regLines = lines.filter((l) => /registered: \(\) =>|createToolPolicy\(/.test(l));
    expect(regLines.length).toBeGreaterThanOrEqual(3);
    for (const l of regLines) {
      expect(l, l).not.toMatch(/externalNames/);
      if (/registered: \(\) =>/.test(l)) { expect(l).toContain('registered: () => tools.names()'); expect(l, l).not.toMatch(/mcpHost/); }
    }
    expect(app).toMatch(/createToolPolicy\(cfg, \(\) => tools\.names\(\), \(\) => builtinNames, \(n\) => tools\.kindOf\(n\), \(d\) => mcpHost\.mcpFor\(d\), \(\) => cfg\.get\('mcp\.enabled'\)\)/);
  });
  it('MC-C1 pin: names() never returns an mcp_ name, so the grant `registered` and the policy `registered` cannot', () => {
    const reg = new ToolRegistry({ halt: { isHalted: () => false }, external: { get: () => undefined, names: () => ['mcp_r_ab_x'] } });
    reg.register({ name: 'plain', description: 'p', inputSchema: z.object({}), requiresApproval: () => false, run: vi.fn() } as never);
    expect(reg.names()).toEqual(['plain']);
    expect(reg.externalNames()).toEqual(['mcp_r_ab_x']);
    const p = createToolPolicy(new FakeConfig(), () => reg.names(), () => []);
    expect(p.effective('praw', ['*'])).not.toContain('mcp_r_ab_x');
  });
});

describe('app.ts: the boot never throws and reads the switch live', () => {
  it('bootMcp runs in the background through scheduler.track, only while mcp.enabled is exactly true, and again when the switch is turned on', () => {
    expect(app).toMatch(/scheduler\.track\('mcp\.boot'/);
    expect(app).toMatch(/cfg\.watch\('mcp\.enabled'/);
    expect(app).toMatch(/cfg\.get\('mcp\.enabled'\) === true/);
  });
  it('McpAdmin is handed a host gate that refreshes only after a successful boot', () => {
    expect(app).toMatch(/refresh: async \(slug\?: string\) => \{ if \(mcpBooted\) await mcpHost\.refresh\(slug\); \}/);
  });
});
