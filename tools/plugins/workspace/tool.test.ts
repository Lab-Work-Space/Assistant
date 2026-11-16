import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeConfig } from '../../../governance/test-helpers.js';
import { toGeminiSchema } from '../../../providers/gemini/convert.js';
import type { PluginDeps } from '../deps.js';
import { webRig } from '../web/test-helpers.js';
import { READ_TEXT_MAX, workspaceGroup } from './index.js';

const PRAW = { kind: 'head', dept: 'praw' } as const;
const SRC = { channelId: 'c1', threadId: null, messageId: null, userId: 'u1', attachments: [] };
let base: string;
let root: string;
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'praw-wst-'));
  root = join(base, 'ws');
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

function setup(r: string | undefined = root) {
  const deps = { env: {}, cfg: new FakeConfig(), log: { warn: vi.fn() }, clock: () => 0, workspaceRoot: r } as unknown as PluginDeps;
  const g = workspaceGroup(deps);
  if ('disabled' in g) throw new Error(g.disabled);
  return { g, rig: (c = {}) => webRig(g.tools, { actor: PRAW, direct: true, origin: 'chat', source: SRC, ...c }) };
}

describe('workspace tools', () => {
  it('kinds, untrusted read and Gemini schemas; the group is off without a root', () => {
    const { g } = setup();
    expect(Object.fromEntries(g.tools.map((t) => [t.name, t.kind]))).toEqual({ list_files: 'read', read_file: 'read', write_file: 'write' });
    expect(g.tools.find((t) => t.name === 'read_file')).toMatchObject({ untrustedOutput: true, untrustedSource: 'workspace' });
    for (const t of g.tools) expect(() => toGeminiSchema(t.inputSchema as never)).not.toThrow();
    const off = workspaceGroup({ env: {}, cfg: new FakeConfig(), log: { warn: vi.fn() } } as unknown as PluginDeps);
    expect(off).toMatchObject({ id: 'workspace', disabled: expect.any(String) });
  });

  it('write_file › direct untainted run writes without approval; delegated or tainted run needs approval', async () => {
    const t = setup();
    const direct = await t.rig();
    const ok = await direct.reg.run('write_file', { path: 'a.md', content: 'hi' }, direct.c);
    expect(ok.isError).toBeFalsy();
    expect(readFileSync(join(root, 'a.md'), 'utf8')).toBe('hi');
    expect(direct.approvals.request).not.toHaveBeenCalled();

    const tainted = await t.rig({ tainted: () => true });
    expect((await tainted.reg.run('write_file', { path: 'b.md', content: 'x' }, tainted.c)).content).toMatch(/^NOT DONE YET: waiting for approval of/);
    const delegated = await t.rig({ direct: false, origin: 'delegated' });
    expect((await delegated.reg.run('write_file', { path: 'c.md', content: 'x' }, delegated.c)).content).toMatch(/^NOT DONE YET: waiting for approval of/);
    expect(tainted.approvals.request).toHaveBeenCalledTimes(1);
    expect(delegated.approvals.request).toHaveBeenCalledTimes(1);
    expect(existsSync(join(root, 'b.md')) || existsSync(join(root, 'c.md'))).toBe(false);
  });

  it('write_file outside the workspace is refused even when approved (no approval path)', async () => {
    const t = setup();
    const { reg, c } = await t.rig({ direct: false });
    for (const path of ['../escape.txt', '/tmp/escape.txt']) {
      const r = await reg.run('write_file', { path, content: 'x' }, c);
      expect(r.content).not.toMatch(/^NOT DONE YET/);
      expect(r.isError).toBe(true);
      const a = await reg.runApproved('write_file', { path, content: 'x' }, c);
      expect(a.isError).toBe(true);
    }
    expect(existsSync(join(base, 'escape.txt'))).toBe(false);
    expect(c.approvals.request).not.toHaveBeenCalled();
  });

  it('read_file › large file truncated with marker, content wrapped untrusted', async () => {
    const t = setup();
    mkdirSync(root, { recursive: true, mode: 0o700 });
    writeFileSync(join(root, 'big.txt'), 'A'.repeat(READ_TEXT_MAX + 500) + 'TAIL');
    const { reg, c } = await t.rig();
    const r = await reg.run('read_file', { path: 'big.txt' }, c);
    expect(r.isError).toBeFalsy();
    expect(r.content).toMatch(/<untrusted[^>]*source="workspace"/);
    expect(r.content).toMatch(/truncated/i);
    expect(r.content).not.toContain('TAIL');
    expect(c.run.tainted()).toBe(true);
  });

  it('read_file and list_files report clear errors; list shows sizes', async () => {
    const t = setup();
    const { reg, c } = await t.rig();
    expect((await reg.run('list_files', {}, c)).content).toMatch(/empty/i);
    await reg.run('write_file', { path: 'd/x.txt', content: 'abc' }, c);
    expect((await reg.run('list_files', {}, c)).content).toContain('d/');
    expect((await reg.run('list_files', { path: 'd' }, c)).content).toMatch(/x\.txt.*3 bytes/);
    expect((await reg.run('write_file', { path: 'd/x.txt', content: 'z' }, c)).content).toMatch(/exists.*overwrite/i);
    const missing = await reg.run('read_file', { path: 'nope.txt' }, c);
    expect(missing.content).toMatch(/no such file/i);
  });
});
