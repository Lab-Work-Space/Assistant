import { randomBytes } from 'node:crypto';
import type { IncidentSink } from '../../../core/incidents.js';
import type { Logger } from '../../../core/index.js';
import type { MediaJob, MediaJobRepo, NewMediaJob } from '../../../db/repos/media.js';
import type { DiscordPort } from '../../../discord/index.js';
import type { Halt } from '../../../governance/halt.js';
import type { MediaClient } from '../../../providers/gemini/media.js';
import { DOWNLOAD_HOSTS, MEDIA_MAX_BYTES, VIDEO_JOB_LIFETIME_MS } from './pins.js';

/** Fixed texts: nothing from the provider, the prompt or the model is ever echoed into a channel. */
export const VIDEO_TEXT = {
  timeout: 'The video was not ready within 15 minutes and was dropped. It was counted against today\'s video limit.',
  failed: 'The video could not be made (the provider reported a failure). It was counted against today\'s video limit.',
  blocked: 'The provider\'s safety filter blocked this video, so there is nothing to show. It was counted against today\'s video limit.',
  toolarge: 'The video was made but is too large to attach here (over the upload limit). It was counted against today\'s video limit.',
  posted: 'AI-generated video (the provider adds a SynthID watermark).',
} as const;

/** Polling delays (ms), bounded: the last value repeats until the 15 minute lifetime ends. */
export const POLL_DELAYS_MS = [10_000, 15_000, 20_000, 30_000, 45_000, 60_000] as const;
const MAX_POLL_ERRORS = 5;

export type MediaJobDeps = {
  repo: Pick<MediaJobRepo, 'add' | 'get' | 'open' | 'claimPost' | 'finish'>;
  client: Pick<MediaClient, 'pollVideo' | 'downloadVideo'>;
  port: Pick<DiscordPort, 'post' | 'postFile' | 'canMemberView'>;
  provenance?: { record(messageId: string, channelId: string, tainted: boolean, triggerUserId: string | null): Promise<void> };
  halt: Pick<Halt, 'isHalted' | 'track'>;
  log: Pick<Logger, 'info' | 'warn'>;
  incidents?: IncidentSink;
  clock: () => number;
  /** Tests inject; production waits with a timer that stop() clears. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
};

const realSleep = (ms: number, signal: AbortSignal) => new Promise<void>((res) => {
  const t = setTimeout(res, ms);
  signal.addEventListener('abort', () => { clearTimeout(t); res(); }, { once: true });
});

/**
 * RFMD P5 / RF33: Veo long-running jobs. The row (db/migrations/024) holds the provider job id, requester, channel, thread, the taint of the run that submitted it and the
 * reserved USD (already booked as spent at submit, RF29). Jobs are polled with a bounded backoff and a 15 minute lifetime counted from created_at, so a restart resumes with the
 * same deadline. The result is posted AT MOST ONCE: `claimPost` is a conditional UPDATE (running -> posting); a row found in `posting` after a crash is failed, never re-posted.
 * At post time the requester's view of the channel, halt and the port's channel exclusions are checked again; the bytes posted are the ones downloaded here.
 */
export class MediaJobService {
  private readonly stopAll = new AbortController();
  private readonly active = new Set<string>();
  private readonly errors = new Map<string, number>();
  private readonly loops = new Set<Promise<void>>();

  constructor(private readonly d: MediaJobDeps) {}

  /** Boot: resumes every open job. A job left in `posting` is failed (the post may or may not have happened). */
  async start(): Promise<void> {
    for (const j of await this.d.repo.open()) {
      if (j.status === 'posting') { await this.d.repo.finish(j.id, 'failed', 'posting'); continue; }
      this.kick(j.id);
    }
  }
  async stop(): Promise<void> {
    this.stopAll.abort();
    await Promise.allSettled([...this.loops]);
  }

  async submit(j: NewMediaJob): Promise<string> {
    const id = await this.d.repo.add(j);
    this.kick(id);
    return id;
  }

  kick(id: string): void {
    if (this.active.has(id) || this.stopAll.signal.aborted) return;
    this.active.add(id);
    const p = this.loop(id).catch((e) => this.d.log.warn({ errName: e instanceof Error ? e.name : 'unknown' }, 'media job loop failed')).finally(() => { this.active.delete(id); this.loops.delete(p); });
    this.loops.add(p);
  }

  private async loop(id: string): Promise<void> {
    const sleep = this.d.sleep ?? realSleep;
    for (let n = 0; !this.stopAll.signal.aborted; n++) {
      await sleep(POLL_DELAYS_MS[Math.min(n, POLL_DELAYS_MS.length - 1)]!, this.stopAll.signal);
      if (this.stopAll.signal.aborted) return;
      if ((await this.step(id)) === 'ended') return;
    }
  }

  /** One poll. 'ended' when the job reached a final state (or was ended by someone else). */
  async step(id: string): Promise<'continue' | 'ended'> {
    const job = await this.d.repo.get(id);
    if (!job || job.status !== 'running') return 'ended';
    if (this.d.halt.isHalted()) { await this.d.repo.finish(id, 'cancelled'); return 'ended'; } // /halt cancels polling and posting
    if (this.d.clock() - job.createdAt.getTime() > VIDEO_JOB_LIFETIME_MS) {
      await this.fail(job, 'failed', VIDEO_TEXT.timeout, 'timeout');
      return 'ended';
    }
    const ac = new AbortController();
    const untrack = this.d.halt.track(ac);
    const stop = () => ac.abort();
    this.stopAll.signal.addEventListener('abort', stop, { once: true });
    try {
      const r = await this.d.client.pollVideo(job.opName, ac.signal);
      this.errors.delete(id);
      if (!r.done) return 'continue';
      if ('failed' in r) { await this.fail(job, 'failed', VIDEO_TEXT.failed, 'provider reported failure'); return 'ended'; }
      if ('filtered' in r) { await this.fail(job, 'blocked', VIDEO_TEXT.blocked); return 'ended'; }
      await this.deliver(job, r.uri);
      return 'ended';
    } catch (e) {
      if (ac.signal.aborted) return this.d.halt.isHalted() ? (await this.d.repo.finish(id, 'cancelled'), 'ended') : 'continue';
      const n = (this.errors.get(id) ?? 0) + 1;
      this.errors.set(id, n);
      if (n >= MAX_POLL_ERRORS) { await this.fail(job, 'failed', VIDEO_TEXT.failed, e); return 'ended'; }
      return 'continue';
    } finally {
      this.stopAll.signal.removeEventListener('abort', stop);
      untrack();
    }
  }

  private async deliver(job: MediaJob, uri: string): Promise<void> {
    if (!(await this.d.repo.claimPost(job.id))) return; // someone else owns the post: at most once
    const ac = new AbortController();
    const untrack = this.d.halt.track(ac);
    try {
      if (this.d.halt.isHalted()) { await this.d.repo.finish(job.id, 'cancelled', 'posting'); return; }
      // the requester must still be able to see the channel (the room may have changed while the job ran)
      if (job.requesterId && !(await this.d.port.canMemberView(job.requesterId, job.threadId ?? job.channelId))) {
        await this.d.repo.finish(job.id, 'cancelled', 'posting');
        this.d.log.info({ job: job.id }, 'video not posted: the requester can no longer view the channel');
        return;
      }
      let data: Buffer;
      try {
        data = await this.d.client.downloadVideo(uri, { signal: ac.signal, maxBytes: MEDIA_MAX_BYTES, hosts: DOWNLOAD_HOSTS });
      } catch (e) {
        if (ac.signal.aborted || this.d.halt.isHalted()) { await this.d.repo.finish(job.id, 'cancelled', 'posting'); return; } // G2RF5-05: halted: no notice, no incident
        const big = e instanceof Error && /larger than the upload limit/.test(e.message);
        await this.terminal(job, 'failed', big ? VIDEO_TEXT.toolarge : VIDEO_TEXT.failed, big ? undefined : e);
        return;
      }
      if (ac.signal.aborted || this.d.halt.isHalted()) { await this.d.repo.finish(job.id, 'cancelled', 'posting'); return; }
      // MP4: an 'ftyp' box at offset 4. Anything else is not what we asked for and is not posted.
      if (data.length < 12 || data.length > MEDIA_MAX_BYTES || data.subarray(4, 8).toString('latin1') !== 'ftyp') { await this.terminal(job, 'failed', VIDEO_TEXT.failed, 'not an mp4'); return; }
      const target = { channelId: job.channelId, ...(job.threadId ? { threadId: job.threadId } : {}) };
      try {
        const mid = await this.d.port.postFile(job.actor, target, { type: 'chat', body: VIDEO_TEXT.posted }, { name: `video-${randomBytes(4).toString('hex')}.mp4`, data, contentType: 'video/mp4' });
        await this.d.provenance?.record(mid, job.threadId ?? job.channelId, job.tainted, job.requesterId).catch(() => undefined);
        await this.d.repo.finish(job.id, 'posted', 'posting');
      } catch {
        await this.d.repo.finish(job.id, 'failed', 'posting'); // not re-posted: at most once
        this.d.log.warn({ job: job.id }, 'video could not be posted');
      }
    } finally {
      untrack();
    }
  }

  private async fail(job: MediaJob, status: 'failed' | 'blocked', text: string, fault?: unknown): Promise<void> {
    if (!(await this.d.repo.finish(job.id, status))) return;
    await this.tell(job, text, fault);
  }
  private async terminal(job: MediaJob, status: 'failed' | 'blocked', text: string, fault?: unknown): Promise<void> {
    if (!(await this.d.repo.finish(job.id, status, 'posting'))) return;
    await this.tell(job, text, fault);
  }
  private async tell(job: MediaJob, text: string, fault?: unknown): Promise<void> {
    if (fault !== undefined) this.d.incidents?.report({ source: 'tool', stage: 'video job', toolName: 'video_generate', err: fault instanceof Error ? fault : new Error(String(fault)), actor: job.actor, ...(job.taskId ? { taskId: job.taskId } : {}) });
    try {
      const mid = await this.d.port.post(job.actor, { channelId: job.channelId, ...(job.threadId ? { threadId: job.threadId } : {}) }, { type: 'chat', body: text });
      await this.d.provenance?.record(mid, job.threadId ?? job.channelId, job.tainted, job.requesterId).catch(() => undefined);
    } catch { this.d.log.warn({ job: job.id }, 'video notice could not be posted'); }
  }
}
