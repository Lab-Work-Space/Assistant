import { z } from 'zod';

export const DEPT_IDS = ['hq', 'rnd', 'software', 'it', 'marketing', 'sales', 'hr', 'finance', 'ops', 'praw'] as const;
export type DeptId = (typeof DEPT_IDS)[number];

export const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;

export interface Env {
  databaseUrl: string;
  anthropicApiKey?: string;
  /** ANTHROPIC-WS: optional workspace id (wrkspc_...) sent as anthropic-workspace-id for organization-scoped keys. Not a secret; still never logged. */
  anthropicWorkspaceId?: string;
  geminiApiKey?: string;
  configMasterKey: Buffer;
  guildId: string;
  botAdminRoleId: string;
  healthPort: number;
  healthHost: string;
  logLevel: string;
  botTokens: Partial<Record<DeptId, string>>;
  /** Praw's workspace directory (P18); relative paths resolve against the working directory. Default data/workspace/praw. */
  prawWorkspaceDir?: string;
  /** WS-1: WS_ROOT (absolute, no NUL) or unset (default ~/.config/assistant/workspaces). Validated again by workspaces/boot.ts. */
  wsRoot?: string;
  /** RFMD P3: DOCS_DIR (absolute) or unset (default data/documents under the working directory). */
  docsDir?: string;
  /**
   * ClickUp (Task 25, CLICKUP-ALL-1 C3, CLICKUP-MULTI-1). Mode `list`: CLICKUP_API_TOKEN + CLICKUP_LIST_ID (CLICKUP_TEAM_ID is ignored; `teamAllIgnored` is set when it was `all`, so the app can warn).
   * Mode `workspace`: CLICKUP_API_TOKEN + an explicit CLICKUP_TEAM_ID (digits: one workspace; `all`: `teams: 'all'`, never an id string) and NO list id.
   * A token alone leaves the group off: removing a setting never widens access.
   */
  clickup?:
    | { apiToken: string; listId: string; teamId?: undefined; teams?: undefined; teamAllIgnored?: true }
    | { apiToken: string; teamId: string; listId?: undefined; teams?: undefined; teamAllIgnored?: undefined }
    | { apiToken: string; teams: 'all'; listId?: undefined; teamId?: undefined; teamAllIgnored?: undefined };
  /** Google Sheets export (Task 33): present only when both GOOGLE_SHEETS_WEBAPP_URL and GOOGLE_SHEETS_WEBAPP_SECRET are set; the URL is shape-checked where it is used (tools/plugins/ocr/sheets.ts). */
  googleSheets?: { url: string; secret: string };
  /** GitHub App (Task 29): app id, the one installation id and the key (PEM text, or the path of a 0600 PEM file; the path wins when both are set). The github group is off otherwise. */
  github?: { appId: string; installationId: string; privateKey?: string; privateKeyPath?: string };
  /** Music (Task 36, P7): optional path of a cookies file (throwaway account, mounted read-only 0600); yt-dlp only gets a per-call copy. */
  ytDlpCookiesFile?: string;
  /** The media sidecar's unix socket (absolute path; production /run/media-ipc/media.sock). Unset: local yt-dlp/ffmpeg, refused in a container. */
  mediaSocket?: string;
  /** Gate 1 Part C: local mode reads the web through Chrome in a container. Raw values; tools/plugins/web/boot.ts validates them (loopback http only). Unset on the VPS. */
  chrome?: { cdpUrl?: string; controlUrl?: string; minVersion?: string; token?: string };
  /** RFMD P3 (RF15): the document renderer, a separate Chrome with no route. Raw values; tools/plugins/docs/boot.ts validates them (loopback http only). Unset on the VPS. */
  render?: { cdpUrl?: string; token?: string };
  /** Phase 2 (Gate 1 S2): the Unix socket of the separate executor "LW Admin" (absolute, short). Unset: server operations are off. The executor's token is never here. */
  executorSocket?: string;
  /** Self-code (Gate 1 self-code X1, X26): the main application holds NO model key for dev jobs; it reaches the model proxy's control port with this token and owns a source repository and a scratch directory. */
  devjob?: { proxyControlUrl: string; proxyToken: string; sourceRepo: string; workDir: string };
}

const snowflake = z.string().regex(/^\d{17,20}$/, 'must be a Discord snowflake');
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

// Treat empty strings as absent so `.env` templates with blank values work.
const blankToUndef = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? undefined : v);

const schema = z.object({
  DATABASE_URL: z.preprocess(blankToUndef, z.string({ error: 'is required' }).min(1)),
  ANTHROPIC_API_KEY: z.preprocess(blankToUndef, z.string().optional()),
  ANTHROPIC_WORKSPACE_ID: z.preprocess(blankToUndef, z.string().regex(/^wrkspc_[A-Za-z0-9]{10,64}$/, 'invalid format').optional()),
  GEMINI_API_KEY: z.preprocess(blankToUndef, z.string().optional()),
  CONFIG_MASTER_KEY: z.preprocess(
    blankToUndef,
    z
      .string({ error: 'is required' })
      .refine((s) => BASE64.test(s) && Buffer.from(s, 'base64').length === 32, {
        error: 'must be base64 encoding of exactly 32 bytes',
      }),
  ),
  GUILD_ID: z.preprocess(blankToUndef, snowflake.default('1565649426943442944')),
  BOT_ADMIN_ROLE_ID: z.preprocess(blankToUndef, snowflake),
  HEALTH_PORT: z.preprocess(blankToUndef, z.coerce.number().int().min(1).max(65535).default(8080)),
  HEALTH_HOST: z.preprocess(blankToUndef, z.ipv4().default('127.0.0.1')),
  LOG_LEVEL: z.preprocess(blankToUndef, z.enum(LOG_LEVELS).default('info')),
  CLICKUP_API_TOKEN: z.preprocess(blankToUndef, z.string().trim().optional()),
  CLICKUP_LIST_ID: z.preprocess(blankToUndef, z.string().trim().regex(/^[a-z0-9]{1,32}$/, 'must be a ClickUp list id').optional()),
  // CLICKUP-MULTI-1: digits (one workspace) or exactly `all` (every workspace the token sees). Trimmed first; `ALL` and `All` are refused (the message names the key, never the value).
  CLICKUP_TEAM_ID: z.preprocess(blankToUndef, z.string().trim().regex(/^(?:\d{1,20}|all)$/, 'must be a ClickUp workspace (team) id or the word all').optional()),
  GITHUB_APP_ID: z.preprocess(blankToUndef, z.string().trim().optional()),
  GITHUB_INSTALLATION_ID: z.preprocess(blankToUndef, z.string().trim().optional()),
  GITHUB_APP_PRIVATE_KEY: z.preprocess(blankToUndef, z.string().optional()),
  GITHUB_APP_PRIVATE_KEY_PATH: z.preprocess(blankToUndef, z.string().trim().refine((s) => !s.includes('\0'), { error: 'must not contain NUL' }).optional()),
  GOOGLE_SHEETS_WEBAPP_URL: z.preprocess(blankToUndef, z.string().trim().optional()),
  GOOGLE_SHEETS_WEBAPP_SECRET: z.preprocess(blankToUndef, z.string().trim().optional()),
  YTDLP_COOKIES_FILE: z.preprocess(blankToUndef, z.string().trim().refine((s) => s.startsWith('/') && !s.includes('\0'), { error: 'must be an absolute path' }).optional()),
  MEDIA_SOCKET: z.preprocess(blankToUndef, z.string().trim().refine((s) => s.startsWith('/') && !s.includes('\0'), { error: 'must be an absolute path' }).optional()),
  CHROME_CDP_URL: z.preprocess(blankToUndef, z.string().trim().optional()),
  CHROME_PROXY_CONTROL_URL: z.preprocess(blankToUndef, z.string().trim().optional()),
  CHROME_ACCESS_TOKEN: z.preprocess(blankToUndef, z.string().trim().optional()),
  // RFMD P3 / RF15: the document renderer's DevTools forwarder (a separate Chrome from CHROME_*). Set by scripts/dev.sh for the node child only.
  RENDER_CDP_URL: z.preprocess(blankToUndef, z.string().trim().optional()),
  RENDER_ACCESS_TOKEN: z.preprocess(blankToUndef, z.string().trim().optional()),
  CHROME_MIN_VERSION: z.preprocess(blankToUndef, z.string().trim().optional()),
  DEVJOB_PROXY_CONTROL_URL: z.preprocess(blankToUndef, z.string().trim().regex(/^http:\/\/(?:127\.0\.0\.1|localhost):\d{2,5}$/, { error: 'must be http://127.0.0.1:<port>' }).optional()),
  DEVJOB_PROXY_TOKEN: z.preprocess(blankToUndef, z.string().trim().min(32).optional()),
  DEVJOB_SOURCE_REPO: z.preprocess(blankToUndef, z.string().trim().refine((s) => s.startsWith('/') && !s.includes('\0'), { error: 'must be an absolute path' }).optional()),
  DEVJOB_WORK_DIR: z.preprocess(blankToUndef, z.string().trim().refine((s) => s.startsWith('/') && !s.includes('\0'), { error: 'must be an absolute path' }).optional()),
  EXECUTOR_SOCKET: z.preprocess(blankToUndef, z.string().trim().refine((s) => s.startsWith('/') && !s.includes('\0') && s.length < 100, { error: 'must be an absolute path under 100 characters' }).optional()),
  // RFMD P3 (D-04): where department documents are kept; an absolute path, default <cwd>/data/documents (checked by tools/plugins/docs/root.ts).
  DOCS_DIR: z.preprocess(blankToUndef, z.string().refine((s) => !s.includes('\0') && s.startsWith('/'), { error: 'must be an absolute path without NUL' }).optional()),
  WS_ROOT: z.preprocess(blankToUndef, z.string().refine((s) => s.startsWith('/') && !s.includes('\0'), { error: 'must be an absolute path without NUL' }).optional()),
  PRAW_WORKSPACE_DIR: z.preprocess(blankToUndef, z.string().refine((s) => !s.includes('\0'), { error: 'must not contain NUL' }).default('data/workspace/praw')),
});

/** Parse and validate environment. Error messages never include the offending values. */
export function loadEnv(src: NodeJS.ProcessEnv = process.env): Env {
  // Gate 1 S2 (option A): the executor's token lives in the executor's own environment only. The main application refuses to start with it
  // (a token here would share the secret domain of every other token and defeat the separation).
  if (typeof src.BOT_TOKEN_ADMIN === 'string' && src.BOT_TOKEN_ADMIN.trim() !== '') {
    throw new Error('Invalid environment: BOT_TOKEN_ADMIN belongs to the separate executor (env.admin) and must not be set here');
  }
  // Gate 1 self-code X1: the dev-job model key belongs to the model proxy container alone. A copy here would sit beside every other secret of this process.
  if (typeof src.DEVJOB_ANTHROPIC_API_KEY === 'string' && src.DEVJOB_ANTHROPIC_API_KEY.trim() !== '') {
    throw new Error('Invalid environment: DEVJOB_ANTHROPIC_API_KEY belongs to the model proxy container and must not be set here');
  }
  // G2-PV-06: the Anthropic SDK reads these from the environment (extra request headers; tracing, which could put prompts into spans that bypass the masking logger).
  // The client is built with tracing off explicitly; a value set here is a mistake or an injection, so the boot refuses it (the key name only, never the value).
  for (const k of Object.keys(src)) {
    if ((k === 'ANTHROPIC_CUSTOM_HEADERS' || k.startsWith('ANTHROPIC_OPEN_TELEMETRY')) && typeof src[k] === 'string' && src[k]!.trim() !== '') {
      throw new Error(`Invalid environment: ${k} must not be set (the Anthropic client is configured in code)`);
    }
  }
  const parsed = schema.safeParse(src);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join('.') || 'env'}: ${i.message}`).join('; ');
    throw new Error(`Invalid environment: ${detail}`);
  }
  const e = parsed.data;
  const botTokens: Partial<Record<DeptId, string>> = {};
  for (const id of DEPT_IDS) {
    const t = src[`BOT_TOKEN_${id.toUpperCase()}`];
    if (typeof t === 'string' && t.trim() !== '') botTokens[id] = t.trim();
  }
  return {
    databaseUrl: e.DATABASE_URL,
    anthropicApiKey: e.ANTHROPIC_API_KEY,
    ...(e.ANTHROPIC_WORKSPACE_ID ? { anthropicWorkspaceId: e.ANTHROPIC_WORKSPACE_ID } : {}),
    geminiApiKey: e.GEMINI_API_KEY,
    configMasterKey: Buffer.from(e.CONFIG_MASTER_KEY, 'base64'),
    guildId: e.GUILD_ID,
    botAdminRoleId: e.BOT_ADMIN_ROLE_ID,
    healthPort: e.HEALTH_PORT,
    healthHost: e.HEALTH_HOST,
    logLevel: e.LOG_LEVEL,
    botTokens,
    prawWorkspaceDir: e.PRAW_WORKSPACE_DIR,
    ...(e.WS_ROOT ? { wsRoot: e.WS_ROOT } : {}),
    ...(e.DOCS_DIR ? { docsDir: e.DOCS_DIR } : {}),
    ...(e.EXECUTOR_SOCKET ? { executorSocket: e.EXECUTOR_SOCKET } : {}),
    ...(e.DEVJOB_PROXY_CONTROL_URL && e.DEVJOB_PROXY_TOKEN && e.DEVJOB_SOURCE_REPO && e.DEVJOB_WORK_DIR ? { devjob: { proxyControlUrl: e.DEVJOB_PROXY_CONTROL_URL, proxyToken: e.DEVJOB_PROXY_TOKEN, sourceRepo: e.DEVJOB_SOURCE_REPO, workDir: e.DEVJOB_WORK_DIR } } : {}),
    ...(e.YTDLP_COOKIES_FILE ? { ytDlpCookiesFile: e.YTDLP_COOKIES_FILE } : {}),
    ...(e.MEDIA_SOCKET ? { mediaSocket: e.MEDIA_SOCKET } : {}),
    ...(e.CHROME_CDP_URL || e.CHROME_PROXY_CONTROL_URL
      ? { chrome: { ...(e.CHROME_CDP_URL ? { cdpUrl: e.CHROME_CDP_URL } : {}), ...(e.CHROME_PROXY_CONTROL_URL ? { controlUrl: e.CHROME_PROXY_CONTROL_URL } : {}), ...(e.CHROME_MIN_VERSION ? { minVersion: e.CHROME_MIN_VERSION } : {}), ...(e.CHROME_ACCESS_TOKEN ? { token: e.CHROME_ACCESS_TOKEN } : {}) } }
      : {}),
    ...(e.RENDER_CDP_URL ? { render: { cdpUrl: e.RENDER_CDP_URL, ...(e.RENDER_ACCESS_TOKEN ? { token: e.RENDER_ACCESS_TOKEN } : {}) } } : {}),
    ...(() => {
      // malformed ids leave the group off (the startup alert says why) instead of stopping the whole app
      if (!e.GITHUB_APP_ID || !/^[A-Za-z0-9]{1,40}$/.test(e.GITHUB_APP_ID) || !e.GITHUB_INSTALLATION_ID || !/^\d{1,20}$/.test(e.GITHUB_INSTALLATION_ID)) return {};
      const key = e.GITHUB_APP_PRIVATE_KEY_PATH ? { privateKeyPath: e.GITHUB_APP_PRIVATE_KEY_PATH } : e.GITHUB_APP_PRIVATE_KEY ? { privateKey: e.GITHUB_APP_PRIVATE_KEY } : null;
      return key ? { github: { appId: e.GITHUB_APP_ID, installationId: e.GITHUB_INSTALLATION_ID, ...key } } : {};
    })(),
    ...(e.GOOGLE_SHEETS_WEBAPP_URL && e.GOOGLE_SHEETS_WEBAPP_SECRET ? { googleSheets: { url: e.GOOGLE_SHEETS_WEBAPP_URL, secret: e.GOOGLE_SHEETS_WEBAPP_SECRET } } : {}),
    ...(e.CLICKUP_API_TOKEN && e.CLICKUP_LIST_ID
      ? { clickup: { apiToken: e.CLICKUP_API_TOKEN, listId: e.CLICKUP_LIST_ID, ...(e.CLICKUP_TEAM_ID === 'all' ? { teamAllIgnored: true as const } : {}) } }
      : e.CLICKUP_API_TOKEN && e.CLICKUP_TEAM_ID === 'all' ? { clickup: { apiToken: e.CLICKUP_API_TOKEN, teams: 'all' as const } }
      : e.CLICKUP_API_TOKEN && e.CLICKUP_TEAM_ID ? { clickup: { apiToken: e.CLICKUP_API_TOKEN, teamId: e.CLICKUP_TEAM_ID } } : {}),
  };
}
