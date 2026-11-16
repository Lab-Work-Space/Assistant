import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadImages, localSource, proxyControl } from './boot.js';
import { makeRepo, type Repo } from './test-helpers.js';

let repo: Repo;
let d = '';
afterEach(() => { repo?.cleanup(); if (d) rmSync(d, { recursive: true, force: true }); });

describe('proxyControl', () => {
  it('registers with the bearer token and accepts only a well-formed credential; close returns the spend', async () => {
    const seen: { url: string; method: string; auth: string; body?: string }[] = [];
    const c = proxyControl({ url: 'http://127.0.0.1:8788', token: 't'.repeat(40), fetch: async (url, i) => (seen.push({ url, method: i.method, auth: i.headers.authorization!, ...(i.body ? { body: i.body } : {}) }), { ok: true, status: 200, json: async () => (i.method === 'POST' ? { credential: `dj-${'a'.repeat(48)}` } : { spentUsd: 0.42 }) }) });
    expect(await c.register('J-0123456789abcdef', 2)).toBe(`dj-${'a'.repeat(48)}`);
    expect(JSON.parse(seen[0]!.body!)).toMatchObject({ jobId: 'J-0123456789abcdef', capUsd: 2 });
    expect(JSON.parse(seen[0]!.body!)).not.toHaveProperty('monthlyCapUsd');
    expect(seen[0]!.auth).toBe(`Bearer ${'t'.repeat(40)}`);
    expect(await c.close('J-0123456789abcdef')).toEqual({ spentUsd: 0.42 });
    const bad = proxyControl({ url: 'http://x', token: 't', fetch: async () => ({ ok: true, status: 200, json: async () => ({ credential: 'sk-ant-real' }) }) });
    await expect(bad.register('J-0123456789abcdef', 1)).rejects.toThrow();
    const down = proxyControl({ url: 'http://x', token: 't', fetch: async () => ({ ok: false, status: 500, json: async () => ({}) }) });
    expect(await down.close('J-0123456789abcdef')).toBeNull();
  });
});

describe('localSource', () => {
  it('bundles committed objects of main only, and leaves no ref behind', async () => {
    repo = makeRepo();
    const s = localSource(repo.dir);
    expect(await s.baseSha()).toBe(repo.head());
    writeFileSync(join(repo.dir, 'uncommitted.txt'), 'secret');
    const b = await s.fullBundle(repo.head());
    expect(b.subarray(0, 16).toString()).toContain('# v2 git bundle');
    expect(b.includes(Buffer.from('uncommitted'))).toBe(false);
    expect(execFileSync('git', ['-C', repo.dir, 'for-each-ref', 'refs/devjob'], { env: { PATH: process.env.PATH ?? '' } }).toString()).toBe('');
    await expect(s.fullBundle('--output=x')).rejects.toThrow();
  });
});

describe('loadImages', () => {
  it('requires image ids', () => {
    d = mkdtempSync(join(tmpdir(), 'img-'));
    mkdirSync(join(d, 'docker/devjob'), { recursive: true });
    const id = (c: string) => `sha256:${c.repeat(64)}`;
    writeFileSync(join(d, 'docker/devjob/images.json'), JSON.stringify({ prep: id('a'), agent: id('b'), test: id('c') }));
    expect(loadImages(d).agent).toBe(id('b'));
    writeFileSync(join(d, 'docker/devjob/images.json'), JSON.stringify({ prep: 'node:latest', agent: id('b'), test: id('c') }));
    expect(() => loadImages(d)).toThrow(/prep/);
  });
});
