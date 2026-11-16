import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * R7 PLUGIN-FORGE BE2 wiring (spec 6 run-time holders, PF-C13, PF-C19, FG-AC21). Lives under forge/ so devjob/paths.ts protects it. A raw-text read of app.ts: who holds ForgeService, McpAdmin,
 * the enqueue closure and the forge repo, where the construction sits, and what the AI-driven AdminConsole is given.
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const app = readFileSync(join(ROOT, 'app.ts'), 'utf8');
const lines = app.split('\n');
const at = (s: string): number => app.indexOf(s);
const only = (re: RegExp, ok: RegExp[], what: string): void => {
  const hits = lines.filter((l) => re.test(l));
  expect(hits.length, `${what}: at least the construction`).toBeGreaterThanOrEqual(1);
  for (const l of hits) expect(ok.some((o) => o.test(l)), `${what}: ${l.trim().slice(0, 140)}`).toBe(true);
};

describe('ForgeService holders (spec 6)', () => {
  it('is constructed once, after McpAdmin and before the CommandDeps objects', () => {
    expect(app.match(/new ForgeService\(/g)).toHaveLength(1);
    expect(at('new ForgeService(')).toBeGreaterThan(at('const mcpAdmin = new McpAdmin('));
    expect(at('new ForgeService(')).toBeLessThan(at('const adminCmd'));
  });
  it('every mention of `forgeService` is its construction, the one forgeCommandDeps closure, or a timer or recover call', () => {
    only(/\bforgeService\b/, [/const forgeService = new ForgeService\(/, /forge: forgeCommandDeps\(forgeService\)/, /\bforgeService\.(tick|gc|recover)\(\)/], 'forgeService');
    expect(app.match(/forgeCommandDeps\(forgeService\)/g)).toHaveLength(1);
  });
  it('CommandDeps carries `forge`; the object the AdminConsole gets (adminCmd) and the console block never mention the forge (PF-C13)', () => {
    expect(app).toMatch(/const commands: CommandDeps = \{ \.\.\.adminCmd, releases: releaseCommandDeps\(releaseService\), mcp: mcpCommandDeps\(mcpAdmin\), forge: forgeCommandDeps\(forgeService\) \};/);
    const adminAt = at('const adminCmd');
    expect(app.slice(adminAt, at('const commands: CommandDeps'))).not.toMatch(/forge/i);
    const block = app.slice(at('new AdminConsole({'), at('afterApply'));
    expect(block).not.toMatch(/forge/i);
    expect(block).toContain('cmd: adminCmd');
  });
});

describe('McpAdmin holders (spec 6): the CommandDeps closure and the forgeStageDeps closure, nothing else', () => {
  it('every mention of `mcpAdmin` is its construction, mcpCommandDeps(mcpAdmin) or forgeStageDeps(mcpAdmin); the latter sits inside the ForgeService construction', () => {
    only(/\bmcpAdmin\b/, [/const mcpAdmin = new McpAdmin\(/, /mcp: mcpCommandDeps\(mcpAdmin\)/, /stage: forgeStageDeps\(mcpAdmin\)/], 'mcpAdmin');
    expect(app.match(/forgeStageDeps\(mcpAdmin\)/g)).toHaveLength(1);
    const svc = app.slice(at('new ForgeService('), at('const adminCmd'));
    expect(svc).toContain('stage: forgeStageDeps(mcpAdmin)');
  });
  it('stageRelease is never named in app.ts (it is reachable only through forgeStageDeps)', () => {
    expect(app).not.toMatch(/\bstageRelease\b/);
  });
  it('a card approve never activates a server: no activate, approve or stage call of the MCP admin or repo in app.ts, forge/ or releases/', () => {
    expect(app).not.toMatch(/\.activate\(|mcpAdmin\.(approve|stage|add)\(|mcpRepo\.(activate|stage)\(/);
  });
});

describe('the enqueue closure and the forge repo (PF-C13)', () => {
  it('the request port is built once and given to the ReleaseService deps only; the enqueue closure is not named in app.ts', () => {
    expect(app.match(/makeForgeRequestPort\(/g)).toHaveLength(1);
    const rel = app.slice(at('const releaseService = new ReleaseService({'), at('for (const t of releaseTools('));
    expect(rel).toContain('forge: makeForgeRequestPort({');
    expect(app).not.toMatch(/makeForgeEnqueue|\benqueue\b/);
    expect(app).not.toMatch(/forge: forgeRequestPort|forgePort/);
  });
  it('every mention of `forgeRepo` is its construction, the request port, the digest closure, the note reads or the ForgeService repo', () => {
    only(/\bforgeRepo\b/, [/const forgeRepo = new ForgeRepo\(pool\)/, /makeForgeRequestPort\(\{[^\n]*repo: forgeRepo/, /forge: forgeDigestDeps\(forgeRepo\)/, /forgeRepo\.(eligibleIdeas|softwareIdea)\(/, /^\s*repo: forgeRepo,?/], 'forgeRepo');
    expect(app.match(/forgeDigestDeps\(forgeRepo\)/g)).toHaveLength(1);
    // G2-FG-03: each allowed form appears exactly once, and the bare `repo: forgeRepo` line sits inside the ForgeService construction (a second object with that line would pass the line filter)
    expect(lines.filter((l) => /^\s*repo: forgeRepo\b/.test(l))).toHaveLength(1);
    expect(app.slice(at('const forgeService = new ForgeService({'), at('const adminCmd'))).toMatch(/^\s*repo: forgeRepo\b/m);
    expect(app.match(/repo: forgeRepo\b/g)).toHaveLength(2); // the request port and ForgeService
    expect(app.match(/forgeRepo\.eligibleIdeas\(/g)).toHaveLength(1);
    expect(app.match(/forgeRepo\.softwareIdea\(/g)).toHaveLength(1);
  });
  it('the forge repo is built before the release service and the loop deps that use it', () => {
    expect(at('const forgeRepo = new ForgeRepo(pool)')).toBeLessThan(at('const releaseService = new ReleaseService({'));
  });
  it('the AI loop gets two narrow note reads and nothing else of the forge', () => {
    const m = /forge: \{ hqIdeas: [^\n]*\},/.exec(app);
    expect(m).not.toBeNull();
    expect(m![0]).toMatch(/hqIdeas: \(\) => forgeRepo\.eligibleIdeas\(5\)/);
    expect(m![0]).toMatch(/softwareIdea: \(rootId\) => forgeRepo\.softwareIdea\(rootId\)/);
  });
});

describe('switches, timers and boot (PF-C17, PF-C23)', () => {
  it('forge.enabled is read through cfg.get at each site and never written by app.ts', () => {
    expect(app).not.toMatch(/cfg\.set\(\s*'forge\.enabled'/);
    expect(app).toMatch(/cfg\.get\('forge\.enabled'\)/);
  });
  it('the base id is read once through loadBaseId and the same value goes to the card port and to ForgeService', () => {
    expect(app.match(/loadBaseId\(/g)).toHaveLength(1);
    expect(app.match(/\bforgeBaseId\b/g)!.length).toBeGreaterThanOrEqual(3);
    expect(app).toMatch(/baseId: forgeBaseId/);
    expect(app).toMatch(/baseImageId: forgeBaseId/);
  });
  it('the tick and the GC timers are cleared on stop; recover runs only while forge.enabled reads true and again when it turns on', () => {
    expect(app).toMatch(/forgeTick = setInterval\(/);
    expect(app).toMatch(/forgeGcTick = setInterval\(/);
    expect(app).toMatch(/if \(forgeTick\) clearInterval\(forgeTick\)/);
    expect(app).toMatch(/if \(forgeGcTick\) clearInterval\(forgeGcTick\)/);
    expect(app).toMatch(/cfg\.watch\('forge\.enabled'/);
    expect(app).toMatch(/const forgeOn = \(\): boolean =>/);
  });
  it('the docker port of the forge is the real CLI by default and a test seam otherwise (never created at import time)', () => {
    expect(app).toMatch(/o\.forge\?\.docker \?\? realDockerCli\(\)/);
  });
});
