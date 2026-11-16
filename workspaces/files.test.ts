import { execFileSync } from 'node:child_process';
import { closeSync, linkSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, truncateSync, writeFileSync, existsSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SandboxError } from '../tools/plugins/workspace/sandbox.js';
import { WsError } from './errors.js';
import { ProjectFiles, WS_LIMITS, wsRel } from './files.js';

let base: string;
let root: string;
let proj: string;
let outside: string;
let canary: string;
const refuses = async (p: Promise<unknown>, msg?: RegExp) => {
  const e = await p.then(() => null, (x: unknown) => x);
  expect(e, 'should refuse').toBeInstanceOf(Error);
  if (msg) expect((e as Error).message).toMatch(msg);
  return e as Error;
};
beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'ws-files-')));
  root = join(base, 'root');
  outside = join(base, 'outside');
  mkdirSync(root, { mode: 0o700 });
  mkdirSync(join(root, 'proj'), { mode: 0o700 });
  mkdirSync(outside);
  proj = join(root, 'proj');
  canary = join(outside, 'canary.txt');
  writeFileSync(canary, 'TOP-SECRET');
});
afterEach(() => rmSync(base, { recursive: true, force: true }), 120_000);
const pf = (o = {}) => new ProjectFiles(root, o);

describe('path rules (lexical)', () => {
  it('refuses .., absolute, NUL, empty segments, backslash tricks, depth > 12, length > 240', () => {
    for (const p of ['../x', 'a/../b', '/etc/passwd', 'a\0b', 'a//b', './a', 'a/./b', '', 'a/b/', '..', 'a\\b', 'a:b', 'ä.txt']) expect(() => wsRel(p), JSON.stringify(p)).toThrow(SandboxError);
    expect(() => wsRel(Array.from({ length: 12 }, () => 'd').join('/'))).not.toThrow();
    expect(() => wsRel(Array.from({ length: 13 }, () => 'd').join('/'))).toThrow(/depth is at most 12/);
    expect(() => wsRel('a'.repeat(240))).not.toThrow();
    expect(() => wsRel('a'.repeat(241))).toThrow(/too long/);
  });
  it('the reserved temp prefix is refused in any case and any depth', () => {
    for (const p of ['.ws-tmp-1', '.WS-TMP-1', '.Ws-Tmp-abc', 'a/.wS-tMp-x/b']) expect(() => wsRel(p), p).toThrow(/reserved/);
  });
});

describe('write', () => {
  it('creates folders and files, replaces, and returns sizes; the file has mode 0600 and folders 0700', async () => {
    const f = pf();
    expect(await f.write('proj', 'src/a/b.ts', 'hello')).toMatchObject({ bytes: 5, created: true });
    expect(await f.write('proj', 'src/a/b.ts', 'hello2')).toMatchObject({ bytes: 6, created: false });
    expect(readFileSync(join(proj, 'src/a/b.ts'), 'utf8')).toBe('hello2');
    expect(lstatSync(join(proj, 'src/a')).mode & 0o777).toBe(0o700);
    expect(readdirSync(join(proj, 'src/a'))).toEqual(['b.ts']); // no temp file left
  });
  it('refuses .npmrc in any case, any depth, and as a folder name (WS-C14)', async () => {
    const f = pf();
    for (const p of ['.npmrc', '.NPMRC', '.NpmRc', 'a/b/.npmrc', '.npmrc/x']) expect((await refuses(f.write('proj', p, 'x'))).message, p).toMatch(/\.npmrc/);
    expect(readdirSync(proj)).toEqual([]);
  });
  it('enforces 200 KB by bytes, not characters', async () => {
    const f = pf();
    await f.write('proj', 'ok.txt', 'a'.repeat(204_800));
    await refuses(f.write('proj', 'big.txt', 'a'.repeat(204_801)), /at most 204800 bytes/);
    await refuses(f.write('proj', 'wide.txt', '€'.repeat(70_000))); // 70 000 chars, 210 000 bytes
    expect(existsSync(join(proj, 'big.txt'))).toBe(false);
  });
  it('a symlink at the leaf pointing outside is refused and the target is untouched', async () => {
    symlinkSync(canary, join(proj, 'l.txt'));
    await refuses(pf().write('proj', 'l.txt', 'OVERWRITTEN'), /not a regular file/);
    expect(readFileSync(canary, 'utf8')).toBe('TOP-SECRET');
    expect(lstatSync(join(proj, 'l.txt')).isSymbolicLink()).toBe(true);
    expect(readdirSync(proj)).toEqual(['l.txt']);
  });
  it('a symlink as a parent component (and as the first entry under the root) is refused; nothing lands outside', async () => {
    symlinkSync(outside, join(proj, 'dir'));
    await refuses(pf().write('proj', 'dir/new.txt', 'x'), /symlink/);
    await refuses(pf().write('proj', 'dir/sub/new.txt', 'x'), /symlink/);
    expect(readdirSync(outside)).toEqual(['canary.txt']);
  });
  it('a symlink workspace folder itself is refused', async () => {
    rmSync(proj, { recursive: true });
    symlinkSync(outside, proj);
    await refuses(pf().write('proj', 'a.txt', 'x'), /real directory/);
    await refuses(pf().read('proj', 'canary.txt', 0, 100), /real directory/);
    expect(readdirSync(outside)).toEqual(['canary.txt']);
  });
  it('a hard-linked target and a FIFO target are refused', async () => {
    linkSync(canary, join(proj, 'h.txt'));
    await refuses(pf().write('proj', 'h.txt', 'x'), /hard-linked/);
    expect(readFileSync(canary, 'utf8')).toBe('TOP-SECRET');
    execFileSync('mkfifo', [join(proj, 'p')]);
    await refuses(pf().write('proj', 'p', 'x'), /not a regular file/);
  });
  it('a symlink loop on the path is refused', async () => {
    symlinkSync('b', join(proj, 'a'));
    symlinkSync('a', join(proj, 'b'));
    await refuses(pf().write('proj', 'a/x.txt', 'x'));
    await refuses(pf().write('proj', 'a', 'x'));
  });
});

describe('read', () => {
  it('reads a window with offsets, and the footer numbers are exact', async () => {
    await pf().write('proj', 'a.txt', '0123456789');
    expect(await pf().read('proj', 'a.txt', 0, 4)).toMatchObject({ text: '0123', from: 0, to: 4, size: 10, binary: false });
    expect(await pf().read('proj', 'a.txt', 4, 100)).toMatchObject({ text: '456789', from: 4, to: 10 });
    expect(await pf().read('proj', 'a.txt', 50, 10)).toMatchObject({ text: '', from: 50, to: 50, size: 10 });
  });
  it('caps one call at 64 KB', async () => {
    await pf().write('proj', 'big.txt', 'a'.repeat(150_000));
    const r = await pf().read('proj', 'big.txt', 0, 10_000_000);
    expect(r.text.length).toBe(WS_LIMITS.readMax);
    expect(r.size).toBe(150_000);
  });
  it('never splits a UTF-8 character at either end', async () => {
    await pf().write('proj', 'u.txt', 'a\u{1F600}b€'); // bytes: a(1) emoji(4) b(1) euro(3)
    for (let off = 0; off < 9; off++)
      for (let lim = 1; lim <= 9; lim++) {
        const r = await pf().read('proj', 'u.txt', off, lim);
        expect(r.text, `${off}/${lim}`).not.toContain('�');
        expect(Buffer.byteLength(r.text), `${off}/${lim}`).toBe(r.to - r.from);
      }
    expect((await pf().read('proj', 'u.txt', 0, 3)).text).toBe('a'); // cut inside the emoji
    expect((await pf().read('proj', 'u.txt', 2, 3)).text).toBe(''); // starts and ends inside the emoji
    expect((await pf().read('proj', 'u.txt', 2, 4)).text).toBe('b'); // drops the emoji tail, keeps b
  });
  it('a NUL byte means binary, no text', async () => {
    writeFileSync(join(proj, 'bin'), Buffer.from([1, 2, 0, 3]));
    expect(await pf().read('proj', 'bin', 0, 100)).toMatchObject({ binary: true, text: '' });
  });
  it('symlinks (leaf, parent, first-level folder), loops, FIFOs and hard links are refused and nothing is leaked', async () => {
    symlinkSync(canary, join(proj, 'leaf'));
    symlinkSync('/etc/passwd', join(proj, 'pw'));
    symlinkSync(outside, join(proj, 'dir'));
    symlinkSync('../../outside', join(proj, 'rel'));
    symlinkSync('x', join(proj, 'loop'));
    symlinkSync('loop', join(proj, 'x'));
    execFileSync('mkfifo', [join(proj, 'fifo')]);
    linkSync(canary, join(proj, 'hard'));
    for (const p of ['leaf', 'pw', 'dir/canary.txt', 'rel/canary.txt', 'loop', 'x', 'fifo', 'hard']) {
      const e = await refuses(pf().read('proj', p, 0, 100));
      expect(e.message, p).not.toContain('TOP-SECRET');
    }
  }, 10_000);
  it('a missing file and a directory are refused with fixed text', async () => {
    mkdirSync(join(proj, 'd'));
    await refuses(pf().read('proj', 'nope', 0, 10), /no such file/);
    await refuses(pf().read('proj', 'd', 0, 10), /not a regular file/);
  });
});

describe('list', () => {
  it('lists sorted, marks symlinks as not regular, never follows them, hides temp names in any case', async () => {
    await pf().write('proj', 'b.txt', 'x');
    mkdirSync(join(proj, 'a'));
    symlinkSync(outside, join(proj, 'c-link'));
    writeFileSync(join(proj, '.ws-tmp-1'), 'x');
    writeFileSync(join(proj, '.WS-TMP-2'), 'x');
    const r = await pf().list('proj', '');
    expect(r.entries).toEqual([
      { name: 'a', kind: 'dir', size: 0 },
      { name: 'b.txt', kind: 'file', size: 1 },
      { name: 'c-link', kind: 'other', size: 0 },
    ]);
    expect(r.more).toBe(false);
  });
  it('refuses a symlinked folder, a symlink in a parent component and a loop', async () => {
    symlinkSync(outside, join(proj, 'dir'));
    mkdirSync(join(proj, 'ok'));
    symlinkSync(outside, join(proj, 'ok', 'inner'));
    symlinkSync('loop2', join(proj, 'loop1'));
    symlinkSync('loop1', join(proj, 'loop2'));
    for (const p of ['dir', 'ok/inner', 'dir/x', 'loop1']) await refuses(pf().list('proj', p));
  });
  it('caps at 500 entries and says there are more', async () => {
    for (let i = 0; i < 520; i++) writeFileSync(join(proj, `f${String(i).padStart(4, '0')}`), '');
    const r = await pf().list('proj', '');
    expect(r.entries).toHaveLength(500);
    expect(r.more).toBe(true);
    expect(r.entries[0]!.name).toBe('f0000');
  });
  it('over the entry budget is E_QUOTA', async () => {
    for (let i = 0; i < 30; i++) writeFileSync(join(proj, `f${i}`), '');
    const e = await refuses(pf({ entryBudget: 20 }).list('proj', ''));
    expect(e).toBeInstanceOf(WsError);
    expect((e as WsError).code).toBe('E_QUOTA');
  });
});

describe('delete', () => {
  it('deletes a file, an empty folder; a non-empty folder needs recursive', async () => {
    await pf().write('proj', 'd/a.txt', 'x');
    await refuses(pf().delete('proj', 'd', false), /not empty/);
    await pf().delete('proj', 'd/a.txt', false);
    await pf().delete('proj', 'd', false);
    expect(readdirSync(proj)).toEqual([]);
    await refuses(pf().delete('proj', 'gone', false), /no such/);
  });
  it('a symlink entry is removed itself; its target is untouched', async () => {
    symlinkSync(canary, join(proj, 'l'));
    symlinkSync(outside, join(proj, 'ld'));
    await pf().delete('proj', 'l', false);
    await pf().delete('proj', 'ld', true); // recursive on a symlink entry: still only the entry
    expect(readdirSync(proj)).toEqual([]);
    expect(readFileSync(canary, 'utf8')).toBe('TOP-SECRET');
  });
  it('WS-C7: recursive delete of a folder holding a symlink to an outside folder leaves the outside canary', async () => {
    mkdirSync(join(proj, 'tree/sub'), { recursive: true });
    symlinkSync(outside, join(proj, 'tree/sub/out'));
    symlinkSync(canary, join(proj, 'tree/c'));
    writeFileSync(join(proj, 'tree/real.txt'), 'x');
    await pf().delete('proj', 'tree', true);
    expect(existsSync(join(proj, 'tree'))).toBe(false);
    expect(readFileSync(canary, 'utf8')).toBe('TOP-SECRET');
  });
  it('a symlink in any parent component is refused (recursive too); the outside is untouched', async () => {
    mkdirSync(join(outside, 'victim'));
    writeFileSync(join(outside, 'victim', 'f'), 'x');
    symlinkSync(outside, join(proj, 'dir'));
    for (const rec of [false, true]) {
      await refuses(pf().delete('proj', 'dir/victim', rec), /symlink/);
      await refuses(pf().delete('proj', 'dir/canary.txt', rec), /symlink/);
    }
    expect(readFileSync(canary, 'utf8')).toBe('TOP-SECRET');
    expect(existsSync(join(outside, 'victim', 'f'))).toBe(true);
  });
  it('a hard-linked name can be unlinked and the other name survives', async () => {
    linkSync(canary, join(proj, 'h'));
    await pf().delete('proj', 'h', false);
    expect(readFileSync(canary, 'utf8')).toBe('TOP-SECRET');
  });
});

describe('usage walk (WS-C8, WS-C9)', () => {
  it('counts every depth, temp files, symlinks as files, and keeps node_modules apart', async () => {
    const deep = join(proj, Array.from({ length: 20 }, () => 'd').join('/'));
    mkdirSync(deep, { recursive: true });
    writeFileSync(join(deep, 'a'), '12345');
    writeFileSync(join(proj, '.ws-tmp-1'), '123'); // a temp-prefixed file still counts
    symlinkSync(outside, join(proj, 'l'));
    mkdirSync(join(proj, 'node_modules/x'), { recursive: true });
    writeFileSync(join(proj, 'node_modules/x/i.js'), '1234567');
    mkdirSync(join(proj, 'sub/node_modules'), { recursive: true }); // only the top-level one is exempt
    writeFileSync(join(proj, 'sub/node_modules/n.js'), '12');
    expect(await pf().usage('proj')).toEqual({ bytes: 5 + 3 + 2, files: 4, nmBytes: 7, over: false });
  });
  it('does not follow symlinked folders or loops', async () => {
    mkdirSync(join(outside, 'many'));
    for (let i = 0; i < 50; i++) writeFileSync(join(outside, 'many', `f${i}`), 'x');
    symlinkSync(outside, join(proj, 'out'));
    symlinkSync('.', join(proj, 'self'));
    expect(await pf().usage('proj')).toMatchObject({ files: 2, bytes: 0, over: false });
  });
  it('3 000 files at depth 20 make the next write refuse with E_QUOTA', async () => {
    const deep = join(proj, Array.from({ length: 20 }, () => 'd').join('/'));
    mkdirSync(deep, { recursive: true });
    for (let i = 0; i < 3000; i++) writeFileSync(join(deep, `f${i}`), '');
    const e = await refuses(pf().write('proj', 'new.txt', 'x'));
    expect((e as WsError).code).toBe('E_QUOTA');
    await refuses(pf().assertUnderQuota('proj'));
    // a ws_delete brings it back under
    await pf().delete('proj', 'd', true);
    await pf().write('proj', 'new.txt', 'x');
  }, 30_000);
  it('the file limit is 2000 outside node_modules; node_modules files do not count toward it', async () => {
    for (let i = 0; i < 2000; i++) writeFileSync(join(proj, `f${i}`), '');
    await pf().assertUnderQuota('proj');
    expect((await refuses(pf().write('proj', 'one-more', 'x'))) as WsError).toMatchObject({ code: 'E_QUOTA' });
    await pf().write('proj', 'f5', 'replace is fine'); // replacing does not add a file
    rmSync(join(proj, 'f0'));
    mkdirSync(join(proj, 'node_modules'));
    for (let i = 0; i < 100; i++) writeFileSync(join(proj, 'node_modules', `m${i}`), '');
    await pf().write('proj', 'one-more', 'x');
  }, 30_000);
  it('the byte limit (300 MiB, apparent size) and the node_modules limit (1 GiB) refuse', async () => {
    truncateSync(openAndClose(join(proj, 'sparse')), WS_LIMITS.bytes - 10);
    await pf().write('proj', 'a', '1234567890'); // exactly at the limit
    await refuses(pf().write('proj', 'b', '1'));
    await pf().write('proj', 'a', 'x'); // replacing with a smaller file is allowed
    rmSync(join(proj, 'sparse'));
    mkdirSync(join(proj, 'node_modules'));
    truncateSync(openAndClose(join(proj, 'node_modules', 'big')), Math.floor(1.2 * 1024 ** 3)); // 1.2 GiB written by a run
    expect(((await refuses(pf().write('proj', 'c', '1'))) as WsError).code).toBe('E_QUOTA');
    expect(((await refuses(pf().assertUnderQuota('proj'))) as WsError).code).toBe('E_QUOTA');
    await pf().delete('proj', 'node_modules', true);
    await pf().assertUnderQuota('proj');
  });
  it('an entry budget or a time budget hit counts as over quota', async () => {
    for (let i = 0; i < 100; i++) writeFileSync(join(proj, `f${i}`), '');
    expect((await pf({ entryBudget: 50 }).usage('proj')).over).toBe(true);
    expect((await pf({ entryBudget: 1000 }).usage('proj')).over).toBe(false);
    let t = 0;
    expect((await pf({ timeBudgetMs: 100, now: () => (t += 1000) }).usage('proj')).over).toBe(true);
  });
  it('250 000 empty files give E_QUOTA at the real budget, and the walk stays within 150 MB of extra memory', async () => {
    const dir = join(proj, 'many');
    mkdirSync(dir);
    for (let i = 0; i < 250_000; i++) closeSync(openSync(join(dir, `f${i}`), 'w'));
    if (global.gc) global.gc();
    const before = process.memoryUsage().rss;
    let peak = before;
    const timer = setInterval(() => void (peak = Math.max(peak, process.memoryUsage().rss)), 5);
    const u = await pf().usage('proj');
    clearInterval(timer);
    expect(u.over).toBe(true);
    expect(((await refuses(pf().assertUnderQuota('proj'))) as WsError).code).toBe('E_QUOTA');
    expect(peak - before).toBeLessThan(150 * 1024 * 1024);
  }, 180_000);
});

function openAndClose(p: string): string {
  closeSync(openSync(p, 'w'));
  return p;
}
