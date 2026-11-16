import { pino, type DestinationStream, type Logger } from 'pino';

export type { Logger };

const MASK = '[REDACTED]';

// Key names (compared case-insensitively, ignoring _ and -) whose value is masked whatever its type.
const SECRET_KEY = /(token|apikey|authorization|password|secret|ciphertext|webhookurl|key|privatekey|pem|cookies?|jwt|signature)$/;

function isSecretKey(rawKey: string, value: unknown): boolean {
  const k = rawKey.toLowerCase().replace(/[_-]/g, '');
  if (SECRET_KEY.test(k)) return true;
  // a map of tokens (e.g. Env.botTokens)
  return k.endsWith('tokens') && typeof value === 'object' && value !== null;
}

const TEXT_PATTERNS: Array<[RegExp, string]> = [
  // PEM blocks (service-account / GitHub App private keys, T29), whole block including the base64 body
  [/-----BEGIN [A-Z0-9 ]+-----[\s\S]*?(?:-----END [A-Z0-9 ]+-----|$)/g, MASK],
  // GitHub tokens: installation (ghs_), personal (ghp_), user/oauth/refresh (ghu_/gho_/ghr_), T29, P10
  [/\bgh[pousr]_[A-Za-z0-9_.-]{16,}/g, MASK], // `.` and `-` too: the stateless `ghs_<appid>_<hdr>.<payload>.<sig>` form
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, MASK],
  // JWTs, before the discord-token pattern that could otherwise eat part of one
  [/eyJ[\w-]{5,}\.[\w-]{5,}\.[\w-]*/g, MASK],
  [/AIza[\w-]{20,}/g, MASK],
  // newer Google API key format: `AQ.` + ~50 chars; the dot and >=20 tail keep ordinary text out
  [/\bAQ\.[\w-]{20,}/g, MASK],
  // `key=` style query / form params (Gemini REST puts the API key in the URL)
  [/(^|[?&;,\s"'])((?:api_?)?key|access_token|token)=[^&\s"'<>]+/gi, `$1$2=${MASK}`],
  // Netscape cookie-jar lines (7 tab-separated fields) and Cookie headers
  [/^[^\t\r\n]*\t(?:TRUE|FALSE)\t[^\t\r\n]*\t(?:TRUE|FALSE)\t-?\d+\t[^\t\r\n]+\t[^\r\n]*$/gm, MASK],
  [/\b(Set-Cookie|Cookie):[^\r\n]*/gi, `$1: ${MASK}`],
  // Gemini thought signatures are opaque replay tokens: never logged, even inside serialised JSON
  [/("?thought_?signature"?\s*[:=]\s*"?)[^"\s,}]+/gi, `$1${MASK}`],
  // webhook urls first: their token part would otherwise be partially matched by later patterns
  [/https?:\/\/(?:(?:canary|ptb)\.)?discord(?:app)?\.com\/api(?:\/v\d+)?\/webhooks\/\d+\/[\w-]+/gi, MASK],
  [/\bBot\s+[\w.-]{20,}/g, `Bot ${MASK}`],
  // G2BL-06: anchored at the start of a word run, so a long run is scanned once (linear), not once per start offset
  [/(?<![\w-])[\w-]{24,}\.[\w-]{6}\.[\w-]{27,}/g, MASK],
  [/sk-ant-[\w-]{8,}/g, MASK],
  // Jira API tokens (ATATT...) and Basic credentials (base64 of email:token), T28, P10
  [/ATATT[\w=-]{16,}/g, MASK],
  [/\bBasic\s+[A-Za-z0-9+/]{16,}={0,2}/g, `Basic ${MASK}`],
  // AI-APPROVE-1 (AA-C2): `Authorization: Bearer <token>` values; case-insensitive on the scheme, the whole non-space run (a backslash or other tail must not leak), linear (one anchored run)
  [/\bBearer\s+[^\s"'<>]{16,}/gi, `Bearer ${MASK}`],
  // Google Apps Script web-app urls: the deployment id is the capability (T33, P24); the secret itself is masked as a literal (app.ts secretsOf)
  [/(https:\/\/script\.google\.com\/macros\/s\/)[\w-]+/gi, `$1${MASK}`],
  // ClickUp personal API tokens (T25, P10)
  [/pk_\d+_[A-Z0-9]{32}/g, MASK],
  [/(postgres(?:ql)?:\/\/[^:/\s@]+:)[^@\s]+(@)/gi, `$1${MASK}$2`],
];

/** Mask secrets in a string. Idempotent. */
export function redactText(s: string, secrets: readonly string[] = []): string {
  let out = s;
  for (const lit of secrets) if (lit) out = out.split(lit).join(MASK);
  for (const [re, rep] of TEXT_PATTERNS) out = out.replace(re, rep);
  return out;
}

const MAX_DEPTH = 12;

/** Deep-sanitise any value (strings by pattern, properties by key name). Idempotent, cycle-safe. */
export function sanitize<T>(value: T, secrets: readonly string[] = []): T {
  const seen = new WeakSet<object>();
  const walk = (v: unknown, depth: number): unknown => {
    if (typeof v === 'string') return redactText(v, secrets);
    if (v === null || typeof v !== 'object') return v;
    if (seen.has(v)) return '[Circular]';
    if (depth >= MAX_DEPTH) return '[Truncated]';
    seen.add(v);
    try {
      if (v instanceof Error) {
        const o: Record<string, unknown> = { type: v.name, message: v.message, stack: v.stack };
        for (const [k, val] of Object.entries(v)) o[k] = isSecretKey(k, val) ? MASK : walk(val, depth + 1);
        o.message = walk(o.message, depth + 1);
        o.stack = walk(o.stack, depth + 1);
        return o;
      }
      if (Buffer.isBuffer(v)) return MASK;
      if (Array.isArray(v)) return v.map((x) => walk(x, depth + 1));
      if (v instanceof Set) return [...v].map((x) => walk(x, depth + 1));
      if (v instanceof Map) {
        const o: Record<string, unknown> = {};
        for (const [k, val] of v) o[String(k)] = isSecretKey(String(k), val) ? MASK : walk(val, depth + 1);
        return o;
      }
      const toJSON = (v as { toJSON?: unknown }).toJSON;
      if (typeof toJSON === 'function') return walk(toJSON.call(v), depth + 1);
      const o: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v)) o[k] = isSecretKey(k, val) ? MASK : walk(val, depth + 1);
      return o;
    } finally {
      seen.delete(v); // only guard against true cycles, not shared references
    }
  };
  return walk(value, 0) as T;
}

export interface LoggerOptions {
  /** Literal secret values (e.g. the decoded CONFIG_MASTER_KEY in base64) to mask wherever they appear. */
  secrets?: string[];
  destination?: DestinationStream;
}

export function createLogger(level: string, opts: LoggerOptions = {}): Logger {
  const secrets = opts.secrets ?? [];
  const config = {
    level,
    formatters: {
      log: (obj: Record<string, unknown>) => sanitize(obj, secrets),
      bindings: (b: Record<string, unknown>) => sanitize(b, secrets),
    },
    hooks: {
      // formatters.log does not see the message string, so mask the raw call arguments too
      logMethod(this: Logger, args: unknown[], method: (...a: unknown[]) => void) {
        method.apply(this, args.map((a) => sanitize(a, secrets)));
      },
    },
  };
  return opts.destination ? pino(config, opts.destination) : pino(config);
}
