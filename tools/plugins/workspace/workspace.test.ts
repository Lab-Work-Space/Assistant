import { existsSync, linkSync, readdirSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LIMITS, SandboxError, TMP_PREFIX, Workspace, openInWorkspace, validateRel } from './sandbox.js';

let base: string;
let root: string;
let outside: string;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'praw-ws-'));
  root = join(base, 'ws');
  outside = join(base, 'outside');
  mkdirSync(outside);
  writeFileSync(join(outside, 'secret.txt'), 'top secret');
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

const refused = async (p: Promise<unknown>) => expect(p).rejects.toBeInstanceOf(SandboxError);

describe('validateRel (P18)', () => {
  it('../ and absolute refused', async () => {
    for (const bad of ['../x', 'a/../../x', 'a/..', '..', '/etc/passwd', '/', 'a//b', './a', 'a/./b', '', 'a/']) {
      expect(() => validateRel(bad), bad).toThrow(SandboxError);
    }
    expect(validateRel('notes/2026 plan.md')).toEqual(['notes', '2026 plan.md']);
    const ws = new Workspace(root);
    await refused(ws.read('../outside/secret.txt'));
    await refused(ws.write('../outside/new.txt', 'x', false));
    await refused(ws.write('/tmp/abs.txt', 'x', false));
    expect(existsSync(join(outside, 'new.txt'))).toBe(false);
  });

  it('NUL and odd characters refused', () => {
    for (const bad of ['a\0b', 'a\\b', 'a:b', 'ไฟล์.txt', 'a\nb', 'a*b', '$HOME', '~/x', 'a|b', `${TMP_PREFIX}abc`, 'd/' + TMP_PREFIX + 'x']) {
      expect(() => validateRel(bad), JSON.stringify(bad)).toThrow(SandboxError);
    }
    expect(() => validateRel('a/b/c/d/e/f')).not.toThrow();
    expect(() => validateRel('a/b/c/d/e/f/g')).toThrow(/depth/);
    expect(() => validateRel('x'.repeat(LIMITS.relLength))).not.toThrow();
    expect(() => validateRel('x'.repeat(LIMITS.relLength + 1))).toThrow(/long/);
  });
});

describe('Workspace sandbox (AC8)', () => {
  it('writes, reads and lists inside the workspace; root and new dirs are 0700', async () => {
    const ws = new Workspace(root);
    expect(await ws.write('notes/today.md', 'hello', false)).toEqual({ bytes: 5, created: true });
    expect(readFileSync(join(root, 'notes', 'today.md'), 'utf8')).toBe('hello');
    expect((await ws.read('notes/today.md', 100)).text).toBe('hello');
    expect(statSync(root).mode & 0o777).toBe(0o700);
    expect(statSync(join(root, 'notes')).mode & 0o777).toBe(0o700);
    expect(statSync(join(root, 'notes', 'today.md')).mode & 0o777).toBe(0o600);
    expect((await ws.list('')).map((e) => [e.name, e.kind])).toEqual([['notes', 'dir']]);
    expect((await ws.list('notes')).map((e) => e.name)).toEqual(['today.md']);
    await refused(ws.write('notes/today.md', 'again', false)); // exists, overwrite not asked
    expect(await ws.write('notes/today.md', 'again', true)).toEqual({ bytes: 5, created: false });
    expect(readFileSync(join(root, 'notes', 'today.md'), 'utf8')).toBe('again');
  });

  it('symlink component refused (AC8)', async () => {
    const ws = new Workspace(root);
    await ws.write('keep.txt', 'k', false);
    symlinkSync(outside, join(root, 'link'));
    symlinkSync(join(outside, 'secret.txt'), join(root, 'final.txt'));
    await refused(ws.read('link/secret.txt'));
    await refused(ws.write('link/new.txt', 'x', false));
    await refused(ws.list('link'));
    await refused(ws.read('final.txt'));
    await refused(ws.write('final.txt', 'x', true));
    expect(readFileSync(join(outside, 'secret.txt'), 'utf8')).toBe('top secret');
    expect(existsSync(join(outside, 'new.txt'))).toBe(false);
    expect((await ws.list('')).find((e) => e.name === 'link')?.kind).toBe('other');
  });

  it('a non-directory component is refused', async () => {
    const ws = new Workspace(root);
    await ws.write('file.txt', 'x', false);
    await refused(ws.write('file.txt/inner.txt', 'y', false));
    await refused(ws.read('file.txt/inner.txt'));
  });

  it('symlink swapped in after check refused', async () => {
    // A parent directory is replaced by a symlink to outside between the component checks and the open.
    const swapDir = () => {
      renameSync(join(root, 'docs'), join(base, 'docs-moved'));
      symlinkSync(outside, join(root, 'docs'));
    };
    mkdirSync(root, { recursive: true, mode: 0o700 });
    mkdirSync(join(root, 'docs'), { mode: 0o700 });
    writeFileSync(join(root, 'docs', 'secret.txt'), 'inside');
    const reader = new Workspace(root, { afterCheck: swapDir });
    await refused(reader.read('docs/secret.txt', 100));

    rmSync(join(root, 'docs'));
    renameSync(join(base, 'docs-moved'), join(root, 'docs'));
    const writer = new Workspace(root, { afterCheck: swapDir });
    await refused(writer.write('docs/new.txt', 'escaped', false));
    expect(readdirSync(outside)).toEqual(['secret.txt']); // no new file and no temp file left outside
    expect(readFileSync(join(outside, 'secret.txt'), 'utf8')).toBe('top secret');
    expect(readFileSync(join(base, 'docs-moved', 'secret.txt'), 'utf8')).toBe('inside');

    // The final file swapped for a symlink after the checks: O_NOFOLLOW refuses it.
    mkdirSync(join(root, 'f'), { mode: 0o700 });
    writeFileSync(join(root, 'f', 'a.txt'), 'a');
    const swapFile = () => {
      rmSync(join(root, 'f', 'a.txt'));
      symlinkSync(join(outside, 'secret.txt'), join(root, 'f', 'a.txt'));
    };
    await refused(new Workspace(root, { afterCheck: swapFile }).read('f/a.txt', 100));
    await refused(openInWorkspace(root, 'f/a.txt', 'r'));
  });

  it('hard-linked file (nlink 2) refused', async () => {
    const ws = new Workspace(root);
    await ws.write('a.txt', 'shared', false);
    linkSync(join(root, 'a.txt'), join(root, 'b.txt'));
    await refused(ws.read('a.txt'));
    await refused(ws.read('b.txt'));
    await refused(ws.write('a.txt', 'changed', true));
    expect(readFileSync(join(root, 'b.txt'), 'utf8')).toBe('shared');
  });

  it('quota exceeded refused (1 MB file, 50 MB, 500 files)', async () => {
    const ws = new Workspace(root);
    await refused(ws.write('big.bin', 'x'.repeat(LIMITS.fileBytes + 1), false));
    // Bytes, not characters: 3-byte characters just over the cap are refused.
    await refused(ws.write('thai.txt', 'ก'.repeat(Math.floor(LIMITS.fileBytes / 3) + 1), false));
    expect((await ws.write('max.bin', 'x'.repeat(LIMITS.fileBytes), false)).bytes).toBe(LIMITS.fileBytes);
    expect(LIMITS).toMatchObject({ fileBytes: 1_048_576, totalBytes: 50 * 1_048_576, files: 500 });

    const small = new Workspace(join(base, 'small'), { limits: { totalBytes: 10, files: 3 } });
    await small.write('a', '12345', false);
    await small.write('b', '1234', false);
    await refused(small.write('c', '12', false)); // 11 bytes > 10
    expect(await small.write('a', '123456', true)).toMatchObject({ created: false }); // replacing counts the old size out
    await small.write('c', '', false);
    await refused(small.write('d', '', false)); // a fourth file
    expect(await small.usage()).toEqual({ bytes: 10, files: 3 });
  });

  it('concurrent writes cannot both pass the quota', async () => {
    const small = new Workspace(join(base, 'race'), { limits: { totalBytes: 10, files: 10 } });
    const r = await Promise.allSettled([small.write('a', '123456', false), small.write('b', '123456', false)]);
    expect(r.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    expect((await small.usage()).bytes).toBe(6);
  });

  it('temp files are hidden, a failed write leaves none behind', async () => {
    const ws = new Workspace(root);
    await ws.write('a.txt', 'a', false);
    await refused(ws.write('a.txt', 'b', false));
    expect((await ws.list('')).map((e) => e.name)).toEqual(['a.txt']);
    expect(readdirSync(root).filter((n) => n.startsWith(TMP_PREFIX))).toEqual([]);
  });

  it('read truncates at the byte cap without splitting a character and flags binary content', async () => {
    const ws = new Workspace(root);
    await ws.write('t.txt', 'กขค', false); // 9 bytes
    expect(await ws.read('t.txt', 4)).toEqual({ text: 'ก', size: 9, truncated: true, binary: false });
    writeFileSync(join(root, 'bin'), Buffer.from([0x41, 0x00, 0x42]));
    expect((await ws.read('bin', 100)).binary).toBe(true);
  });
});

describe('WS-1 (SA-1 C12): the optional path limits leave Praw unchanged', () => {
  it('defaults stay depth 6, 120 characters and the .praw-tmp- prefix (now matched in any case)', () => {
    expect(() => validateRel(Array.from({ length: 6 }, () => 'd').join('/'))).not.toThrow();
    expect(() => validateRel(Array.from({ length: 7 }, () => 'd').join('/'))).toThrow(/depth is at most 6/);
    expect(() => validateRel('a'.repeat(121))).toThrow(/too long/);
    for (const p of ['.praw-tmp-x', '.PRAW-TMP-x', 'a/.Praw-Tmp-1']) expect(() => validateRel(p), p).toThrow(/reserved/);
    expect(() => validateRel('.ws-tmp-x')).not.toThrow(); // ws's prefix is only reserved for ws
  });
  it('the options widen only what they name', () => {
    expect(() => validateRel(Array.from({ length: 12 }, () => 'd').join('/'), { depth: 12 })).not.toThrow();
    expect(() => validateRel('a'.repeat(240), { relLength: 240 })).not.toThrow();
    expect(() => validateRel('a'.repeat(121), { depth: 12 })).toThrow(/too long/);
    expect(() => validateRel('.praw-tmp-x', { tmpPrefix: '.ws-tmp-' })).not.toThrow();
    expect(() => validateRel('.WS-tmp-x', { tmpPrefix: '.ws-tmp-' })).toThrow(/reserved/);
  });
  it('openInWorkspace honours the options: a deep write works and its temp file uses the given prefix', async () => {
    const deep = Array.from({ length: 10 }, () => 'd').join('/');
    await expect(openInWorkspace(root, `${deep}/f.txt`, 'w')).rejects.toBeInstanceOf(SandboxError); // default depth 6
    const w = await openInWorkspace(root, `${deep}/f.txt`, 'w', {}, { depth: 12, relLength: 240, tmpPrefix: '.ws-tmp-' });
    expect(readdirSync(join(root, deep)).every((n) => n.startsWith('.ws-tmp-'))).toBe(true);
    await w.fh.write('x', 0);
    await w.commit(true);
    expect(readFileSync(join(root, deep, 'f.txt'), 'utf8')).toBe('x');
    expect(readdirSync(join(root, deep))).toEqual(['f.txt']);
  });
});
