import { describe as d, expect, it } from 'vitest';
import { DeployRequest, StoredDeploy, ReadRequest, deriveName, describe, parseReply, previewName, requestLine, vpsRequest, readRequest, resolveRequest, resultRequest, urlOf } from './ops.js';

const SHA = 'a'.repeat(40);
/** Shared with infra/vps/tests/assistant_core_test.py (PREVIEW_VECTORS): the card shows the address the Mac computes, the VPS creates its own. They must agree. */
const PREVIEW_VECTORS: [string, string, string][] = [
  ['blog', 'feat/x', 'blog--feat-x'],
  ['blog', 'Feat/New_UI', 'blog--feat-new-ui'],
  ['blog', 'a'.repeat(80), 'blog--aaaaaaaaaaaaaaaaaaa-0f45e8'],
  ['shop', 'feature/very-long-branch-name-for-checkout', 'shop--feature-very-long-b-128a15'],
  ['a', 'b--c', 'a--b-c'],
  ['my-long-base-name', 'release/2026-11-02', 'my-long-base-name--releas-e53947'],
  ['x', 'Fix/#123 (urgent)!', 'x--fix-123-urgent'],
  ['blog', 'feat/a' + 'b'.repeat(30) + '1', 'blog--feat-abbbbbbbbbbbbb-8267d9'],
  ['blog', 'feat/a' + 'b'.repeat(30) + '2', 'blog--feat-abbbbbbbbbbbbb-29e7e0'],
  ['blog', 'dependabot/npm_and_yarn/lodash-4.17.21', 'blog--dependabot-npm-and-b7180b'],
  ['a'.repeat(20), 'b'.repeat(30), 'a'.repeat(20) + '--bbb-7a3f7d'],
];

d('DeployRequest (V6)', () => {
  it.each([
    [{ op: 'add', repo: 'my-site', category: 'apps' }],
    [{ op: 'add', repo: 'api_x', category: 'api', name: 'x', branch: 'feat/a' }],
    [{ op: 'redeploy', app: 'apps/blog' }],
    [{ op: 'remove', app: 'api/x' }],
    [{ op: 'preview', repo: 'blog', branch: 'feat/x', ttlHours: 168 }],
    [{ op: 'publish_static', name: 'landing', category: 'apps', sha256: 'b'.repeat(64), size: 10 }],
  ])('accepts %j', (v) => expect(DeployRequest.safeParse(v).success).toBe(true));
  it.each([
    ['foreign org', { op: 'add', repo: 'Evil/x', category: 'apps' }],
    ['url', { op: 'add', repo: 'https://github.com/x/y', category: 'apps' }],
    ['leading dash', { op: 'add', repo: '-x', category: 'apps' }],
    ['leading dot', { op: 'add', repo: '.x', category: 'apps' }],
    ['main', { op: 'add', repo: 'x', category: 'main' }],
    ['setting', { op: 'add', repo: 'x', category: 'setting' }],
    ['static as api (G2VD-02)', { op: 'publish_static', name: 'a', category: 'api', sha256: 'b'.repeat(64), size: 5 }],
    ['name --', { op: 'add', repo: 'x', category: 'apps', name: 'a--b' }],
    ['branch ..', { op: 'preview', repo: 'x', branch: 'a/../b' }],
    ['branch //', { op: 'preview', repo: 'x', branch: 'a//b' }],
    ['branch @{', { op: 'preview', repo: 'x', branch: 'a@{1}' }],
    ['branch .lock', { op: 'preview', repo: 'x', branch: 'a.lock' }],
    ['branch trailing /', { op: 'preview', repo: 'x', branch: 'a/' }],
    ['branch leading -', { op: 'preview', repo: 'x', branch: '-a' }],
    ['ttl 169', { op: 'preview', repo: 'x', branch: 'a', ttlHours: 169 }],
    ['app main', { op: 'remove', app: 'main/x' }],
    ['unknown key', { op: 'remove', app: 'apps/x', force: true }],
    ['unknown op', { op: 'exec', cmd: 'id' }],
    ['sha supplied by the model', { op: 'add', repo: 'x', category: 'apps', sha: SHA }],
    ['size 0', { op: 'publish_static', name: 'a', category: 'apps', sha256: 'b'.repeat(64), size: 0 }],
    ['size over 50 MiB', { op: 'publish_static', name: 'a', category: 'apps', sha256: 'b'.repeat(64), size: 50 * 1024 * 1024 + 1 }],
  ])('refuses %s', (_n, v) => expect(DeployRequest.safeParse(v).success).toBe(false));
});

d('StoredDeploy and the request line (V22)', () => {
  it('requires the approved sha for add, redeploy and preview', () => {
    expect(StoredDeploy.safeParse({ op: 'add', repo: 'x', category: 'apps', name: 'x' }).success).toBe(false);
    expect(StoredDeploy.safeParse({ op: 'add', repo: 'x', category: 'apps', name: 'x', sha: SHA }).success).toBe(true);
    expect(StoredDeploy.safeParse({ op: 'add', repo: 'x', category: 'apps', sha: SHA }).success).toBe(false); // the card always carries the final name
    expect(StoredDeploy.safeParse({ op: 'redeploy', app: 'apps/x', sha: 'zz' }).success).toBe(false);
  });
  it('builds the exact VPS request, ASCII, with the card id', () => {
    const r = vpsRequest({ op: 'preview', repo: 'blog', branch: 'feat/x', sha: SHA, ttlHours: 24, base: 'blog', name: 'blog--feat-x' }, 'abc123');
    expect(requestLine(r)).toBe(`{"op":"preview","card_id":"abc123","repo":"blog","branch":"feat/x","sha":"${SHA}","base":"blog","ttl_hours":24}\n`);
    expect(vpsRequest({ op: 'remove', app: 'apps/x' }, 'c')).toEqual({ op: 'remove', card_id: 'c', app: 'apps/x' });
    expect(() => vpsRequest({ op: 'remove', app: 'apps/x' }, 'bad id')).toThrow();
  });
  it('refuses a non-ASCII or oversize line', () => {
    expect(() => requestLine({ a: 'é' })).toThrow();
    expect(() => requestLine({ a: 'x'.repeat(5000) })).toThrow();
  });
  it('read, resolve and result requests', () => {
    expect(readRequest(ReadRequest.parse({ kind: 'logs', app: 'apps/x' }), 'c')).toEqual({ op: 'logs', card_id: 'c', app: 'apps/x', lines: 100 });
    expect(ReadRequest.safeParse({ kind: 'logs', app: 'apps/x', lines: 201 }).success).toBe(false);
    expect(resolveRequest('blog', 'main', 'c')).toEqual({ op: 'resolve', card_id: 'c', repo: 'blog', branch: 'main' });
    expect(() => resolveRequest('a/b', 'main', 'c')).toThrow();
    expect(() => resultRequest('nope', 'c')).toThrow();
  });
});

d('names the card shows (V14, V22)', () => {
  it.each(PREVIEW_VECTORS)('previewName(%s, %s) = %s, the same as the VPS', (b, br, want) => expect(previewName(b, br)).toBe(want));
  it('refuses what the VPS refuses', () => {
    expect(previewName('a--b', 'x')).toBeNull();
    expect(previewName('blog', '///')).toBeNull();
    expect(previewName('x'.repeat(30), 'feature')).toBeNull();
  });
  it('deriveName gives a valid name or nothing', () => {
    expect(deriveName('My_Site.v2')).toBe('my-site-v2');
    expect(deriveName('a'.repeat(40))).toBe('a'.repeat(32));
    expect(deriveName('---')).toBeNull();
  });
});

d('describe and urlOf', () => {
  it('shows the exact op, sha and URL', () => {
    expect(describe({ op: 'add', repo: 'blog', category: 'apps', name: 'blog', sha: SHA }).neu).toContain('Lab-Work-Space/blog@aaaaaaaaaaaa');
    expect(describe({ op: 'add', repo: 'blog', category: 'apps', name: 'blog', sha: SHA }).neu).toContain('https://blog.labworkspace.net/');
    expect(describe({ op: 'preview', repo: 'blog', branch: 'feat/x', sha: SHA, base: 'blog', name: 'blog--feat-x' }).neu).toContain('https://blog--feat-x.labworkspace.net/');
    expect(describe({ op: 'publish_static', name: 'landing', category: 'apps', sha256: 'b'.repeat(64), size: 2048 }).neu).toContain('https://landing.labworkspace.net/');
    expect(urlOf('apps', 'x')).toBe('https://x.labworkspace.net/');
  });
});

d('parseReply', () => {
  it('parses OK and ERR', () => {
    expect(parseReply('OK {"queued":"J-0123456789abcdef"}\n')).toEqual({ ok: true, data: { queued: 'J-0123456789abcdef' } });
    expect(parseReply('ERR TAR\n')).toEqual({ ok: false, code: 'TAR' });
  });
  it('refuses anything else', () => {
    expect(parseReply('hello')).toEqual({ ok: false, code: 'BAD_REPLY' });
    expect(parseReply('OK []')).toEqual({ ok: false, code: 'BAD_REPLY' });
    expect(parseReply('OK {\u0001}')).toEqual({ ok: false, code: 'BAD_REPLY' });
  });
});
