import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bootWorkspaces } from './boot.js';
import { FakeDocker } from './test-helpers.js';

const ID = `sha256:${'d'.repeat(64)}`;
let base: string;
let d: FakeDocker;
const uid = process.getuid!();
beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'ws-bootd-')));
  mkdirSync(join(base, 'home/.config/assistant'), { recursive: true });
  mkdirSync(join(base, 'repo/data/workspace/praw'), { recursive: true });
  mkdirSync(join(base, 'img/docker/ws'), { recursive: true });
  writeFileSync(join(base, 'img/docker/ws/images.json'), JSON.stringify({ runner: ID, proxy: `sha256:${'e'.repeat(64)}` }));
  d = new FakeDocker();
  d.imageId = ID;
});
afterEach(() => rmSync(base, { recursive: true, force: true }));
const boot = (extra: Record<string, unknown> = {}, wsRoot: string | undefined = join(base, 'wsroot')) =>
  bootWorkspaces({ ...(wsRoot ? { wsRoot } : {}), homes: [join(base, 'home')], cwd: join(base, 'repo'), prawRoot: join(base, 'repo/data/workspace/praw'), uid, docker: d, imagesDir: join(base, 'img'), ...extra });
const no = async (extra: Record<string, unknown> = {}, wsRoot?: string) => {
  const r = await boot(extra, wsRoot);
  expect(r.ok).toBe(false);
  return r as Extract<typeof r, { ok: false }>;
};

describe('bootWorkspaces: Docker checks and sweep (SA-1 3.1, WS-C13)', () => {
  it('passes with the verified runner id and an empty sweep', async () => {
    const r = await boot();
    expect(r).toEqual({ ok: true, root: join(base, 'wsroot'), runner: ID });
    expect(d.execs.map((e) => e[0])).toEqual(['version', 'image', 'ps', 'ps']);
  });
  it('the sweep removes every ws=1 container and checks again', async () => {
    d.sweepIds = ['aaaaaaaaaaaa', 'bbbbbbbbbbbb'];
    expect((await boot()).ok).toBe(true);
    expect(d.execs.filter((e) => e[0] === 'rm').map((e) => e[2])).toEqual(['aaaaaaaaaaaa', 'bbbbbbbbbbbb']);
    expect(d.sweepIds).toEqual([]);
  });
  it('a sweep that leaves a container, or a failed ps, leaves ws disabled', async () => {
    d.sweepIds = ['aaaaaaaaaaaa'];
    d.stubbornIds = true;
    const r = await no();
    expect(r.reason).toBe('the container sweep failed');
    expect(r.failed).toBe(true);
    d.stubbornIds = false;
    d.sweepIds = [];
    d.psCode = 1;
    expect((await no()).reason).toBe('the container sweep failed');
  });
  it('docker not reachable: disabled; failed only when WS_ROOT was set', async () => {
    d.versionCode = 1;
    expect(await no()).toEqual({ ok: false, reason: 'docker is not reachable', failed: true });
    expect((await no({}, '')).failed).toBe(false);
    d.versionCode = 127;
    expect((await no()).reason).toBe('the docker CLI is not installed');
  });
  it('a runner image id that does not match images.json, or a bad images.json, is disabled with a fixed reason (no id in it)', async () => {
    d.imageId = `sha256:${'f'.repeat(64)}`;
    const r = await no();
    expect(r.reason).toMatch(/does not match images\.json/);
    expect(r.reason).not.toContain('ffff');
    writeFileSync(join(base, 'img/docker/ws/images.json'), '{"runner":"latest"}');
    expect((await no()).reason).toMatch(/images\.json is missing or invalid/);
  });
  it('a refused WS_ROOT never reaches Docker', async () => {
    const r = await no({}, join(base, 'home'));
    expect(r.reason).toMatch(/protected directory/);
    expect(d.execs).toHaveLength(0);
  });
  it('without a docker port only the file-system checks run (unit tests of placement)', async () => {
    const r = await boot({ docker: undefined });
    expect(r).toEqual({ ok: true, root: join(base, 'wsroot') });
  });
});
