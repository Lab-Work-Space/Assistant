import { describe, expect, it } from 'vitest';
import { loadEnv } from './env.js';

const key32 = Buffer.alloc(32, 7).toString('base64');
const base = {
  DATABASE_URL: 'postgres://u:p@localhost:5432/db',
  CONFIG_MASTER_KEY: key32,
  BOT_ADMIN_ROLE_ID: '1565649426943442999',
};

describe('loadEnv', () => {
  it('throws when DATABASE_URL missing', () => {
    const { DATABASE_URL: _omit, ...rest } = base;
    expect(() => loadEnv(rest)).toThrow(/DATABASE_URL/);
  });

  it('maps BOT_TOKEN_HQ to botTokens.hq and omits absent tokens', () => {
    const env = loadEnv({ ...base, BOT_TOKEN_HQ: 'tok-hq', BOT_TOKEN_RND: '' });
    expect(env.botTokens).toEqual({ hq: 'tok-hq' });
    expect('rnd' in env.botTokens).toBe(false);
  });

  it('maps BOT_TOKEN_PRAW to botTokens.praw', () => {
    expect(loadEnv({ ...base, BOT_TOKEN_PRAW: ' tok-praw ' }).botTokens).toEqual({ praw: 'tok-praw' });
  });

  it('PRAW_WORKSPACE_DIR defaults to data/workspace/praw; blank is the default (P18)', () => {
    expect(loadEnv(base).prawWorkspaceDir).toBe('data/workspace/praw');
    expect(loadEnv({ ...base, PRAW_WORKSPACE_DIR: ' ' }).prawWorkspaceDir).toBe('data/workspace/praw');
    expect(loadEnv({ ...base, PRAW_WORKSPACE_DIR: '/app/data/workspace/praw' }).prawWorkspaceDir).toBe('/app/data/workspace/praw');
  });

  it('WS_ROOT: absolute only, no NUL, blank or unset is absent (WS-1)', () => {
    expect('wsRoot' in loadEnv(base)).toBe(false);
    expect('wsRoot' in loadEnv({ ...base, WS_ROOT: '  ' })).toBe(false);
    expect(loadEnv({ ...base, WS_ROOT: '/Users/x/.config/assistant/workspaces' }).wsRoot).toBe('/Users/x/.config/assistant/workspaces');
    expect(() => loadEnv({ ...base, WS_ROOT: 'relative/dir' })).toThrow(/WS_ROOT/);
    expect(() => loadEnv({ ...base, WS_ROOT: '/a\0b' })).toThrow(/WS_ROOT/);
  });

  it('MEDIA_SOCKET relative path refused; blank absent', () => {
    expect(loadEnv({ ...base, MEDIA_SOCKET: '/run/media-ipc/media.sock' }).mediaSocket).toBe('/run/media-ipc/media.sock');
    expect('mediaSocket' in loadEnv(base)).toBe(false);
    expect('mediaSocket' in loadEnv({ ...base, MEDIA_SOCKET: '  ' })).toBe(false);
    for (const bad of ['run/media.sock', './media.sock', 'media.sock', '/run/x\0y'])
      expect(() => loadEnv({ ...base, MEDIA_SOCKET: bad })).toThrow(/MEDIA_SOCKET: must be an absolute path/);
    try {
      loadEnv({ ...base, MEDIA_SOCKET: 'relative/planted-value' });
    } catch (e) {
      expect((e as Error).message).not.toContain('planted-value');
    }
  });

  it('GEMINI_API_KEY blank is absent', () => {
    expect(loadEnv({ ...base, GEMINI_API_KEY: '' }).geminiApiKey).toBeUndefined();
    expect(loadEnv({ ...base, GEMINI_API_KEY: '   ' }).geminiApiKey).toBeUndefined();
    expect(loadEnv({ ...base }).geminiApiKey).toBeUndefined();
    expect(loadEnv({ ...base, GEMINI_API_KEY: 'AIzaX' }).geminiApiKey).toBe('AIzaX');
  });

  it('decodes CONFIG_MASTER_KEY and rejects length != 32', () => {
    const env = loadEnv(base);
    expect(env.configMasterKey.equals(Buffer.alloc(32, 7))).toBe(true);
    const short = Buffer.alloc(16, 1).toString('base64');
    expect(() => loadEnv({ ...base, CONFIG_MASTER_KEY: short })).toThrow(/CONFIG_MASTER_KEY/);
    expect(() => loadEnv({ ...base, CONFIG_MASTER_KEY: 'not base64!!' })).toThrow(/CONFIG_MASTER_KEY/);
  });

  it('throws when CONFIG_MASTER_KEY missing', () => {
    const { CONFIG_MASTER_KEY: _omit, ...rest } = base;
    expect(() => loadEnv(rest)).toThrow(/CONFIG_MASTER_KEY/);
  });

  it('requires BOT_ADMIN_ROLE_ID as a snowflake and exposes botAdminRoleId', () => {
    const { BOT_ADMIN_ROLE_ID: _omit, ...rest } = base;
    expect(() => loadEnv(rest)).toThrow(/BOT_ADMIN_ROLE_ID/);
    expect(() => loadEnv({ ...base, BOT_ADMIN_ROLE_ID: 'Bot Admin' })).toThrow(/BOT_ADMIN_ROLE_ID/);
    expect(loadEnv(base).botAdminRoleId).toBe('1565649426943442999');
  });

  it('applies defaults for guild, health port, log level', () => {
    const env = loadEnv(base);
    expect(env.guildId).toBe('1565649426943442944');
    expect(env.healthPort).toBe(8080);
    expect(env.healthHost).toBe('127.0.0.1');
    expect(env.logLevel).toBe('info');
    expect(env.anthropicApiKey).toBeUndefined();
  });

  it('HEALTH_HOST accepts an IPv4 address, treats blank as default, and rejects junk', () => {
    expect(loadEnv({ ...base, HEALTH_HOST: '0.0.0.0' }).healthHost).toBe('0.0.0.0');
    expect(loadEnv({ ...base, HEALTH_HOST: '' }).healthHost).toBe('127.0.0.1');
    for (const bad of ['localhost', 'not an ip', '999.1.1.1', '0.0.0.0:80']) {
      expect(() => loadEnv({ ...base, HEALTH_HOST: bad })).toThrow(/HEALTH_HOST/);
    }
  });

  it('does not leak secret values in error messages', () => {
    const bad = 'sk-ant-supersecretvalue1234';
    try {
      loadEnv({ ...base, CONFIG_MASTER_KEY: bad });
      expect.unreachable();
    } catch (e) {
      expect(String(e)).not.toContain(bad);
    }
  });

  it('GITHUB_* give Env.github only with app id, installation id and a key or key path; path wins', () => {
    const g = { GITHUB_APP_ID: '123456', GITHUB_INSTALLATION_ID: '987654' };
    expect(loadEnv(base).github).toBeUndefined();
    expect(loadEnv({ ...base, ...g }).github).toBeUndefined();
    expect(loadEnv({ ...base, ...g, GITHUB_APP_PRIVATE_KEY: 'pem' }).github).toEqual({ appId: '123456', installationId: '987654', privateKey: 'pem' });
    expect(loadEnv({ ...base, ...g, GITHUB_APP_PRIVATE_KEY_PATH: '/k/app.pem' }).github).toEqual({ appId: '123456', installationId: '987654', privateKeyPath: '/k/app.pem' });
    expect(loadEnv({ ...base, ...g, GITHUB_APP_PRIVATE_KEY: 'pem', GITHUB_APP_PRIVATE_KEY_PATH: '/k/app.pem' }).github?.privateKey).toBeUndefined();
    expect(loadEnv({ ...base, ...g, GITHUB_INSTALLATION_ID: 'abc', GITHUB_APP_PRIVATE_KEY: 'pem' }).github).toBeUndefined();
    expect(loadEnv({ ...base, ...g, GITHUB_APP_ID: 'a b', GITHUB_APP_PRIVATE_KEY: 'pem' }).github).toBeUndefined();
  });

  it('CLICKUP-MULTI-1: CLICKUP_TEAM_ID=all gives teams:all (never an id string); trimmed; ALL and All throw naming the key and never the value; a token alone stays off; a list wins over all', () => {
    const tok = { ...base, CLICKUP_API_TOKEN: 'pk_1_X' };
    expect(loadEnv({ ...tok, CLICKUP_TEAM_ID: 'all' }).clickup).toEqual({ apiToken: 'pk_1_X', teams: 'all' });
    expect(loadEnv({ ...tok, CLICKUP_TEAM_ID: ' all ' }).clickup).toEqual({ apiToken: 'pk_1_X', teams: 'all' });
    expect(loadEnv({ ...tok, CLICKUP_LIST_ID: ' ', CLICKUP_TEAM_ID: 'all' }).clickup).toEqual({ apiToken: 'pk_1_X', teams: 'all' });
    for (const bad of ['ALL', 'All', 'aLL', 'all workspaces', 'alll']) {
      let msg = '';
      try { loadEnv({ ...tok, CLICKUP_TEAM_ID: bad }); } catch (e) { msg = (e as Error).message; }
      expect(msg, bad).toMatch(/CLICKUP_TEAM_ID/);
      expect(msg, bad).not.toContain(bad);
    }
    expect(loadEnv({ ...base, CLICKUP_TEAM_ID: 'all' }).clickup).toBeUndefined(); // no token: off
    expect(loadEnv({ ...tok }).clickup).toBeUndefined(); // a token alone: off
    // CM-C5 b: list wins; the flag lets the app warn once, with no value in it
    const both = loadEnv({ ...tok, CLICKUP_LIST_ID: '9018', CLICKUP_TEAM_ID: 'all' }).clickup;
    expect(both).toEqual({ apiToken: 'pk_1_X', listId: '9018', teamAllIgnored: true });
    expect(loadEnv({ ...tok, CLICKUP_LIST_ID: '9018', CLICKUP_TEAM_ID: '123' }).clickup).toEqual({ apiToken: 'pk_1_X', listId: '9018' }); // numeric: unchanged shape
  });

  it('CLICKUP_API_TOKEN + CLICKUP_LIST_ID give Env.clickup; either alone or blank is absent', () => {
    expect(loadEnv(base).clickup).toBeUndefined();
    expect(loadEnv({ ...base, CLICKUP_API_TOKEN: 'pk_1_X' }).clickup).toBeUndefined();
    expect(loadEnv({ ...base, CLICKUP_LIST_ID: '9018' }).clickup).toBeUndefined();
    expect(loadEnv({ ...base, CLICKUP_API_TOKEN: ' ', CLICKUP_LIST_ID: '9018' }).clickup).toBeUndefined();
    expect(loadEnv({ ...base, CLICKUP_API_TOKEN: ' pk_1_X ', CLICKUP_LIST_ID: '9018' }).clickup).toEqual({ apiToken: 'pk_1_X', listId: '9018' });
    expect(() => loadEnv({ ...base, CLICKUP_API_TOKEN: 'pk_1_X', CLICKUP_LIST_ID: '../x' })).toThrow(/CLICKUP_LIST_ID/);
  });

  it('C3 mode matrix: token only = disabled; token+list = list (team id ignored); token+team, no list = workspace; a bad team id names the key, not the value', () => {
    expect(loadEnv({ ...base, CLICKUP_API_TOKEN: 'pk_1_X' }).clickup).toBeUndefined();
    expect(loadEnv({ ...base, CLICKUP_API_TOKEN: 'pk_1_X', CLICKUP_LIST_ID: '9018' }).clickup).toEqual({ apiToken: 'pk_1_X', listId: '9018' });
    expect(loadEnv({ ...base, CLICKUP_API_TOKEN: 'pk_1_X', CLICKUP_LIST_ID: '9018', CLICKUP_TEAM_ID: '123' }).clickup).toEqual({ apiToken: 'pk_1_X', listId: '9018' });
    expect(loadEnv({ ...base, CLICKUP_API_TOKEN: 'pk_1_X', CLICKUP_TEAM_ID: ' 123 ' }).clickup).toEqual({ apiToken: 'pk_1_X', teamId: '123' });
    expect(loadEnv({ ...base, CLICKUP_API_TOKEN: 'pk_1_X', CLICKUP_LIST_ID: ' ', CLICKUP_TEAM_ID: '123' }).clickup).toEqual({ apiToken: 'pk_1_X', teamId: '123' }); // a blank list id is no list id
    expect(loadEnv({ ...base, CLICKUP_TEAM_ID: '123' }).clickup).toBeUndefined(); // no token
    let msg = '';
    try { loadEnv({ ...base, CLICKUP_API_TOKEN: 'pk_1_X', CLICKUP_TEAM_ID: 'SECRET-abc' }); } catch (e) { msg = (e as Error).message; }
    expect(msg).toMatch(/CLICKUP_TEAM_ID/);
    expect(msg).not.toContain('SECRET-abc');
  });
});

describe('G2-PV-06: SDK env knobs refused at boot', () => {
  it.each(['ANTHROPIC_CUSTOM_HEADERS', 'ANTHROPIC_OPEN_TELEMETRY', 'ANTHROPIC_OPEN_TELEMETRY_PROPAGATION', 'ANTHROPIC_OPEN_TELEMETRY_TRACES_CONTENT_MODE', 'ANTHROPIC_OPEN_TELEMETRY_TRACES_MAX_CONTENT_BYTES'])('%s is refused without echoing the value', (k) => {
    expect(() => loadEnv({ ...base, [k]: 'secret-value-xyz' })).toThrow(new RegExp(k));
    try { loadEnv({ ...base, [k]: 'secret-value-xyz' }); } catch (e) { expect(String(e)).not.toContain('secret-value-xyz'); }
  });
  it('a blank value is accepted', () => expect(() => loadEnv({ ...base, ANTHROPIC_CUSTOM_HEADERS: ' ' })).not.toThrow());
});


describe('ANTHROPIC-WS: ANTHROPIC_WORKSPACE_ID', () => {
  const ok = 'wrkspc_0123456789AbCdEf';
  it('a valid id is exposed', () => expect(loadEnv({ ...base, ANTHROPIC_WORKSPACE_ID: ok }).anthropicWorkspaceId).toBe(ok));
  it('absent or blank is undefined', () => {
    expect(loadEnv({ ...base }).anthropicWorkspaceId).toBeUndefined();
    expect(loadEnv({ ...base, ANTHROPIC_WORKSPACE_ID: ' ' }).anthropicWorkspaceId).toBeUndefined();
  });
  it.each(['wrkspc_short', 'ws_0123456789AbCdEf', 'wrkspc_0123456789-bad!', `wrkspc_${'a'.repeat(65)}`, 'SECRET-abc'])('%s is refused naming the key only', (v) => {
    expect(() => loadEnv({ ...base, ANTHROPIC_WORKSPACE_ID: v })).toThrow(/ANTHROPIC_WORKSPACE_ID/);
    try { loadEnv({ ...base, ANTHROPIC_WORKSPACE_ID: v }); } catch (e) { expect(String(e)).not.toContain(v); }
  });
});
