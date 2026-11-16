import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { checkFiles, contentProblem, makeTar, packFiles, pathProblem, readTar, STATIC_LIMITS, type StaticFile } from './static.js';

const f = (path: string, s = '<p>hi</p>'): StaticFile => ({ path, data: Buffer.from(s) });
const site = [f('index.html'), f('css/a.css', 'a{}')];

describe('paths (V15)', () => {
  it.each(['../x.html', '/etc/x.html', '.env', 'a/.hidden.html', 'a//b.html', 'a b.html', 'deploy.yml', 'docker-compose.yml', 'Caddyfile', 'a.php', 'a.sh', 'noext', 'x'.repeat(101) + '.html'])('refuses %s', (p) => expect(pathProblem(p)).not.toBeNull());
  it.each(['index.html', 'css/app.min.css', 'img/a-b_c.PNG', 'fonts/x.woff2'])('accepts %s', (p) => expect(pathProblem(p)).toBeNull());
});

describe('checkFiles', () => {
  it('needs index.html, refuses duplicates and oversize', () => {
    expect(checkFiles(site)).toBeNull();
    expect(checkFiles([f('a.html')])).toMatch(/index\.html/);
    expect(checkFiles([f('index.html'), f('index.html')])).toMatch(/duplicate/);
    expect(checkFiles([f('index.html', 'x'.repeat(STATIC_LIMITS.fileBytes + 1))])).toMatch(/at most/);
    expect(checkFiles([f('index.html'), ...Array.from({ length: 2001 }, (_, i) => f(`f${i}.txt`, 'x'))])).toMatch(/files/);
  });
});

describe('content (spec: no secrets, no off-site scripts)', () => {
  it('refuses an inline token or key', () => {
    expect(contentProblem('index.html', Buffer.from('<p>token=ghp_abcdefghijklmnopqrstuvwxyz0123456789</p>'))).toMatch(/secret/);
    expect(contentProblem('a.js', Buffer.from('fetch("/x?api_key=abcdef0123456789");'))).toMatch(/secret/);
  });
  it('refuses a script from another host, allows relative and inline ones', () => {
    expect(contentProblem('index.html', Buffer.from('<script src="https://cdn.example.com/x.js"></script>'))).toMatch(/another site/);
    expect(contentProblem('index.html', Buffer.from('<script src="//cdn.example.com/x.js"></script>'))).toMatch(/another site/);
    expect(contentProblem('index.html', Buffer.from("<SCRIPT async src='http://x/y.js'>"))).toMatch(/another site/);
    expect(contentProblem('index.html', Buffer.from('<script src="app.js"></script><script>1</script>'))).toBeNull();
  });
});

describe('tar', () => {
  it('round-trips and is reproducible', () => {
    const t = makeTar(site);
    expect(t.equals(makeTar([...site].reverse()))).toBe(true);
    const r = readTar(t);
    expect(r.ok && r.files.map((x) => x.path)).toEqual(['css/a.css', 'index.html']);
  });
  it('packFiles returns the digest of the archive', () => {
    const p = packFiles(site);
    expect(p.ok && p.sha256).toBe(createHash('sha256').update(makeTar(site)).digest('hex'));
    expect(packFiles([f('index.html', 'ghp_abcdefghijklmnopqrstuvwxyz012345')]).ok).toBe(false);
  });
  it('refuses a symlink member, gzip, a corrupt header and a missing index', () => {
    const t = Buffer.from(makeTar(site));
    const sym = Buffer.from(t);
    sym[156] = '2'.charCodeAt(0); // first member becomes a symlink; checksum is now wrong -> refused either way
    expect(readTar(sym).ok).toBe(false);
    expect(readTar(Buffer.concat([Buffer.from([0x1f, 0x8b]), Buffer.alloc(2000)])).ok).toBe(false);
    expect(readTar(Buffer.alloc(2048, 7)).ok).toBe(false);
    expect(readTar(makeTar([f('a.html')])).ok).toBe(false);
  });
  it('refuses a correctly checksummed non-regular member', () => {
    const t = Buffer.from(makeTar(site));
    t[156] = '2'.charCodeAt(0);
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : t[i]!;
    t.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii');
    const r = readTar(t);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/type refused/);
  });
});
