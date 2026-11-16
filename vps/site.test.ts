import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { packWorkspaceDir } from './site.js';
import { readTar } from './static.js';

function ws() {
  const root = mkdtempSync(join(tmpdir(), 'ws-'));
  mkdirSync(join(root, 'site/css'), { recursive: true });
  writeFileSync(join(root, 'site/index.html'), '<h1>hi</h1><link rel="stylesheet" href="css/a.css">');
  writeFileSync(join(root, 'site/css/a.css'), 'h1{color:red}');
  return root;
}

describe('packWorkspaceDir', () => {
  it('packs a folder so that the folder itself is the site root', async () => {
    const p = await packWorkspaceDir(ws(), 'site');
    if (!p.ok) throw new Error(p.error);
    const back = readTar(p.tar);
    expect(back.ok && back.files.map((f) => f.path)).toEqual(['css/a.css', 'index.html']);
    expect(p.files).toBe(2);
  });
  it('refuses a dotfile, a secret, an off-site script and a missing index', async () => {
    let r = ws();
    writeFileSync(join(r, 'site/.env'), 'A=1');
    expect(await packWorkspaceDir(r, 'site')).toMatchObject({ ok: false });
    r = ws();
    writeFileSync(join(r, 'site/app.js'), 'const t="ghp_abcdefghijklmnopqrstuvwxyz0123456789"');
    expect(await packWorkspaceDir(r, 'site')).toMatchObject({ ok: false, error: expect.stringContaining('secret') });
    r = ws();
    writeFileSync(join(r, 'site/index.html'), '<script src="https://evil.example/x.js"></script>');
    expect(await packWorkspaceDir(r, 'site')).toMatchObject({ ok: false, error: expect.stringContaining('another site') });
    r = ws();
    writeFileSync(join(r, 'site/index.html'), 'x');
    mkdirSync(join(r, 'empty'));
    expect(await packWorkspaceDir(r, 'empty')).toMatchObject({ ok: false });
  });
  it('refuses a symlink in the folder (the sandbox lists it as "other")', async () => {
    const r = ws();
    symlinkSync('/etc/passwd', join(r, 'site/link.html'));
    expect(await packWorkspaceDir(r, 'site')).toMatchObject({ ok: false });
  });
  it('refuses a path outside the workspace', async () => {
    expect(await packWorkspaceDir(ws(), '../etc')).toMatchObject({ ok: false });
  });
});
