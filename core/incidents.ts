import { randomBytes } from 'node:crypto';
import { redactText } from './logger.js';

/**
 * BOTLOG-1: #bot-log as an incident log. One short plain message per real runtime fault, with where it happened, the error class, a
 * sanitised one-line cause and a likely fix; the same incident goes to the logger (level error) under its id. Never prompts, model output,
 * file contents, user text, env values or tokens: only fixed strings from code plus a sanitised, capped error message.
 */

export const INCIDENT_WINDOW_MS = 10 * 60_000;
export const INCIDENT_MAX_PER_WINDOW = 20;
const CAUSE_MAX = 300;
const TITLE_MAX = 80;
/** G2BL-01: the input is cut before any regex runs (the logger's Discord-token pattern is quadratic on long word runs). */
const INPUT_MAX = 4096;

/** A fault the code names itself (fixed text, hint included); also how boot problems are rendered. */
export class IncidentError extends Error {
  constructor(readonly code: string, message: string, readonly hint?: string, readonly maxCause?: number, /** G2BL-07: a security fault: posted as a governance alert that pings @Bot Admin */ readonly ping?: true) {
    super(message);
    this.name = 'IncidentError';
  }
}

export interface IncidentInput {
  /** Subsystem, e.g. `provider claude-code-local`, `scheduler`, `discord`, `tool`, `boot`. */
  source: string;
  /** Step inside it, e.g. `llm.call`, `render`, `task run`, `post`. */
  stage: string;
  err: unknown;
  dept?: string;
  actor?: { kind: string; dept?: string; personaId?: string };
  taskId?: string;
  taskTitle?: string;
  toolName?: string;
  /** A Discord channel id (digits only) the fault is about. */
  channelId?: string;
}

export interface IncidentSink {
  report(i: IncidentInput): string;
}

/** A sink that reports nothing (tests and wiring that has no reporter). */
export const noIncidents: IncidentSink = { report: () => '' };

// ---- sanitiser -------------------------------------------------------------------------------------------------------------------------

const ZWSP = '​';

/** Text safe for #bot-log: secrets masked, home paths shortened, mentions neutralised, one line, capped. */
export function sanitizeText(input: string, max = CAUSE_MAX, secrets: readonly string[] = []): string {
  let raw = String(input);
  if (raw.length > INPUT_MAX) {
    // cut back to the last whitespace so a half-cut secret never reaches the output (masking can shrink the text before the final cap)
    const cut = raw.slice(0, INPUT_MAX);
    const ws = cut.search(/\s\S*$/);
    raw = `${ws > 0 ? cut.slice(0, ws) : ''} …`;
  }
  let s = redactText(raw, secrets);
  s = s
    .replace(/(authorization|api[_-]?key|access[_-]?token|token|secret|password|passwd)(["']?\s*[:=]\s*)(?!\[REDACTED\])[^\s,;"'}]{4,}/gi, '$1$2[REDACTED]')
    .replace(/\b(bearer)\s+(?!\[REDACTED\])[A-Za-z0-9._~+/=-]{8,}/gi, '$1 [REDACTED]')
    .replace(/\b([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)=\S+/g, '$1=[REDACTED]') // env style NAME=value
    .replace(/\bsk-[\w-]{8,}/g, '[REDACTED]')
    .replace(/\b[A-Za-z0-9_+/=-]{32,}\b/g, (m) => (/[A-Za-z]/.test(m) && /\d/.test(m) ? '[REDACTED]' : m)) // long opaque strings
    .replace(/\/Users\/[^/\s]+/g, '~')
    .replace(/\/home\/[^/\s]+/g, '~')
    .replace(/[A-Za-z]:\\Users\\[^\\\s]+/g, '~')
    .replace(/<@[!&]?\d+>/g, '[mention]')
    .replace(/@(everyone|here)\b/gi, `@${ZWSP}$1`)
    .replace(/@(?=\w)/g, `@${ZWSP}`)
    .replace(/<(#|:|a:)[^>\s]{1,60}>/g, '[ref]')
    .replace(/`/g, "'")
    .replace(/\]\(/g, '] (') // G2BL-02: no masked links ([text](url)) in the embed
    .replace(/\s+/g, ' ')
    .trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

// ---- classification and hints ----------------------------------------------------------------------------------------------------------

type ErrLike = { name?: unknown; code?: unknown; status?: unknown; message?: unknown; diag?: unknown; rawError?: { code?: unknown } };
const asLike = (e: unknown): ErrLike => (typeof e === 'object' && e !== null ? (e as ErrLike) : {});

/** Short class plus code/status, e.g. `ProviderError status=529`, `DiscordAPIError 50013`, `Error ECONNREFUSED`. Never message text. */
export function errorClass(err: unknown): string {
  const e = asLike(err);
  const name = typeof e.name === 'string' && /^[A-Za-z0-9_$]{1,40}$/.test(e.name) ? e.name : typeof err === 'object' && err ? 'Error' : typeof err;
  const code = typeof e.code === 'string' || typeof e.code === 'number' ? String(e.code).replace(/[^\w.-]/g, '').slice(0, 24) : '';
  const status = typeof e.status === 'number' ? `status=${e.status}` : '';
  return [name, code, status].filter(Boolean).join(' ');
}

const msgOf = (err: unknown): string => {
  const m = asLike(err).message;
  return typeof m === 'string' ? m : err instanceof Error ? err.message : typeof err === 'string' ? err : '';
};

/** The one-line cause (sanitised). A ProviderError's `diag` is appended after the same sanitiser. */
export function causeOf(err: unknown, secrets: readonly string[] = []): string {
  const e = asLike(err);
  // G2BL-04: a Postgres error message can quote row values or input text: class and SQLSTATE only (errno names such as EPIPE are not SQLSTATEs)
  if (typeof e.code === 'string' && /^[0-9A-Z]{5}$/.test(e.code) && !/^E[A-Z]{4}$/.test(e.code)) return `database error, SQLSTATE ${e.code} (message withheld; see live.log)`;
  const first = msgOf(err).split('\n').slice(0, 2).join(' ');
  const diag = typeof e.diag === 'string' && e.diag.trim() !== '' ? ` [${e.diag}]` : '';
  const max = err instanceof IncidentError && err.maxCause ? Math.min(err.maxCause, 900) : CAUSE_MAX;
  const text = sanitizeText(`${first}${diag}`, max, secrets);
  return text === '' ? '(no message)' : text;
}

/** A likely fix where the code can tell; undefined otherwise. Fixed strings only. */
export function hintFor(i: Pick<IncidentInput, 'source' | 'stage' | 'toolName' | 'channelId'>, err: unknown): string | undefined {
  const e = asLike(err);
  if (err instanceof IncidentError && err.hint) return err.hint;
  const code = typeof e.code === 'string' || typeof e.code === 'number' ? String(e.code) : '';
  const msg = msgOf(err);
  const where = `${i.source} ${i.stage}`.toLowerCase();
  const ch = i.channelId && /^\d{1,25}$/.test(i.channelId) ? ` in channel ${i.channelId}` : '';

  if (code === '50013') return `Discord Missing Permissions: give the bot Send Messages, Embed Links and View Channel${ch}.`;
  if (code === '50001') return `Discord Missing Access: the bot cannot see the channel${ch}; grant View Channel.`;
  if (code === '10003' || code === '10008') return `Discord says the channel or message no longer exists${ch}; check the channel map (/channel map).`;
  if (code === '50007') return 'The user has closed DMs; nothing to fix in the bot.';
  if (/provider/.test(i.source) && /not registered|not available|unavailable/i.test(msg)) return 'Provider is not registered here: run scripts/probe-local-cli.sh (npm run probe:local), or pick another with /provider default.';
  if (e.name === 'RenderError') {
    if (code === 'timeout') return 'Render hit the 20 s limit (RENDER_TIMEOUT_MS): make the document shorter, or check the renderer container load.';
    if (code === 'unavailable' || code === 'failed') return 'Renderer container is unreachable or crashed: run npm run local:render.';
  }
  if (/render/.test(where) && (code === 'ECONNREFUSED' || /ECONNREFUSED|ECONNRESET|socket hang up/i.test(msg))) return 'Renderer container is unreachable: run npm run local:render.';
  if (/ECONNREFUSED/.test(`${code} ${msg}`) && /(:5432|postgres|\bdb\b|database|pool)/i.test(`${msg} ${where}`)) return 'Database refused the connection: run npm run local:db.';
  if (['57P01', '08006', '08001', '08004', '53300'].includes(code) || /connection terminated|too many clients|database system is (starting|shutting)/i.test(msg)) return 'Database connection problem: run npm run local:db (or check Postgres).';
  if (typeof e.status === 'number' && /provider|llm/.test(where)) {
    if (e.status === 401 || e.status === 403) return 'Provider rejected the credentials: check the provider key (npm run tokens:local, or the stored key).';
    if (e.status === 429) return 'Provider rate limit: wait, or lower load; see limits.* config.';
    if (e.status >= 500) return 'Provider side error (5xx): usually transient, retry later; check the provider status page.';
  }
  if (e.name === 'AbortError' || code === 'ETIMEDOUT' || /timed out|timeout/i.test(msg)) return `A timeout limit was hit at ${i.stage}: check network and the matching limit (see cause).`;
  return undefined;
}

// ---- reporter --------------------------------------------------------------------------------------------------------------------------

export interface IncidentPort {
  post(actor: { kind: 'head'; dept: 'hq' }, target: { channelId: string }, p: { type: 'alert'; origin?: 'governance'; title: string; body: string }): Promise<unknown>;
}
type IncidentLog = { error(o: unknown, m?: string): void; warn?(o: unknown, m?: string): void };

export interface IncidentOptions {
  port: IncidentPort;
  channelId: string;
  log: IncidentLog;
  secrets?: readonly string[];
  now?: () => number;
  windowMs?: number;
  maxPerWindow?: number;
  /** Test seam for the timer that closes a window (default setTimeout, unref'd). */
  timer?: (fn: () => void, ms: number) => { unref?(): unknown } | void;
}

type Entry = { first: number; suppressed: number; header: string; timerSet: boolean };

/** G2BL-01: the error as logged, each text field cut to INPUT_MAX (the logger's masking regexes are not linear on unbounded text). */
function boundedErr(err: unknown): Record<string, unknown> {
  const e = asLike(err);
  const cut = (v: unknown) => (typeof v === 'string' ? v.slice(0, INPUT_MAX) : undefined);
  const stack = typeof err === 'object' && err !== null ? (err as { stack?: unknown }).stack : undefined;
  return { type: errorClass(err), message: cut(msgOf(err)), diag: cut(e.diag), stack: cut(stack) };
}

const bangkok = (ms: number): string => {
  const p = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(ms);
  return `${p} (Asia/Bangkok)`;
};

export class IncidentReporter implements IncidentSink {
  private readonly entries = new Map<string, Entry>();
  private posts: number[] = [];
  private flooded = false;
  private readonly pending = new Set<Promise<void>>();
  private readonly now: () => number;
  private readonly window: number;
  private readonly cap: number;

  constructor(private readonly o: IncidentOptions) {
    this.now = o.now ?? Date.now;
    this.window = o.windowMs ?? INCIDENT_WINDOW_MS;
    this.cap = o.maxPerWindow ?? INCIDENT_MAX_PER_WINDOW;
  }

  /** Resolves when every post started so far has finished (tests, shutdown). */
  async idle(): Promise<void> {
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }

  /** Records one incident. Synchronous and never throws; the Discord post is fire-and-forget. Returns the incident id. */
  report(i: IncidentInput): string {
    const id = randomBytes(4).toString('hex');
    try {
      return this.handle(i, id);
    } catch (e) {
      try {
        this.o.log.warn?.({ incident: id, err: e instanceof Error ? e.message : 'error' }, 'incident reporter failed');
      } catch {
        // the reporter must never break the failing path
      }
      return id;
    }
  }

  private handle(i: IncidentInput, id: string): string {
    const dept = i.dept ?? i.actor?.dept ?? (i.actor?.personaId ? `persona ${i.actor.personaId}` : undefined);
    const cls = errorClass(i.err);
    const t = this.now();
    // G2BL-03: the tool and channel are part of "where": a second tool or channel failing the same way is its own incident
    const key = [i.source, i.toolName ?? '', i.stage, cls, dept ?? '', i.channelId ?? ''].join('|');
    if (this.entries.size > 64) for (const [k, e] of this.entries) if (!e.timerSet && t - e.first >= this.window) this.entries.delete(k);
    // Full detail goes to live.log (the logger masks secrets); the id ties it to the Discord message.
    const prior = this.entries.get(key);
    const dup = !!prior && t - prior.first < this.window;
    this.o.log.error({ incident: id, source: i.source, stage: i.stage, dept, taskId: i.taskId, tool: i.toolName, errClass: cls, suppressed: dup || undefined, err: boundedErr(i.err) }, 'incident');

    if (dup) {
      prior.suppressed++;
      if (!prior.timerSet) {
        prior.timerSet = true;
        this.schedule(key, prior.first + this.window - t);
      }
      return id;
    }
    const repeated = prior?.suppressed ?? 0;
    this.entries.set(key, { first: t, suppressed: 0, header: this.where(i), timerSet: false });
    this.send(this.format(i, id, dept, cls, repeated), t);
    return id;
  }

  private where(i: IncidentInput): string {
    return sanitizeText(`${i.source}${i.toolName ? ` ${i.toolName}` : ''} · ${i.stage}`, 120, this.o.secrets);
  }

  private format(i: IncidentInput, id: string, dept: string | undefined, cls: string, repeated: number): { title: string; body: string; ping?: true } {
    const sec = this.o.secrets ?? [];
    const lines: string[] = [`when: ${bangkok(this.now())}`];
    const bot = [dept ? sanitizeText(dept, 40) : '', i.taskId ? `task #${sanitizeText(i.taskId.slice(0, 8), 8)}${i.taskTitle ? ` "${sanitizeText(i.taskTitle, TITLE_MAX, sec)}"` : ''}` : ''].filter(Boolean).join(' · ');
    if (bot) lines.push(`bot: ${bot}`);
    lines.push(`where: ${this.where(i)}`);
    lines.push(`error: ${sanitizeText(cls, 80)}`);
    lines.push(`cause: ${causeOf(i.err, sec)}`);
    const hint = hintFor(i, i.err);
    if (hint) lines.push(`fix: ${sanitizeText(hint, 260)}`);
    if (repeated > 0) lines.push(`repeated ${repeated} times since the last report`);
    lines.push(`-# grep incident=${id} in live.log`);
    return { title: `Incident ${id}`, body: lines.join('\n'), ...(i.err instanceof IncidentError && i.err.ping ? { ping: true as const } : {}) };
  }

  private schedule(key: string, ms: number): void {
    const own = this.entries.get(key);
    const fire = () => {
      const e = this.entries.get(key);
      if (!e || e !== own) return; // a newer window for the same key owns its own timer
      this.entries.delete(key);
      if (e.suppressed > 0) this.send({ title: 'Incident repeated', body: `${e.header}: repeated ${e.suppressed} times in the last ${Math.round(this.window / 60_000)} min (first report above).` }, this.now());
    };
    const handle = (this.o.timer ?? ((f, m) => setTimeout(f, m)))(fire, Math.max(0, ms));
    if (handle && typeof handle === 'object' && 'unref' in handle) handle.unref?.();
  }

  private send(p: { title: string; body: string; ping?: true }, t: number): void {
    this.posts = this.posts.filter((x) => t - x < this.window);
    if (this.posts.length >= this.cap) {
      if (this.flooded) return;
      this.flooded = true;
      this.post({ title: 'Incident flood', body: `More than ${this.cap} incidents in ${Math.round(this.window / 60_000)} min; further ones are only in live.log (grep "incident").` });
      return;
    }
    this.flooded = false;
    this.posts.push(t);
    this.post(p);
  }

  private post(p: { title: string; body: string; ping?: true }): void {
    const run = Promise.resolve()
      .then(() => this.o.port.post({ kind: 'head', dept: 'hq' }, { channelId: this.o.channelId }, { type: 'alert', ...(p.ping ? { origin: 'governance' as const } : {}), title: p.title, body: p.body }))
      .then(() => undefined, (err: unknown) => {
        // never reported again (no loop): logged only
        try {
          this.o.log.warn?.({ err: err instanceof Error ? err.name : 'error' }, 'incident post failed');
        } catch {
          // ignore
        }
      });
    this.pending.add(run);
    void run.finally(() => this.pending.delete(run));
  }
}
