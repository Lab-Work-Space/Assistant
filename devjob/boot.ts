import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ModelProxyControl, SourcePort } from './service.js';
import type { Images } from './launcher.js';

/** The real ports of the dev-job service (Gate 1 self-code). The main application holds no model key: it only registers per-job credentials on the proxy's control port. */
export type ControlFetch = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export function proxyControl(o: { url: string; token: string; fetch: ControlFetch; ttlSec?: number }): ModelProxyControl {
  const headers = { authorization: `Bearer ${o.token}`, 'content-type': 'application/json' };
  return {
    async register(jobId, capUsd) {
      const r = await o.fetch(`${o.url}/jobs`, { method: 'POST', headers, body: JSON.stringify({ jobId, capUsd, ttlSec: o.ttlSec ?? 3600 }) });
      const j = (await r.json()) as { credential?: unknown };
      if (!r.ok || typeof j.credential !== 'string' || !/^dj-[0-9a-f]{48}$/.test(j.credential)) throw new Error('the model proxy refused the job');
      return j.credential;
    },
    async close(jobId) {
      const r = await o.fetch(`${o.url}/jobs/${jobId}`, { method: 'DELETE', headers });
      if (!r.ok) return null;
      const j = (await r.json()) as { spentUsd?: unknown };
      return typeof j.spentUsd === 'number' ? { spentUsd: j.spentUsd } : null;
    },
  };
}

const GIT_ENV = { PATH: process.env.PATH ?? '/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' };
/** Committed objects of the owner's repository only (never the working tree, never uncommitted changes). */
export function localSource(repoDir: string): SourcePort {
  const git = (...a: string[]): Buffer => execFileSync('git', ['-C', repoDir, ...a], { env: GIT_ENV, maxBuffer: 256 * 1024 * 1024 });
  return {
    baseSha: async () => git('rev-parse', '--verify', 'refs/heads/main^{commit}').toString('utf8').trim(),
    fullBundle: async (rev) => {
      if (!/^[0-9a-f]{40}$/.test(rev)) throw new Error('bad rev');
      const ref = `refs/devjob/${rev}`;
      git('update-ref', ref, rev);
      try { return git('bundle', 'create', '-', ref); } finally { git('update-ref', '-d', ref); }
    },
  };
}

export function loadImages(dir: string): Images {
  const j = JSON.parse(readFileSync(join(dir, 'docker', 'devjob', 'images.json'), 'utf8')) as Partial<Images>;
  for (const k of ['prep', 'agent', 'test'] as const) if (typeof j[k] !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(j[k]!)) throw new Error(`images.json: ${k} must be an image id (sha256:...)`);
  return j as Images;
}
