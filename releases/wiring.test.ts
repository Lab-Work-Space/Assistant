import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ADMIN_CONFIG_KEYS, HANDLER_KEYS } from '../admin/keys.js';
import { CONFIG_DEFAULTS } from '../config/defaults.js';
import { ConfigSchema } from '../config/schema.js';
import { cmd, makeDeps, text } from '../discord/commands/test-helpers.js';
import { handleInteraction } from '../discord/commands/index.js';
import { releaseToolDeps, releaseTools } from '../tools/builtin/releases.js';
import { releaseCommandDeps, releaseDigestDeps } from './service.js';

/** R5 BE2 wiring (Gate 1 RL-C1c, RL-C5, RL-C13). These tests live under releases/ so devjob/paths.ts protects them. */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = (f: string) => readFileSync(join(ROOT, f), 'utf8');
const app = src('app.ts');

describe('RL-C1(c): app.ts hands the tool the closure and nothing else', () => {
  it('releaseToolDeps exposes exactly one own property, `request`, with no prototype methods', async () => {
    const calls: unknown[][] = [];
    const service = { request: async (...a: unknown[]) => { calls.push(a); return { ok: true as const, id: 1, text: 't' }; }, decide: () => { throw new Error('reachable'); }, reject: () => { throw new Error('reachable'); }, list: () => [], show: () => null };
    const deps = releaseToolDeps(service as never);
    expect(Object.keys(deps)).toEqual(['releases']);
    expect(Object.keys(deps.releases)).toEqual(['request']);
    expect(Object.getOwnPropertyNames(deps.releases)).toEqual(['request']);
    expect(Object.getPrototypeOf(deps.releases)).toBe(Object.prototype);
    expect(Object.getPrototypeOf(deps)).toBe(Object.prototype);
    await deps.releases.request({ kind: 'head', dept: 'software' }, {} as never, {} as never);
    expect(calls).toHaveLength(1);
  });
  it('app.ts registers `releaseTools(releaseToolDeps(releaseService))` and never passes the service itself to a tool', () => {
    expect(app).toContain('for (const t of releaseTools(releaseToolDeps(releaseService))) tools.register(t);');
    expect(app).not.toMatch(/releaseTools\(\s*\{/);
    expect(app).not.toMatch(/releaseTools\(releaseService\)/);
    expect(releaseTools.length).toBe(1);
  });
  it('the registration is after wsService and before coreToolNames (declared in builtin), and RELEASE sits before GROW in builtinNames', () => {
    const at = (s: string) => app.indexOf(s);
    expect(at('const wsService =')).toBeGreaterThan(0);
    expect(at('releaseTools(releaseToolDeps(releaseService))')).toBeGreaterThan(at('const wsService ='));
    expect(at('releaseTools(releaseToolDeps(releaseService))')).toBeLessThan(at('const coreToolNames'));
    expect(app).toMatch(/const builtinNames = \[[^\]]*\.\.\.RELEASE_TOOL_NAMES, \.\.\.GROW_TOOL_NAMES\]/);
  });
  it('G2-RL-03: CommandDeps gets a closure object with exactly decide/list/show/reject, not the service; no list/show view reaches a token', async () => {
    const sink = new Error('forwarded');
    const service = { decide: async () => 'd', reject: async () => 'r', list: async () => ['l'], show: async () => 's', request: () => { throw sink; }, sweep: () => { throw sink; }, recover: () => { throw sink; }, bootTime: () => { throw sink; } };
    const d = releaseCommandDeps(service as never);
    expect(Object.keys(d).sort()).toEqual(['decide', 'list', 'reject', 'show']);
    expect(Object.getOwnPropertyNames(d).sort()).toEqual(['decide', 'list', 'reject', 'show']);
    expect(Object.getPrototypeOf(d)).toBe(Object.prototype);
    expect(await d.list(3)).toEqual(['l']);
    expect(await d.show(1)).toBe('s');
    expect(d).not.toBe(service);
    expect(app).toContain('releases: releaseCommandDeps(releaseService)');
    expect(app).not.toMatch(/releases: releaseService\b/);
  });
  it('G2-RL-03: the AdminConsole gets a CommandDeps object built before `releases` exists; no release operation, key or service reaches it', () => {
    const block = app.slice(app.indexOf('new AdminConsole({'), app.indexOf('afterApply'));
    expect(block).toContain('cmd: adminCmd');
    expect(block).not.toMatch(/cmd: commands\b/);
    expect(block).not.toMatch(/release/i);
    const adminAt = app.indexOf('const adminCmd');
    expect(adminAt).toBeGreaterThan(0);
    const adminObj = app.slice(adminAt, app.indexOf('const commands: CommandDeps'));
    expect(adminObj).not.toMatch(/release/i);
    expect(app).toMatch(/const commands: CommandDeps = \{ \.\.\.adminCmd, releases: releaseCommandDeps\(releaseService\), mcp: mcpCommandDeps\(mcpAdmin\), forge: forgeCommandDeps\(forgeService\) \};/);
  });
  it('G2-RL-04: AiDigest gets a {day} closure, never the repo', () => {
    const r = { day: async (tz: string) => ({ tz }), claim: () => { throw new Error('reachable'); }, fail: () => { throw new Error('reachable'); } };
    const d = releaseDigestDeps(r as never);
    expect(Object.keys(d)).toEqual(['day']);
    expect(Object.getOwnPropertyNames(d)).toEqual(['day']);
    expect(app).toContain('releases: releaseDigestDeps(releaseRepo)');
    expect(app).not.toMatch(/releases: releaseRepo\b/);
  });
});

describe('RL-C5, RL-C13: boot, sweeps and the kill switch', () => {
  it('bootTime is read from the database before startApp brings the clients up, and recovery uses it', () => {
    const boot = app.indexOf('await releaseService.bootTime()');
    expect(boot).toBeGreaterThan(0);
    expect(boot).toBeLessThan(app.indexOf('await startApp('));
    expect(app).toContain('releaseService.recover(releaseBootTime)');
  });
  it('recovery, the first sweep and every periodic sweep run through scheduler.track; the interval is cleared at shutdown', () => {
    expect(app).toMatch(/scheduler\.track\('release\.recover', async \(\) => \{ await releaseService\.recover\(releaseBootTime\);/);
    expect(app).toMatch(/releaseSweep = setInterval\(\(\) => void scheduler\.track\('release\.sweep', async \(\) => \{ await releaseService\.sweep\(\); \}\), 60_000\)/);
    expect(app).toContain('if (releaseSweep) clearInterval(releaseSweep);');
    expect(app).not.toMatch(/void releaseService\.(recover|sweep)\(/);
  });
  it('ws unavailable means the service sees ws as off', () => {
    expect(app).toMatch(/wsEnabled: \(\) => wsService !== undefined && cfg\.get\('ws\.enabled'\) === true/);
  });
  it('release.enabled is in the schema (boolean), defaults to true, is a HANDLER key and not an admin key', () => {
    expect(ConfigSchema['release.enabled'].safeParse(true).success).toBe(true);
    expect(ConfigSchema['release.enabled'].safeParse('yes').success).toBe(false);
    expect(CONFIG_DEFAULTS['release.enabled']).toBe(true);
    expect(HANDLER_KEYS).toContain('release.enabled');
    expect(ADMIN_CONFIG_KEYS).not.toContain('release.enabled');
  });
  it('/settings set release.enabled is refused with no write (psql only)', async () => {
    const t = await makeDeps();
    const r = await handleInteraction(cmd('settings', 'set', { strings: { key: 'release.enabled', value: 'false' } }), t.deps);
    expect(text(r)).toContain('the owner sets it in the database');
    expect(t.sets).toEqual([]);
    expect(t.deps.cfg.get('release.enabled')).toBe(true);
  });
  it('the service reads the switch live at app.ts: `enabled: () => cfg.get(\'release.enabled\')` (a throw is off inside the service)', () => {
    expect(app).toContain("enabled: () => cfg.get('release.enabled')");
  });
});

describe('RL-C11: relcard: is routed only in route(), never in the pre-check branches of decide()', () => {
  it('decide() does not mention relcard; route() sends it to the button handler; deferEphemeral lists it; the toolreq substring is intact', () => {
    const idx = src('discord/commands/index.ts');
    const decide = idx.slice(idx.indexOf('async function decide('), idx.indexOf('export async function handleInteraction'));
    expect(decide).not.toContain('relcard');
    const route = idx.slice(idx.indexOf('function route('), idx.indexOf('/** Guard order'));
    expect(route).toContain("startsWith('relcard:') ? releaseCardButton");
    expect(route).toContain("startsWith('toolreq:') ? toolRequestButton");
    expect(idx).toContain("i.customId.startsWith('relcard:')");
    expect(idx).toContain("i.commandName === 'release'");
    for (const k of ["'release:list': releaseList", "'release:show': releaseShow", "'release:reject': releaseReject"]) expect(idx).toContain(k);
  });
  it('a relcard click from the model-facing side is impossible: handleInteraction has the one caller app-start.ts, and release.ts is the only module that calls decide/reject', () => {
    const callers = ['discord/commands/release.ts', 'app.ts'].map((f) => src(f));
    expect(callers[0]).toMatch(/releases\.decide\(/);
    expect(callers[0]).toMatch(/releases\.reject\(/);
    expect(callers[1]).not.toMatch(/releaseService\.(decide|reject)\(/);
  });
});

describe('prompts and notes', () => {
  it('only the software head lists release_request, right after project_task', () => {
    expect(src('prompts/heads/software.md')).toMatch(/project_task, release_request\]/);
    for (const h of ['hq', 'rnd', 'it', 'ops', 'sales', 'hr', 'finance', 'marketing', 'praw']) expect(src(`prompts/heads/${h}.md`), h).not.toContain('release_request');
  });
});
