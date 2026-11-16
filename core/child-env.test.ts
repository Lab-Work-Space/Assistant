import { existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { childEnv, withChildEnv } from './child-env.js';

const SECRETS = ['BOT_TOKEN_PRAW', 'BOT_TOKEN_HQ', 'GEMINI_API_KEY', 'CLICKUP_API_TOKEN', 'JIRA_API_TOKEN', 'GITHUB_APP_PRIVATE_KEY', 'GOOGLE_SHEETS_WEBAPP_SECRET', 'DATABASE_URL', 'CONFIG_MASTER_KEY', 'NODE_OPTIONS'];

describe('core', () => {
  it('childEnv never contains BOT_TOKEN_*, GEMINI_API_KEY, CLICKUP_API_TOKEN, JIRA_API_TOKEN, GITHUB_APP_PRIVATE_KEY, GOOGLE_SHEETS_WEBAPP_SECRET, DATABASE_URL, CONFIG_MASTER_KEY, NODE_OPTIONS', () => {
    const saved = { ...process.env };
    for (const k of SECRETS) process.env[k] = 'planted-secret';
    try {
      const { env, cleanup } = childEnv();
      cleanup();
      expect(Object.keys(env).every((k) => ['HOME', 'LANG', 'PATH', 'TMPDIR'].includes(k))).toBe(true);
      for (const k of SECRETS) expect(env).not.toHaveProperty(k);
      expect(JSON.stringify(env)).not.toContain('planted-secret');
      expect(env.HOME).toBeTruthy();
      expect(env.HOME).not.toBe(saved.HOME ?? '\0');
      const f = childEnv({ FOO: 'bar', HOME: '/etc' });
      f.cleanup();
      expect(f.env.FOO).toBe('bar');
      expect(f.env.HOME).not.toBe('/etc');
      for (const k of SECRETS) expect(() => childEnv({ [k]: 'x' })).toThrow();
    } finally {
      for (const k of SECRETS) delete process.env[k];
    }
  });
});

describe('childEnv HOME', () => {
  it('is a private per-call 0700 dir, never the shared tmpdir, removed by cleanup', () => {
    const a = childEnv();
    const b = childEnv();
    try {
      expect(a.env.HOME).not.toBe(b.env.HOME);
      for (const e of [a, b]) {
        expect(e.env.HOME).not.toBe(tmpdir());
        expect(statSync(e.env.HOME!).mode & 0o777).toBe(0o700);
      }
    } finally {
      a.cleanup();
      b.cleanup();
    }
    expect(existsSync(a.env.HOME!)).toBe(false);
    expect(existsSync(b.env.HOME!)).toBe(false);
  });

  it('withChildEnv removes the home even when the callback throws', async () => {
    let home = '';
    await expect(withChildEnv({}, async (e) => { home = e.HOME!; throw new Error('x'); })).rejects.toThrow('x');
    expect(existsSync(home)).toBe(false);
  });
});
