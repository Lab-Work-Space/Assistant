import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync, lstatSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bootWorkspaces } from './boot.js';

let base: string;
let home: string;
let cwd: string;
let praw: string;
const uid = process.getuid!();
beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'ws-boot-')));
  home = join(base, 'home');
  cwd = join(base, 'repo');
  praw = join(cwd, 'data/workspace/praw');
  mkdirSync(join(home, '.config/assistant'), { recursive: true });
  mkdirSync(join(home, '.claude'));
  mkdirSync(praw, { recursive: true });
});
afterEach(() => rmSync(base, { recursive: true, force: true }));
const boot = (wsRoot?: string, extra: Record<string, unknown> = {}) => bootWorkspaces({ ...(wsRoot ? { wsRoot } : {}), homes: [home], cwd, prawRoot: praw, uid, ...extra });
const refused = async (wsRoot: string | undefined, extra: Record<string, unknown> = {}) => {
  const r = await boot(wsRoot, extra);
  expect(r.ok, JSON.stringify(wsRoot)).toBe(false);
  return r as Extract<typeof r, { ok: false }>;
};

describe('bootWorkspaces: WS_ROOT placement (WS-C5)', () => {
  it('the default under the home passes, is created 0700 and is returned as a real path', async () => {
    const old = process.env.HOME;
    process.env.HOME = home;
    try {
      const r = await boot();
      expect(r).toEqual({ ok: true, root: join(home, '.config/assistant/workspaces') });
      expect(lstatSync(join(home, '.config/assistant/workspaces')).mode & 0o777).toBe(0o700);
    } finally {
      process.env.HOME = old;
    }
  });
  it('an explicit root elsewhere passes; a wider mode is tightened to 0700', async () => {
    const root = join(base, 'elsewhere');
    mkdirSync(root, { mode: 0o755 });
    chmodSync(root, 0o755);
    expect(await boot(root)).toEqual({ ok: true, root });
    expect(lstatSync(root).mode & 0o777).toBe(0o700);
  });
  it('refuses the home, ~/.config, ~/.config/assistant, media, backups, an ancestor of home, and the executor socket dir', async () => {
    mkdirSync(join(home, '.config/assistant/media'));
    mkdirSync(join(home, '.config/assistant/backups'));
    const sockDir = join(base, 'run');
    mkdirSync(sockDir);
    const targets = [home, join(home, '.config'), join(home, '.config/assistant'), join(home, '.config/assistant/media'), join(home, '.config/assistant/backups'), base, sockDir];
    for (const t of targets) {
      const r = await refused(t, { executorSocket: join(sockDir, 'executor.sock') });
      expect(r.reason, t).toMatch(/protected directory/);
      expect(r.failed).toBe(true);
    }
  });
  it('refuses the cwd, an ancestor of the cwd, anything inside the cwd, ~/.claude (and inside it), the Praw root (and inside it)', async () => {
    for (const t of [cwd, base, join(cwd, 'ws'), join(cwd, 'deep/er/ws'), join(home, '.claude'), join(home, '.claude/ws'), praw, join(praw, 'ws'), join(cwd, 'data/workspace')]) {
      expect((await refused(t)).reason, t).toMatch(/protected directory/);
    }
  });
  it('refusals create nothing', async () => {
    await refused(join(cwd, 'newdir/ws'));
    await refused(join(home, '.claude/newdir'));
    expect(() => lstatSync(join(cwd, 'newdir'))).toThrow();
    expect(() => lstatSync(join(home, '.claude/newdir'))).toThrow();
  });
  it('compares against the passwd home too when the HOME env differs', async () => {
    const realHome = join(base, 'passwd-home');
    mkdirSync(join(realHome, '.config'), { recursive: true });
    const r = await bootWorkspaces({ wsRoot: join(realHome, '.config'), homes: [home, realHome], cwd, prawRoot: praw, uid });
    expect(r).toMatchObject({ ok: false, reason: expect.stringMatching(/protected directory/) });
    const ok = await bootWorkspaces({ wsRoot: join(base, 'fine'), homes: [home, realHome], cwd, prawRoot: praw, uid });
    expect(ok.ok).toBe(true);
  });
  it('refuses a symlink root (even to a safe place), through a symlinked parent that leads to a protected place, and a non-directory', async () => {
    const real = join(base, 'real');
    mkdirSync(real);
    symlinkSync(real, join(base, 'link'));
    expect((await refused(join(base, 'link'))).reason).toMatch(/symlink/);
    symlinkSync(home, join(base, 'homelink'));
    expect((await refused(join(base, 'homelink/.config'))).reason).toMatch(/protected directory/);
    writeFileSync(join(base, 'file'), 'x');
    expect((await refused(join(base, 'file'))).reason).toMatch(/could not be created|not a directory/);
  });
  it('refuses a root inside a git repository (any ancestor with .git)', async () => {
    mkdirSync(join(base, 'proj/.git'), { recursive: true });
    expect((await refused(join(base, 'proj/sub/ws'))).reason).toMatch(/git/);
  });
  it('refuses characters outside [A-Za-z0-9._/-], a root owned by someone else, and uid 0', async () => {
    expect((await refused(join(base, 'with space'))).reason).toMatch(/characters/);
    expect((await refused(join(base, 'ok-dir'), { uid: uid + 1 })).reason).toMatch(/owned/);
    expect((await refused(join(base, 'ok-dir2'), { uid: 0 })).reason).toMatch(/root/);
  });
  it('reasons are fixed text with no path, and `failed` is set only when WS_ROOT was given', async () => {
    const a = await refused(join(cwd, 'x'));
    expect(a.reason).not.toContain(base);
    const old = process.env.HOME;
    process.env.HOME = home;
    try {
      mkdirSync(join(home, '.config/assistant/workspaces'), { recursive: true });
      const r = await bootWorkspaces({ homes: [home], cwd: join(home, '.config/assistant/workspaces'), prawRoot: praw, uid }); // default root equals the cwd
      expect(r).toMatchObject({ ok: false, failed: false });
    } finally {
      process.env.HOME = old;
    }
  });
});
