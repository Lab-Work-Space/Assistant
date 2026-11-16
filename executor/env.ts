import { z } from 'zod';
import { LOG_LEVELS } from '../core/env.js';

/**
 * The executor's environment (Gate 1 S2, S6): it holds BOT_TOKEN_ADMIN and nothing else secret. It is read from its own env file
 * (~/.config/assistant/env.admin locally), never the main application's. Any other bot token in this environment is refused.
 */
export interface ExecutorEnv {
  token: string;
  databaseUrl: string;
  guildId: string;
  botAdminRoleId: string;
  socketPath: string;
  logLevel: string;
  /** Gate 1 V22: the deploy key (an ed25519 key file, 0600, owned by the executor's own macOS user); absent = VPS deploy is off. */
  deployKeyPath: string | null;
  /** OD-1: the socket directory is shared with the owner's ipc group (0750) and the socket is 0660; set by the launchd job only. */
  socketShared: boolean;
  /** Gate 1 self-code OD-2a: the release root (releases/, current, its own bare repo). Absent = code changes are off. */
  codeRoot: string | null;
  /** OD-5: the one Discord user who can confirm a protected-path code change. Absent = such changes are refused (fail closed). */
  ownerUserId: string | null;
  /** X16b: the root-owned, pinned compiler and package manager (outside any project tree). */
  tscPath: string | null;
  npmPath: string | null;
  /** X18: where the application's /healthz is (loopback only). */
  healthUrl: string | null;
}

const absPath = (max = 200) => z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), z.string().refine((s) => s.startsWith('/') && !s.includes('\0') && !s.includes('..') && s.length < max, { error: 'must be an absolute path' }).optional());
const snowflake = z.string().regex(/^\d{17,20}$/, 'must be a Discord snowflake');
const schema = z.object({
  BOT_TOKEN_ADMIN: z.string().trim().min(20, { error: 'is required' }),
  DATABASE_URL: z.string().min(1, { error: 'is required' }),
  GUILD_ID: z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), snowflake.default('1565649426943442944')),
  BOT_ADMIN_ROLE_ID: snowflake,
  EXECUTOR_SOCKET: z.string().refine((s) => s.startsWith('/') && !s.includes('\0') && s.length < 100, { error: 'must be an absolute path under 100 characters' }),
  EXECUTOR_SOCKET_SHARED: z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), z.enum(['0', '1']).default('0')),
  LW_DEPLOY_SSH_KEY_PATH: z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), z.string().refine((s) => s.startsWith('/') && !s.includes('\0') && s.length < 200, { error: 'must be an absolute path' }).optional()),
  LW_CODE_ROOT: absPath(),
  OWNER_USER_ID: z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), snowflake.optional()),
  LW_CODE_TSC: absPath(),
  LW_CODE_NPM: absPath(),
  LW_APP_HEALTH_URL: z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), z.string().regex(/^http:\/\/(?:127\.0\.0\.1|localhost):\d{2,5}\/healthz$/, { error: 'must be http://127.0.0.1:<port>/healthz' }).optional()),
  LOG_LEVEL: z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), z.enum(LOG_LEVELS).default('info')),
});

export function loadExecutorEnv(src: NodeJS.ProcessEnv = process.env): ExecutorEnv {
  const others = Object.keys(src).filter((k) => /^BOT_TOKEN_/.test(k) && k !== 'BOT_TOKEN_ADMIN' && src[k]);
  if (others.length) throw new Error('Invalid environment: the executor must not hold another bot token');
  for (const k of ['ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'CONFIG_MASTER_KEY', 'DEVJOB_ANTHROPIC_API_KEY']) if (src[k]) throw new Error(`Invalid environment: the executor must not hold ${k}`);
  // Gate 1 self-code X19 (OD-4a): the GitHub App key stays with the main application; the executor never pushes.
  const app = Object.keys(src).filter((k) => /^GITHUB_APP_/.test(k) && src[k]);
  if (app.length) throw new Error('Invalid environment: the executor must not hold a GitHub App credential');
  const p = schema.safeParse(src);
  if (!p.success) throw new Error(`Invalid environment: ${p.error.issues.map((i) => `${i.path.join('.') || 'env'}: ${i.message}`).join('; ')}`);
  const e = p.data;
  return { token: e.BOT_TOKEN_ADMIN, databaseUrl: e.DATABASE_URL, guildId: e.GUILD_ID, botAdminRoleId: e.BOT_ADMIN_ROLE_ID, socketPath: e.EXECUTOR_SOCKET, logLevel: e.LOG_LEVEL, deployKeyPath: e.LW_DEPLOY_SSH_KEY_PATH ?? null, socketShared: e.EXECUTOR_SOCKET_SHARED === '1',
    codeRoot: e.LW_CODE_ROOT ?? null, ownerUserId: e.OWNER_USER_ID ?? null, tscPath: e.LW_CODE_TSC ?? null, npmPath: e.LW_CODE_NPM ?? null, healthUrl: e.LW_APP_HEALTH_URL ?? null };
}

/** The socket both processes use. Short on purpose: macOS limits a Unix socket path to 104 bytes. */
export const DEFAULT_SOCKET_NAME = 'executor.sock';
