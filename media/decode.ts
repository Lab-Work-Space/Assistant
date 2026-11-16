import { buildFfmpegArgs, spawnSafe } from '../voice/music/source.js';

/** Decoded PCM for one reply (192 kB/s: 2 minutes). */
export const PCM_CAP = 120 * 48_000 * 2 * 2;
export const DECODE_TIMEOUT_MS = 20_000;

/**
 * Encoded audio → raw s16le 48 kHz stereo through OUR ffmpeg (the controller ruling, P8): spawnSafe with childEnv, shell off, own
 * process group, `-protocol_whitelist pipe -i pipe:0` (buildFfmpegArgs), stdin/stdout pipes only, a timeout and an output cap.
 * childEnv gives the child an empty private HOME (0700, removed at exit); no audio byte ever touches a file.
 */
export async function decodeToPcm(
  audio: Buffer,
  o: { ffmpeg: string; timeoutMs?: number; capBytes?: number; extraEnv?: Record<string, string>; signal?: AbortSignal },
): Promise<Buffer> {
  const c = spawnSafe(o.ffmpeg, buildFfmpegArgs(), { timeoutMs: o.timeoutMs ?? DECODE_TIMEOUT_MS, stdoutCap: o.capBytes ?? PCM_CAP, stdin: true, ...(o.extraEnv ? { extraEnv: o.extraEnv } : {}) });
  // `signal` (the media sidecar: client gone, shutdown) kills the ffmpeg group; the reason is the abort reason when it is a string
  const onAbort = () => c.kill(typeof o.signal?.reason === 'string' ? o.signal.reason : 'aborted');
  if (o.signal?.aborted) onAbort();
  else o.signal?.addEventListener('abort', onAbort, { once: true });
  void c.done.finally(() => o.signal?.removeEventListener('abort', onAbort));
  const parts: Buffer[] = [];
  c.stdout.on('data', (b: Buffer) => parts.push(b));
  c.stdin?.end(audio);
  const exit = await c.done;
  if (exit.reason === 'stdout-cap') throw new Error('the reply is too long to speak (decoded audio over its cap)');
  if (exit.reason || exit.code !== 0) throw new Error(`ffmpeg could not decode the speech (${exit.reason ?? `exit ${exit.code}`})`);
  return Buffer.concat(parts);
}
