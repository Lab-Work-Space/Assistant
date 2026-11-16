import { isDenied } from '../../../company/denylist.js';
import type { ActorRef } from '../../../company/types.js';
import type { Watch, WatchRepo } from '../../../db/repos/watches.js';
import type { DiscordPort } from '../../../discord/port.js';
import type { AuditFn } from '../../../governance/audit.js';
import { SafeFetchError } from '../../../net/guard.js';
import { htmlToText } from '../../../net/html.js';
import { readPage, type WebNetOptions } from '../web/browser.js';
import type { SearchBackend } from '../web/webSearch.js';
import { urlKey } from '../../urls.js';
import { clip, diffLines, escapeText, fitLines } from './diff.js';

const PRAW: ActorRef = { kind: 'head', dept: 'praw' };
const BATCH = 10;
const SNAPSHOT_MAX = 6000;
const BODY_MAX = 1800;
const URL_MAX = 500;
const HITS = 10;
const HREFS_KEPT = 50;
const NEW_HITS_SHOWN = 5;
/** The third failed check in a row pauses the watch. */
export const MAX_FAILS = 3;
const MAX_BACKOFF_MINUTES = 24 * 60;
const TEXTUAL = /^(text\/[\w.+-]+|application\/(json|xml|xhtml\+xml|[\w.-]+\+(json|xml)))$/;

/** A failed check whose reason is safe to log: it never carries a url, a response body or an upstream error message. */
class CheckError extends Error {}

export interface WatchPollerDeps {
  repo: Pick<WatchRepo, 'claimDue' | 'get' | 'saveSnapshot' | 'recordFailure' | 'postpone'>;
  port: Pick<DiscordPort, 'post' | 'canMemberView'>;
  /** The guarded network for url watches (net/guard only; every poll re-runs the full SSRF check, P4). */
  net: WebNetOptions;
  search: SearchBackend;
  /** False while halted, paused (D9) or stopping: nothing is claimed, so every due watch stays due. */
  canRun: () => boolean;
  /** Epoch ms; injectable so tests drive a fake clock. */
  clock: () => number;
  intervalMs?: number;
  log: { warn(o: unknown, m?: string): void; error(o: unknown, m?: string): void };
  audit?: AuditFn;
  /** Whether Praw is enabled; a disabled Praw checks nothing. */
  enabled?: () => boolean;
  /** True on an off day (company/calendar.ts): nothing is claimed, so watches stay due and are checked on the next workday. */
  offDay?: () => boolean;
}

/**
 * Polls due watches. The claim is atomic in the repo (R11/PF12: next_check_at advances in the same statement), so overlapping
 * ticks or pollers check each watch once. There is no model in this path (PF15): a change is posted as a summary that code
 * builds (diffSummary or the new search hits), escaped and capped, pinging only the creator (R12). The first check stores a baseline
 * and posts nothing. Before each check: the channel must not be denied (D8), Praw enabled, the watch still enabled, and the
 * creator still a member who can see the channel; otherwise one audit row records the skip. A failed check backs off
 * (interval x 2^fails, at most a day); the third failure in a row pauses the watch with one generic notice to the creator.
 * Raw error text, urls and query strings are never posted or logged.
 */
export class WatchPoller {
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  /** `${id}:${reason}` of skips already audited, so a denied channel is not audited every interval. */
  private readonly audited = new Set<string>();

  constructor(private readonly d: WatchPollerDeps) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.d.intervalMs ?? 60_000);
    this.timer.unref();
    void this.tick(); // boot catch-up
  }

  /** Clears the timer and resolves once an in-flight pass has finished (shutdown awaits it before closing the pool). */
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.running?.catch(() => undefined);
  }

  /** One pass; a tick that overlaps a running one waits for it instead of starting a second. */
  tick(): Promise<void> {
    if (this.running) return this.running;
    const run = this.pass().finally(() => { if (this.running === run) this.running = null; });
    this.running = run;
    return run;
  }

  private async pass(): Promise<void> {
    if (!this.d.canRun() || this.d.offDay?.()) return; // D9: halted or paused (or an off day): claim nothing
    try {
      if (this.audited.size > 200) this.audited.clear();
      for (const w of await this.d.repo.claimDue(new Date(this.d.clock()), BATCH)) {
        if (!this.d.canRun()) break; // halted mid-pass: the rest were claimed but are checked at their next interval
        await this.check(w);
      }
    } catch (err) {
      this.d.log.error({ err: err instanceof Error ? err.message : 'error' }, 'watch tick failed');
    }
  }

  private async skip(w: Watch, reason: string): Promise<void> {
    const key = `${w.id}:${reason}`;
    if (this.audited.has(key)) return;
    this.audited.add(key);
    await this.d.audit?.({ actor: 'system:watch', action: 'watch.skip', tool: String(w.id), outcome: reason });
  }

  private async check(w: Watch): Promise<void> {
    try {
      const cur = await this.d.repo.get(w.id);
      if (!cur || !cur.enabled) return void (await this.skip(w, 'removed'));
      if (isDenied(w.channelId, null)) return void (await this.skip(w, 'channel is denied'));
      if (this.d.enabled && !this.d.enabled()) return void (await this.skip(w, 'praw disabled'));
      if (!(await this.d.port.canMemberView(w.userId, w.channelId))) return void (await this.skip(w, 'creator is not a member who can see the channel'));
      let result: { snapshot?: string; hrefs?: string[]; message: string | null };
      try {
        result = w.kind === 'url' ? await this.checkUrl(cur) : await this.checkTopic(cur);
      } catch (err) {
        return void (await this.fail(cur, err));
      }
      if ((await this.d.repo.get(cur.id))?.enabled !== true) return void (await this.skip(w, 'removed')); // removed while checking: post nothing
      if (result.message !== null) {
        try {
          await this.post(cur, result.message);
        } catch {
          return void (await this.fail(cur, new CheckError('the update could not be posted'))); // the old snapshot stays, so the change is retried
        }
      }
      await this.d.repo.saveSnapshot(cur.id, { ...(result.snapshot !== undefined ? { snapshot: result.snapshot } : {}), ...(result.hrefs ? { hrefs: result.hrefs } : {}) });
    } catch (err) {
      this.d.log.warn({ watch: w.id, err: err instanceof Error ? err.name : 'error' }, 'watch check failed');
      await this.d.audit?.({ actor: 'system:watch', action: 'watch.fail', tool: String(w.id), outcome: 'check failed' });
    }
  }

  private async checkUrl(w: Watch): Promise<{ snapshot: string; message: string | null }> {
    let res;
    try {
      res = await readPage(this.d.net, w.target);
    } catch (err) {
      throw new CheckError(err instanceof SafeFetchError && err.code === 'blocked' ? 'the address is not allowed' : 'the page could not be fetched');
    }
    if (res.status >= 400) throw new CheckError('the page returned an error status');
    const type = res.contentType.split(';')[0]!.trim().toLowerCase();
    const encoding = (res.headers['content-encoding'] ?? 'identity').trim().toLowerCase();
    if ((type && !TEXTUAL.test(type)) || (encoding !== '' && encoding !== 'identity')) throw new CheckError('the page is not text');
    const raw = res.body.toString('utf8');
    const snapshot = (type === '' || type.includes('html') ? htmlToText(raw) : raw.trim()).slice(0, SNAPSHOT_MAX);
    if (!w.hasBaseline || w.lastSnapshot === null) return { snapshot, message: null };
    const diff = diffLines(w.lastSnapshot, snapshot);
    return { snapshot, message: diff === null ? null : compose(`Watch #${w.id} (${escapeText(hostOf(w.target))}) changed:`, diff.map(escapeText)) };
  }

  private async checkTopic(w: Watch): Promise<{ hrefs?: string[]; message: string | null }> {
    let hits;
    try {
      hits = (await this.d.search.search(w.target, HITS)).slice(0, HITS);
    } catch {
      throw new CheckError('the search failed');
    }
    const good = hits.flatMap((h) => {
      const url = urlKey(h.url);
      return url !== null && url.length <= URL_MAX ? [{ title: h.title, url }] : [];
    });
    const urls = [...new Set(good.map((h) => h.url))];
    if (!w.hasBaseline) return { hrefs: urls, message: null };
    if (good.length === 0) return { message: null }; // an empty page is no evidence: the stored list is kept, so old results do not re-announce
    const seen = new Set(w.lastHrefs ?? []);
    const fresh = good.filter((h, i) => !seen.has(h.url) && good.findIndex((x) => x.url === h.url) === i);
    const hrefs = [...urls, ...(w.lastHrefs ?? []).filter((u) => !urls.includes(u))].slice(0, HREFS_KEPT);
    if (fresh.length === 0) return { hrefs, message: null };
    const lines = fresh.map((h) => `${escapeText(clip(h.title, 120))}\n<${h.url.replace(/@/g, '%40')}>`);
    return { hrefs, message: compose(`Watch #${w.id} (${escapeText(clip(w.target, 80))}) has new results:`, lines.slice(0, NEW_HITS_SHOWN), lines.length) };
  }

  private async post(w: Watch, body: string): Promise<void> {
    await this.d.port.post(PRAW, { channelId: w.channelId }, { type: 'chat', body }, { mentionUserIds: [w.userId] });
  }

  private async fail(w: Watch, err: unknown): Promise<void> {
    const reason = err instanceof CheckError ? err.message : 'the check failed';
    this.d.log.warn({ watch: w.id, reason }, 'watch check failed');
    const r = await this.d.repo.recordFailure(w.id, MAX_FAILS);
    if (!r) return;
    if (r.enabled) {
      const minutes = Math.min(w.intervalMinutes * 2 ** r.failCount, Math.max(w.intervalMinutes, MAX_BACKOFF_MINUTES));
      await this.d.repo.postpone(w.id, new Date(this.d.clock() + minutes * 60_000));
      return;
    }
    await this.d.audit?.({ actor: 'system:watch', action: 'watch.paused', tool: String(w.id), outcome: reason });
    const label = w.kind === 'url' ? hostOf(w.target) : clip(w.target, 80);
    await this.post(w, `Watch #${w.id} (${escapeText(label)}) was paused after ${MAX_FAILS} failed checks in a row (${reason}). Add it again with /watch add if you still want it.`)
      .catch((e: unknown) => this.d.log.warn({ watch: w.id, err: e instanceof Error ? e.name : 'error' }, 'watch pause notice failed'));
  }
}

/** Header plus whole already-escaped entries (never cut mid-escape or mid-url); what does not fit becomes "… and N more". */
function compose(header: string, entries: string[], total = entries.length): string {
  const out = [...entries];
  if (total > out.length) out.push(`… and ${total - out.length} more`);
  return `${header}\n${fitLines(out, BODY_MAX - header.length - 1)}`;
}

function hostOf(target: string): string {
  try {
    return new URL(target).host;
  } catch {
    return 'a page';
  }
}
