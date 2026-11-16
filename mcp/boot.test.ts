import { describe, expect, it } from 'vitest';
import type { McpRow } from '../db/repos/mcp.js';
import { bootMcp, type BootDeps } from './boot.js';
import type { ToolPlugin } from '../tools/types.js';
import { McpHost } from './host.js';
import { buildSnapshot } from './snapshot.js';
import { FakeMcpDocker } from './test-helpers.js';
import { pinned } from './test-helpers.js';

const IMG = `sha256:${'c'.repeat(64)}`;
const row = (slug: string, o: Partial<McpRow> = {}): McpRow => ({ id: 1, slug, imageId: IMG, status: 'active', ...o }) as McpRow;
function mk(rows: McpRow[] | Error = [row('srv')], over: Partial<BootDeps> = {}) {
  const docker = new FakeMcpDocker();
  const audits: { actor: string; action: string; outcome?: string | null }[] = [];
  const loads: (ReadonlySet<string> | undefined)[] = [];
  const logs: unknown[] = [];
  const d: BootDeps = {
    docker, repo: { activeRows: async () => { if (rows instanceof Error) throw rows; return rows; } },
    host: { load: async (ex) => { loads.push(ex); return { loaded: 1, failed: [] }; } }, audit: async (e) => void audits.push(e), log: { error: (o: unknown) => logs.push(o) }, ...over,
  };
  return { d, docker, audits, loads, logs };
}

describe('MCP-AC23: boot never throws and leaves MCP off with a fixed reason (spec 5.14, MC-C3, MC-C19)', () => {
  it('ok: the Docker, seccomp, sweep and image checks pass, the host loads, and one mcp.boot row says ok n', async () => {
    const { d, audits, loads } = mk();
    expect(await bootMcp(d)).toEqual({ ok: true, loaded: 1, missing: [] });
    expect(audits).toEqual([{ actor: 'system:mcp', action: 'mcp.boot', outcome: 'ok 1' }]);
    expect(loads).toHaveLength(1);
  });
  it('Docker absent, a failing version check or a throwing docker port: off:docker, no load, never a throw', async () => {
    for (const setup of [(x: FakeMcpDocker) => { x.missing = true; }, (x: FakeMcpDocker) => { x.versionCode = 1; }]) {
      const { d, docker, audits, loads } = mk();
      setup(docker);
      expect(await bootMcp(d)).toEqual({ ok: false, reason: 'docker' });
      expect(audits).toEqual([{ actor: 'system:mcp', action: 'mcp.boot', outcome: 'off:docker' }]);
      expect(loads).toHaveLength(0);
    }
    const t = mk(undefined, { docker: { exec: () => { throw new Error('boom'); } } });
    expect(await bootMcp(t.d)).toEqual({ ok: false, reason: 'error' });
  });
  it('MC-C3: without seccomp in docker info, or with unconfined, MCP stays off (off:seccomp)', async () => {
    for (const info of ['["name=cgroupns"]', '["name=seccomp,profile=unconfined"]', '["name=seccomp,profile=builtin","name=unconfined"]', 'not json', '{}', 'null', '']) {
      const { d, docker, audits, loads } = mk();
      docker.info = info;
      expect(await bootMcp(d), info).toEqual({ ok: false, reason: 'seccomp' });
      expect(audits[0]!.outcome).toBe('off:seccomp');
      expect(loads).toHaveLength(0);
    }
    const ok = mk();
    ok.docker.info = '["name=seccomp,profile=builtin"]';
    expect((await bootMcp(ok.d)).ok).toBe(true);
  });
  it('MC-C19: the sweep removes only containers that carry label mcp=1 AND a name matching the mcp pattern, with rm -f -v; a foreign name is left alone', async () => {
    const { d, docker } = mk();
    docker.labelled = ['mcp-srv-abcdef01', 'mcp-evil', 'ws-proj-abcdef01', 'mcp-srv-ABCDEF01', 'mcp-a-12345678', 'mcp-srv-abcdef01x'];
    await bootMcp(d);
    expect(docker.execs.find((e) => e[0] === 'ps')).toEqual(['ps', '-a', '--filter', 'label=mcp=1', '--format', '{{.Names}}']);
    expect(docker.removed).toEqual(['mcp-srv-abcdef01']); // mcp-a-12345678 has a one-letter slug, mcp-srv-abcdef01x is too long, the rest fail the pattern
    expect(docker.execs.filter((e) => e[0] === 'rm').every((e) => e[1] === '-f' && e[2] === '-v')).toBe(true);
  });
  it('a removal that cannot be verified leaves MCP off (off:sweep)', async () => {
    const { d, docker } = mk();
    docker.labelled = ['mcp-srv-abcdef01'];
    docker.stuck.add('mcp-srv-abcdef01');
    expect(await bootMcp(d)).toEqual({ ok: false, reason: 'sweep' });
  });
  it('an active row whose image id differs or declares volumes is not loaded (the row is unchanged), audited as image_missing, and listed', async () => {
    const a = mk([row('srv'), row('okk', { id: 2 })]);
    a.docker.imageId = IMG;
    // the fake answers one image id for every row: make the second row's id differ
    const r = await bootMcp({ ...a.d, repo: { activeRows: async () => [row('srv'), row('okk', { id: 2, imageId: `sha256:${'d'.repeat(64)}` })] } });
    expect(r).toEqual({ ok: true, loaded: 1, missing: ['okk'] });
    expect(a.audits.map((x) => x.outcome)).toEqual(['image_missing okk', 'ok 1']);
    expect([...(a.loads[0] ?? [])]).toEqual(['okk']);
    const b = mk();
    b.docker.volumes = '{"/data":{}}';
    expect(await bootMcp(b.d)).toMatchObject({ ok: true, missing: ['srv'] });
  });
  it('a repository or host failure is off:error and the 20 s cap is a real timer (off:timeout)', async () => {
    expect(await bootMcp(mk(new Error('db')).d)).toEqual({ ok: false, reason: 'error' });
    const { d } = mk(undefined, { timeoutMs: 40, docker: { exec: () => new Promise(() => undefined) } });
    const t0 = Date.now();
    expect(await bootMcp(d)).toEqual({ ok: false, reason: 'timeout' });
    expect(Date.now() - t0).toBeLessThan(500);
  });
  it('after the 20 s cap fires, a late-finishing check changes nothing: the host is never loaded and the only audit row is off:timeout', async () => {
    const base = mk();
    let first = true;
    const slow = { exec: async (a: readonly string[]) => { if (first) { first = false; await new Promise((r) => setTimeout(r, 90)); } return base.docker.exec(a); } };
    const { d, audits, loads } = mk(undefined, { timeoutMs: 40, docker: slow });
    expect(await bootMcp(d)).toEqual({ ok: false, reason: 'timeout' });
    await new Promise((r) => setTimeout(r, 400));
    expect(loads).toEqual([]);
    expect(audits).toEqual([{ actor: 'system:mcp', action: 'mcp.boot', outcome: 'off:timeout' }]);
  });
  it('logs only error names', async () => {
    const { d, logs } = mk(new Error('db password=hunter2'));
    await bootMcp(d);
    expect(JSON.stringify(logs)).not.toContain('hunter2');
  });
  it('G2-MCP-03: a host load still running when the cap fires leaves the host EMPTY (cleared at the cap, and the late load cannot refill it); a later boot loads normally', async () => {
    const RAW = [{ name: 'echo', description: 'Echoes.', inputSchema: { type: 'object' } }];
    const b = buildSnapshot(RAW, { slug: 'srv', toolClass: 'write' });
    const full = pinned(row('srv', { toolClass: 'write', snapshot: b.raw, snapshotSha256: b.sha256, timeoutMs: 60000, command: [], env: {}, depts: ['software'] }));
    let delay = 150;
    const host = new McpHost({
      repo: { activeRows: async () => { await new Promise((r) => setTimeout(r, delay)); return [full]; } },
      makeTool: (s, t): ToolPlugin => ({ name: t.name, description: t.description, inputSchema: t.schema as never, kind: s.cls, untrustedOutput: true, untrustedSource: 'mcp', requiresApproval: () => false, run: async () => ({ content: 'x' }) }),
      secrets: () => [], incident: () => undefined, log: { error: () => undefined },
    });
    const { d, audits } = mk(undefined, { timeoutMs: 40, host });
    expect(await bootMcp(d)).toEqual({ ok: false, reason: 'timeout' });
    expect(host.names()).toEqual([]);
    await new Promise((r) => setTimeout(r, 400)); // the slow load finishes now
    expect(host.names()).toEqual([]);
    expect(host.mcpFor('software')).toEqual([]);
    expect(audits).toEqual([{ actor: 'system:mcp', action: 'mcp.boot', outcome: 'off:timeout' }]);
    delay = 0; // a later boot (the switch turned on again) is not cancelled
    const again = mk(undefined, { host });
    expect(await bootMcp(again.d)).toMatchObject({ ok: true, loaded: 1 });
    expect(host.names()).toEqual(['mcp_w_srv_echo']);
  });
});
