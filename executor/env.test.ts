import { describe, expect, it } from 'vitest';
import { loadExecutorEnv } from './env.js';

const base = { BOT_TOKEN_ADMIN: 'x'.repeat(30), DATABASE_URL: 'postgres://u@127.0.0.1/db', BOT_ADMIN_ROLE_ID: '1'.repeat(18), EXECUTOR_SOCKET: '/tmp/e.sock' };

describe('executor env (self-code X19, OD-5)', () => {
  it('refuses the dev-job model key and any GitHub App credential', () => {
    expect(() => loadExecutorEnv({ ...base, DEVJOB_ANTHROPIC_API_KEY: 'sk-ant-x' })).toThrow(/DEVJOB_ANTHROPIC_API_KEY/);
    expect(() => loadExecutorEnv({ ...base, GITHUB_APP_PRIVATE_KEY: 'k' })).toThrow(/GitHub App/);
    expect(() => loadExecutorEnv({ ...base, GITHUB_APP_ID: '1' })).toThrow(/GitHub App/);
    expect(() => loadExecutorEnv({ ...base, ANTHROPIC_API_KEY: 'k' })).toThrow(/ANTHROPIC_API_KEY/);
  });
  it('code settings are optional; the owner id must be a snowflake; paths must be absolute without ..', () => {
    expect(loadExecutorEnv(base)).toMatchObject({ codeRoot: null, ownerUserId: null, tscPath: null, npmPath: null, healthUrl: null });
    const ok = loadExecutorEnv({ ...base, LW_CODE_ROOT: '/var/lw/code', OWNER_USER_ID: '2'.repeat(18), LW_CODE_TSC: '/usr/local/lib/lwadmin/tsc.js', LW_CODE_NPM: '/usr/local/bin/npm', LW_APP_HEALTH_URL: 'http://127.0.0.1:8080/healthz' });
    expect(ok).toMatchObject({ codeRoot: '/var/lw/code', ownerUserId: '2'.repeat(18), healthUrl: 'http://127.0.0.1:8080/healthz' });
    expect(() => loadExecutorEnv({ ...base, OWNER_USER_ID: 'me' })).toThrow();
    expect(() => loadExecutorEnv({ ...base, LW_CODE_ROOT: 'relative' })).toThrow();
    expect(() => loadExecutorEnv({ ...base, LW_CODE_ROOT: '/a/../b' })).toThrow();
    expect(() => loadExecutorEnv({ ...base, LW_APP_HEALTH_URL: 'http://evil.example/healthz' })).toThrow();
  });
});
