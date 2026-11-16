/** One queued request: `query` is the normalised input (an allowlisted https URL or a search term), re-checked at play time. */
export type QueuedTrack = { query: string; label: string; requestedBy: string };
/** What music_state stores: the queue (head = the track playing or next), the volume percent and whether playback is paused. */
export type MusicState = { queue: QueuedTrack[]; volume: number; paused: boolean };

export interface MusicStore {
  load(): Promise<MusicState | null>;
  save(s: MusicState): Promise<void>;
}

export const MAX_QUEUE = 50;
export const VOLUME_MAX = 150;
export const DEFAULT_VOLUME = 100;
const QUERY_MAX = 300;
const LABEL_MAX = 120;

type Log = { warn(o: object, m?: string): void };

const validTrack = (t: unknown): t is QueuedTrack => {
  const x = t as Partial<QueuedTrack> | null;
  return !!x && typeof x.query === 'string' && x.query.length > 0 && x.query.length <= QUERY_MAX
    && typeof x.label === 'string' && x.label.length <= LABEL_MAX && typeof x.requestedBy === 'string' && x.requestedBy.length <= 32;
};

export const validVolume = (v: number): boolean => Number.isInteger(v) && v >= 0 && v <= VOLUME_MAX;

/**
 * The music queue (one guild). Mutations change memory at once (so the player loop sees them synchronously) and persist to
 * music_state in call order; a failed save is logged, never thrown, so playback is not blocked by the database.
 */
export class MusicQueue {
  private s: MusicState = { queue: [], volume: DEFAULT_VOLUME, paused: false };
  private saving: Promise<void> = Promise.resolve();

  constructor(private readonly store?: MusicStore, private readonly log?: Log) {}

  /** Loads the saved state after a restart. A non-empty queue comes back paused: nothing plays until the next /play (no auto-join). */
  async restore(): Promise<void> {
    const st = await this.store?.load().catch((err: unknown) => {
      this.log?.warn({ err: err instanceof Error ? err.message : String(err) }, 'music state could not be loaded');
      return null;
    });
    if (!st) return;
    const queue = (Array.isArray(st.queue) ? st.queue : []).filter(validTrack).slice(0, MAX_QUEUE).map((t) => ({ query: t.query, label: t.label, requestedBy: t.requestedBy }));
    const volume = typeof st.volume === 'number' && Number.isFinite(st.volume) ? Math.min(VOLUME_MAX, Math.max(0, Math.round(st.volume))) : DEFAULT_VOLUME;
    this.s = { queue, volume, paused: queue.length > 0 };
  }

  get paused(): boolean {
    return this.s.paused;
  }

  get volume(): number {
    return this.s.volume;
  }

  current(): QueuedTrack | null {
    return this.s.queue[0] ?? null;
  }

  list(): { current: QueuedTrack | null; upcoming: QueuedTrack[]; volume: number; paused: boolean } {
    return { current: this.current(), upcoming: this.s.queue.slice(1), volume: this.s.volume, paused: this.s.paused };
  }

  /** Position 0 means it plays now (the queue was empty). */
  async enqueue(t: QueuedTrack): Promise<{ position: number } | { error: string }> {
    if (this.s.queue.length >= MAX_QUEUE) return { error: `the queue is full (${MAX_QUEUE} tracks); skip or stop first` };
    this.s.queue.push({ query: t.query.slice(0, QUERY_MAX), label: t.label.slice(0, LABEL_MAX), requestedBy: t.requestedBy });
    const position = this.s.queue.length - 1;
    await this.persist();
    return { position };
  }

  /** The head finished (or was skipped); returns the new head. */
  async advance(): Promise<QueuedTrack | null> {
    this.s.queue.shift();
    if (this.s.queue.length === 0) this.s.paused = false;
    await this.persist();
    return this.current();
  }

  skip(): Promise<QueuedTrack | null> {
    return this.advance();
  }

  async stop(): Promise<void> {
    this.s = { ...this.s, queue: [], paused: false };
    await this.persist();
  }

  /** Throws RangeError outside 0–150 (integers only). */
  async setVolume(percent: number): Promise<number> {
    if (!validVolume(percent)) throw new RangeError(`volume must be a whole number from 0 to ${VOLUME_MAX}`);
    this.s.volume = percent;
    await this.persist();
    return percent;
  }

  async setPaused(paused: boolean): Promise<void> {
    if (this.s.paused === paused) return;
    this.s.paused = paused;
    await this.persist();
  }

  /** Waits for every pending save. */
  flush(): Promise<void> {
    return this.saving;
  }

  private persist(): Promise<void> {
    const snap = structuredClone(this.s);
    this.saving = this.saving.then(() => this.store?.save(snap)).catch((err: unknown) => {
      this.log?.warn({ err: err instanceof Error ? err.message : String(err) }, 'music state could not be saved');
    });
    return this.saving;
  }
}
