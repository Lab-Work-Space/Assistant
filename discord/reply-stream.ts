import type { OutboundPayload } from '../agents/loop/payload.js';
import {
  committable, EDIT_CAP, EDIT_INTERVAL_MS, EDIT_MAX_INTERVAL_MS, ELLIPSIS, FIRST_WAIT_MS, MIN_DELTA, MIN_FIRST_CHARS, TYPING_MAX_MS, TYPING_REFRESH_MS,
} from '../agents/stream/stream-holdback.js';

/**
 * STREAM-1: the pacing and safety engine of one live reply preview. It holds no Discord objects: everything that touches Discord is behind
 * `StreamIO` (implemented in discord/port.ts, the only file with write calls: Gate 1 S21). One preview message per stream, created from the
 * first committed body text and replaced in place; every ending replaces it (a message is never deleted). Display only: the final answer
 * is built from the model's tool call by the caller, never from here.
 */

/** The ids and recording hooks of the final posting (S6): `onSent` = the answer-carrying ids, `onCode` = ids of fixed code lines (answer false). */
export type StreamFinalOpts = { replyToId?: string; onSent?: (ids: string[]) => void; onCode?: (ids: string[]) => void };

export interface ReplyStream {
  /** Shows the typing indicator (heads only), refreshed until the first preview, the end, a halt or TYPING_MAX_MS. Idempotent. */
  typing(): void;
  /** The raw respond body of the current segment so far. Cheap (stored); the committed part is computed at most once per tick. */
  update(raw: string): void;
  /** A new segment begins (next provider call, retry or fallback): what was streamed so far is void; the preview stays until new text replaces it. */
  restart(): void;
  /** A preview message exists on Discord. */
  active(): boolean;
  /**
   * Ends the stream with the final payload. `undefined` = no preview was ever created (nothing was done: post the answer as today). Otherwise the id
   * of the answer-carrying message (the edited preview or a fresh post). Throws when even the fallback post fails (the caller reports it like a post).
   */
  finalize(p: OutboundPayload, popts: StreamFinalOpts): Promise<string | null | undefined>;
  /** Replaces the preview with one fixed code-written line (a halt). No preview: nothing. Never throws. */
  finalizeStopped(line: string, popts?: Pick<StreamFinalOpts, 'onCode'>): Promise<void>;
  /** The `finally` path of the run: idempotent; releases the slot, clears timers and, when the preview is still open, replaces it with a fixed line. Never throws. */
  release(onCode?: (ids: string[]) => void): Promise<void>;
}

export type StreamBuilt<M> = { msgs: M[]; /** a card, or a text that must route (`<@`, a literal handle): it goes out as a fresh post */ fresh: boolean };

export interface StreamIO<M> {
  /** The halt predicate of the agent loop; a throw counts as halted (S10). */
  halted(): boolean;
  /** The port's live literal-secret list (S3), read at every use. */
  secrets(): readonly string[];
  /** Whether a typing indicator can be shown at all (heads only). */
  readonly typingOk: boolean;
  typing(): Promise<void>;
  /** The masked, defanged message showing `text` (compose with noHandles). May throw: that write is skipped (S4). */
  preview(text: string): Promise<M>;
  /** Creates the preview message; returns its id. */
  open(m: M): Promise<string>;
  /** Replaces the content of the preview message: 'gone' when it no longer exists (10008); other errors throw. */
  write(id: string, m: M): Promise<'ok' | 'gone'>;
  /** The final payload built exactly like `post`. */
  final(p: OutboundPayload): Promise<StreamBuilt<M>>;
  /** Today's post path (port.post), recording via popts. */
  fresh(p: OutboundPayload, popts: Pick<StreamFinalOpts, 'replyToId' | 'onSent'>): Promise<string>;
  /** Sends the rest of a long final (messages 2..n); returns their ids. */
  more(msgs: M[], onSent: (ids: string[]) => void): Promise<void>;
  now(): number;
}

export type StreamLogger = { info(o: Record<string, unknown>, m: string): void; warn(o: Record<string, unknown>, m: string): void };

export type EngineOptions = {
  log: StreamLogger;
  /** Re-evaluated right before the first create (S5); false or a throw = no preview. */
  canCreate?: () => Promise<boolean>;
  /** Called exactly once when the slot is no longer needed. */
  onClose: () => void;
  /** No slot: typing only (over the caps, or a persona); update/finalize do nothing. */
  typingOnly?: boolean;
};

const POINTER = '-# (answer posted below)';
const INTERRUPTED = '-# (reply interrupted)';
const FREEZE_CODES = new Set([50001, 50013, 10015]);
const SLOW_MS = 3000;
const FAIL_LIMIT = 3;
const POLL_MS = 300;

/** Only a code and an HTTP status ever leave here: a Discord error carries the partial answer in its request body (S15). */
const codes = (e: unknown): { code?: number; status?: number } => {
  const x = e as { code?: unknown; status?: unknown } | null;
  return { ...(typeof x?.code === 'number' ? { code: x.code } : {}), ...(typeof x?.status === 'number' ? { status: x.status } : {}) };
};

export class ReplyStreamEngine<M> implements ReplyStream {
  private raw = '';
  private previewId: string | null = null;
  private shown = '';
  private basis = 0;
  private lastAt = 0;
  private firstAt: number | null = null;
  private interval = EDIT_INTERVAL_MS;
  private fails = 0;
  private writes = 0;
  private frozen = false;
  private gone = false;
  private closed = false;
  private done = false;
  private slotFreed = false;
  private busy: Promise<void> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private typingTimer: ReturnType<typeof setTimeout> | null = null;
  private typingStart: number | null = null;

  constructor(private readonly io: StreamIO<M>, private readonly o: EngineOptions) {}

  active(): boolean {
    return this.previewId !== null;
  }

  private halted(): boolean {
    try {
      return this.io.halted();
    } catch {
      return true;
    }
  }

  // ---- typing -----------------------------------------------------------------------------------------------------------------
  typing(): void {
    if (!this.io.typingOk || this.typingStart !== null || this.closed) return;
    this.typingStart = this.io.now();
    const loop = async (): Promise<void> => {
      this.typingTimer = null;
      if (this.closed || this.previewId !== null || this.halted() || this.io.now() - this.typingStart! > TYPING_MAX_MS) return;
      try {
        await this.io.typing();
      } catch (e) {
        this.o.log.warn({ op: 'typing', ...codes(e) }, 'reply stream typing failed');
        return;
      }
      if (this.closed || this.previewId !== null) return;
      this.typingTimer = setTimeout(() => void loop(), TYPING_REFRESH_MS);
    };
    void loop();
  }

  // ---- preview ----------------------------------------------------------------------------------------------------------------
  update(raw: string): void {
    if (this.o.typingOnly || this.closed || this.frozen) return;
    this.raw = raw;
    if (raw.length > 0 && this.firstAt === null) this.firstAt = this.io.now();
    this.arm(0);
  }

  restart(): void {
    this.raw = '';
    this.basis = 0;
  }

  private arm(ms: number): void {
    if (this.timer || this.closed || this.frozen) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.tick();
    }, Math.max(0, ms));
  }

  private freeze(): void {
    this.frozen = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private tick(): void {
    if (this.closed || this.frozen || this.busy) return;
    if (this.halted()) return this.freeze();
    if (this.writes >= EDIT_CAP) return this.freeze();
    if (this.raw.length === 0) return;
    const committed = committable(this.raw, this.io.secrets());
    const now = this.io.now();
    if (this.previewId === null) {
      const waited = now - (this.firstAt ?? now);
      if (committed.length >= MIN_FIRST_CHARS || (committed.length > 0 && waited >= FIRST_WAIT_MS)) return this.start(this.create(committed));
      return this.arm(POLL_MS);
    }
    const due = this.lastAt + this.interval - now;
    if (committed === this.shown || committed.length - this.basis < MIN_DELTA) return; // update() re-arms when the text changes
    if (due > 0) return this.arm(due);
    this.start(this.replace(committed));
  }

  private start(job: Promise<void>): void {
    const run = job.finally(() => {
      if (this.busy === run) this.busy = null;
      if (!this.closed && !this.frozen) this.arm(POLL_MS);
    });
    this.busy = run;
  }

  private fail(op: string, e: unknown): void {
    const c = codes(e);
    this.o.log.warn({ op, ...c }, 'reply stream write failed');
    if (c.code === 10008) {
      this.gone = true;
      return this.freeze(); // a person deleted the preview: never create another during the stream (S13)
    }
    if (c.code !== undefined && FREEZE_CODES.has(c.code)) return this.freeze();
    this.fails++;
    this.interval = Math.min(this.interval * 2, EDIT_MAX_INTERVAL_MS);
    if (this.fails >= FAIL_LIMIT) this.freeze();
  }

  private async create(committed: string): Promise<void> {
    let ok = false;
    try {
      ok = this.o.canCreate ? await this.o.canCreate() : true;
    } catch {
      ok = false;
    }
    if (!ok) return this.freeze();
    if (this.halted()) return this.freeze();
    let m: M;
    try {
      m = await this.io.preview(committed + ELLIPSIS);
    } catch {
      this.o.log.warn({ op: 'create', reason: 'build' }, 'reply stream preview skipped');
      return;
    }
    if (this.halted()) return this.freeze(); // Gate 2 G2S-02: the build awaited Discord; re-check right before the write (S10)
    const t0 = this.io.now();
    try {
      this.writes++;
      this.previewId = await this.io.open(m);
    } catch (e) {
      return this.fail('create', e);
    }
    this.shown = committed;
    this.basis = committed.length;
    this.lastAt = this.io.now();
    this.fails = 0;
    if (this.lastAt - t0 > SLOW_MS) this.interval = Math.min(this.interval * 2, EDIT_MAX_INTERVAL_MS);
  }

  private async replace(committed: string): Promise<void> {
    let m: M;
    try {
      m = await this.io.preview(committed + ELLIPSIS);
    } catch {
      this.o.log.warn({ op: 'edit', reason: 'build' }, 'reply stream preview skipped');
      this.lastAt = this.io.now();
      return;
    }
    if (this.halted()) return this.freeze(); // Gate 2 G2S-02: the build awaited Discord; re-check right before the write (S10)
    const t0 = this.io.now();
    try {
      this.writes++;
      const r = await this.io.write(this.previewId!, m);
      if (r === 'gone') {
        this.gone = true;
        this.o.log.warn({ op: 'edit', code: 10008 }, 'reply stream write failed');
        return this.freeze();
      }
    } catch (e) {
      this.lastAt = this.io.now();
      return this.fail('edit', e);
    }
    this.shown = committed;
    this.basis = committed.length;
    this.lastAt = this.io.now();
    this.fails = 0;
    if (this.lastAt - t0 > SLOW_MS) this.interval = Math.min(this.interval * 2, EDIT_MAX_INTERVAL_MS);
  }

  // ---- endings ----------------------------------------------------------------------------------------------------------------
  /** No new write starts; waits for the one in flight. */
  private async quiesce(): Promise<void> {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.typingTimer) clearTimeout(this.typingTimer);
    this.timer = this.typingTimer = null;
    while (this.busy) await this.busy.catch(() => undefined);
  }

  private free(): void {
    this.done = true;
    if (this.slotFreed) return;
    this.slotFreed = true;
    this.o.onClose();
  }

  async finalize(p: OutboundPayload, popts: StreamFinalOpts): Promise<string | null | undefined> {
    if (this.done) return undefined;
    await this.quiesce();
    const preview = this.previewId;
    if (preview === null) {
      this.free();
      return undefined;
    }
    this.done = true;
    let outcome: 'edited' | 'fresh' | 'gone' | 'alert' = p.type === 'alert' ? 'alert' : 'edited';
    let pointed = false;
    let previewIsAnswer = false; // the preview carries the answer only when the final text was written into it (S6)
    try {
      const built = await this.io.final(p);
      const fresh = async (): Promise<string> => this.io.fresh(p, { ...(popts.replyToId ? { replyToId: popts.replyToId } : {}), ...(popts.onSent ? { onSent: popts.onSent } : {}) });
      if (built.fresh) {
        // a card or a live mention that must route: an edit never routes or pings, so it goes out as a new message and the preview points to it (S7, S8)
        if (outcome !== 'alert') outcome = 'fresh';
        const id = await fresh();
        await this.point(preview);
        pointed = true;
        return id;
      }
      let r: 'ok' | 'gone' | 'error' = 'error';
      try {
        r = await this.io.write(preview, built.msgs[0]!);
      } catch (e) {
        this.o.log.warn({ op: 'final', ...codes(e) }, 'reply stream write failed');
      }
      if (r !== 'ok') {
        if (outcome !== 'alert') outcome = 'gone';
        const id = await fresh(); // the preview cannot take the answer (deleted or not writable): one fresh post
        await this.point(preview);
        pointed = true;
        return id;
      }
      const ids = [preview];
      previewIsAnswer = true;
      try {
        if (built.msgs.length > 1) await this.io.more(built.msgs.slice(1), (x) => ids.push(...x)); // ids of a partly failed split are kept (G2S-03)
      } finally {
        popts.onSent?.(ids);
      }
      return preview;
    } catch (e) {
      // the final could not be delivered: the partial text must not stay as if it were the answer (G2S-04)
      if (!previewIsAnswer && !pointed) await this.point(preview, INTERRUPTED);
      throw e;
    } finally {
      this.o.log.info({ outcome }, 'reply stream finalized');
      if (!previewIsAnswer) {
        try {
          popts.onCode?.([preview]); // a pointer or an unwritable preview: recorded as a non-answer
        } catch {
          // recording problems never change the ending
        }
      }
      this.free();
    }
  }

  /** The preview of a stream whose answer went out as a fresh post: a fixed pointer (code line, never an answer). */
  private async point(preview: string, line: string = POINTER): Promise<void> {
    try {
      await this.io.write(preview, await this.io.preview(line));
    } catch (e) {
      this.o.log.warn({ op: 'pointer', ...codes(e) }, 'reply stream write failed');
    }
  }

  async finalizeStopped(line: string, popts?: Pick<StreamFinalOpts, 'onCode'>): Promise<void> {
    if (this.done) return;
    await this.quiesce();
    const preview = this.previewId;
    this.done = true;
    try {
      if (preview !== null) {
        try {
          await this.io.write(preview, await this.io.preview(line));
        } catch (e) {
          this.o.log.warn({ op: 'stopped', ...codes(e) }, 'reply stream write failed');
        }
        popts?.onCode?.([preview]);
        this.o.log.info({ outcome: 'halted' }, 'reply stream finalized');
      }
    } finally {
      this.free();
    }
  }

  async release(onCode?: (ids: string[]) => void): Promise<void> {
    if (this.done) {
      this.free();
      return;
    }
    try {
      await this.quiesce();
    } catch {
      // never throws
    }
    const preview = this.previewId;
    this.done = true;
    try {
      if (preview !== null) {
        try {
          await this.io.write(preview, await this.io.preview(INTERRUPTED));
        } catch (e) {
          this.o.log.warn({ op: 'interrupted', ...codes(e) }, 'reply stream write failed');
        }
        try {
          onCode?.([preview]);
        } catch {
          // recording problems never escape the finally path
        }
      }
    } finally {
      this.free();
    }
  }
}

/** The typing-only handle (over the caps, or an actor that cannot type or stream): never a preview, never a slot. */
export const typingOnly = <M>(io: Pick<StreamIO<M>, 'halted' | 'typing' | 'typingOk' | 'now'> & Partial<StreamIO<M>>, o: Omit<EngineOptions, 'typingOnly'>): ReplyStream =>
  new ReplyStreamEngine<M>(io as StreamIO<M>, { ...o, typingOnly: true });
