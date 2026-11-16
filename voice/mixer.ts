import { Transform, type TransformCallback } from 'node:stream';

type Clip = { buf: Buffer; off: number; done: () => void };
/** At most this many clips wait or play at once; a spoken reply beyond that is dropped (a backlog would talk over itself for minutes). */
export const MAX_QUEUED_CLIPS = 2;
const clamp = (v: number) => (v > 32767 ? 32767 : v < -32768 ? -32768 : v);

/**
 * Mixes short clips (a spoken reply, s16le 48 kHz stereo) over the PCM flowing through it (the music, already volume-scaled and
 * ducked upstream), sample by sample with int16 saturation. It sits between the volume transformer and the opus encoder, so the
 * music keeps its position and never stops (AC12b: ducking, no pause). The encoder pulls at real time, so a clip is consumed at
 * real time too. In memory only (P20): a clip is a Buffer, dropped once mixed.
 */
export class PcmMixer extends Transform {
  private readonly clips: Clip[] = [];
  /** A byte of a sample split across two music chunks. */
  private carry: Buffer | null = null;

  /**
   * Queues a clip; resolves when it has been mixed out, when the stream ends or is destroyed (leave, replaced source), when the
   * queue is full (MAX_QUEUED_CLIPS: the clip is dropped) or when `signal` aborts (the caller gave up: the clip is removed unplayed).
   */
  add(pcm: Buffer, signal?: AbortSignal): Promise<void> {
    if (this.destroyed || this.writableEnded || signal?.aborted || this.clips.length >= MAX_QUEUED_CLIPS) return Promise.resolve();
    return new Promise<void>((done) => {
      const clip: Clip = { buf: pcm, off: 0, done };
      this.clips.push(clip);
      signal?.addEventListener('abort', () => {
        const i = this.clips.indexOf(clip);
        if (i >= 0) this.clips.splice(i, 1);
        done();
      }, { once: true });
    });
  }

  get mixing(): boolean {
    return this.clips.length > 0;
  }

  override _transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback): void {
    let b = this.carry ? Buffer.concat([this.carry, chunk]) : chunk;
    this.carry = null;
    if (b.length % 2) {
      this.carry = Buffer.from(b.subarray(b.length - 1));
      b = b.subarray(0, b.length - 1);
    }
    if (!this.clips.length || !b.length) return cb(null, b.length ? b : undefined);
    const out = Buffer.from(b); // never write into the upstream buffer
    for (let i = 0; i + 1 < out.length && this.clips.length; i += 2) {
      const c = this.clips[0]!;
      out.writeInt16LE(clamp(out.readInt16LE(i) + c.buf.readInt16LE(c.off)), i);
      c.off += 2;
      if (c.off + 1 >= c.buf.length) this.finish();
    }
    cb(null, out);
  }

  /** The music ended first: the rest of the clips are played as they are, then the stream ends. */
  override _flush(cb: TransformCallback): void {
    const rest: Buffer[] = [];
    while (this.clips.length) {
      const c = this.clips[0]!;
      const even = c.buf.length - (c.buf.length % 2);
      if (c.off < even) rest.push(c.buf.subarray(c.off, even));
      this.finish();
    }
    cb(null, rest.length ? Buffer.concat(rest) : undefined);
  }

  override _destroy(err: Error | null, cb: (e: Error | null) => void): void {
    while (this.clips.length) this.finish();
    cb(err);
  }

  private finish(): void {
    this.clips.shift()?.done();
  }
}
