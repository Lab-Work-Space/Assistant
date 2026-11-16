/** Speech shorter than this is a cough or a click, never sent to STT. */
export const MIN_SPEECH_MS = 300;
/** One utterance is cut here (memory bound; 60 s of 16 kHz WAV is about 1.9 MB, far under Gemini's 20 MB request cap). */
export const MAX_UTTERANCE_MS = 60_000;
/** RMS (int16 units) a 20 ms frame needs to count as speech. Discord sends no packets in true silence; this catches line noise. */
export const SPEECH_RMS = 400;

const FRAME_MS = 20;

export interface VadOptions {
  /** s16le mono input rate (the session decodes at 48 kHz). */
  sampleRate: number;
  /** voice.silenceMs: this much silence inside the stream closes an utterance. */
  silenceMs: number;
  minSpeechMs?: number;
  maxUtteranceMs?: number;
  threshold?: number;
}

/**
 * Per-user voice activity detection over one received stream (s16le mono). Time is counted in samples, not wall clock, so it is
 * deterministic. An utterance starts at the first speech frame, keeps pauses shorter than `silenceMs`, and closes after
 * `silenceMs` of silence (trailing silence trimmed), at the stream end (the session's AfterSilence end) or at `maxUtteranceMs`.
 * Utterances with less than `minSpeechMs` of speech are dropped. Buffers only; nothing is kept once yielded.
 */
export async function* utterances(pcm: AsyncIterable<Uint8Array>, o: VadOptions): AsyncGenerator<Buffer> {
  const frameBytes = ((o.sampleRate * FRAME_MS) / 1000) * 2;
  const minSpeech = o.minSpeechMs ?? MIN_SPEECH_MS;
  const maxMs = o.maxUtteranceMs ?? MAX_UTTERANCE_MS;
  const threshold = o.threshold ?? SPEECH_RMS;
  let pending = Buffer.alloc(0);
  let frames: Buffer[] = [];
  let speechMs = 0;
  let silentMs = 0;

  const close = (): Buffer | null => {
    const kept = frames.slice(0, frames.length - silentMs / FRAME_MS);
    const out = speechMs >= minSpeech && kept.length ? Buffer.concat(kept) : null;
    frames = [];
    speechMs = 0;
    silentMs = 0;
    return out;
  };

  const step = (frame: Buffer): Buffer | null => {
    const speech = rms(frame) >= threshold;
    if (!frames.length && !speech) return null; // leading silence
    frames.push(frame);
    if (speech) {
      speechMs += FRAME_MS;
      silentMs = 0;
    } else silentMs += FRAME_MS;
    if (silentMs >= o.silenceMs || frames.length * FRAME_MS >= maxMs) return close();
    return null;
  };

  for await (const chunk of pcm) {
    pending = pending.length ? Buffer.concat([pending, chunk]) : Buffer.from(chunk);
    let off = 0;
    for (; off + frameBytes <= pending.length; off += frameBytes) {
      const u = step(pending.subarray(off, off + frameBytes));
      if (u) yield u;
    }
    pending = pending.subarray(off);
  }
  const last = close();
  if (last) yield last;
}

function rms(frame: Buffer): number {
  let sum = 0;
  const n = frame.length >> 1;
  for (let i = 0; i < n; i++) {
    const v = frame.readInt16LE(i * 2);
    sum += v * v;
  }
  return n ? Math.sqrt(sum / n) : 0;
}
