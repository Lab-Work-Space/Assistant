import { checkBinaries, type BinaryCheck, type Exec, type ExpectedSha256 } from '../voice/binaries.js';
import { nodeExec } from '../voice/exec.js';
import { startTrack, type TrackHandle } from '../voice/music/source.js';
import { decodeToPcm } from './decode.js';

export interface TrackRequestOptions {
  allowlist: readonly string[];
  capBytes: number;
  capSeconds: number;
}

/**
 * Where yt-dlp/ffmpeg run. `LocalMediaBackend` runs them in this process's container; `SocketMediaBackend` (media/client.ts) asks the
 * secret-free media sidecar. `why` is an optional boot-alert reason a backend may add to a failed check.
 */
export interface MediaBackend {
  health(): Promise<{ check: BinaryCheck; why?: string }>;
  startTrack(q: string, o: TrackRequestOptions): TrackHandle;
  decode(audio: Buffer): Promise<Buffer>;
}

export interface LocalMediaBackendOptions {
  ytDlp: string;
  ffmpeg: string;
  ytDlpTree?: string;
  jsRuntime: string;
  expectedSha256: ExpectedSha256 | null;
  /** Runs the version checks; default nodeExec (so the app imports no spawn helper itself, Gate 1 S12). */
  exec?: Exec;
  cookiesFile?: string;
  extraEnv?: Record<string, string>;
  log: { warn(o: object, m?: string): void };
  /** A reason string when this process runs in a container the local backend must refuse; null otherwise. Unset: no check. */
  inContainer?: () => string | null;
}

/** What a refusing local backend says (the same text selectMediaBackend disables music and voice with). */
export const NOT_CONFIGURED = 'media sidecar not configured';

export class LocalMediaBackend implements MediaBackend {
  constructor(private readonly o: LocalMediaBackendOptions) {}

  /**
   * Fail closed in a container (spec 4.4): no local yt-dlp/ffmpeg there, whoever built this backend. A plain Error on purpose,
   * never MusicInputError: MusicPlayer skips a track on MusicInputError but pauses the queue on any other start error.
   */
  private refused(): boolean {
    return !!this.o.inContainer?.();
  }

  async health(): Promise<{ check: BinaryCheck; why?: string }> {
    if (this.refused()) return { check: { ok: false, missing: ['yt-dlp', 'ffmpeg'], mismatched: [] }, why: NOT_CONFIGURED };
    if (!this.o.expectedSha256) {
      return { check: { ok: false, missing: [], mismatched: ['yt-dlp', 'ffmpeg'] }, why: `no pinned sha256 for ${process.arch.replace(/[^a-z0-9]/gi, '')}` };
    }
    const check = await checkBinaries({
      ytDlp: this.o.ytDlp, ffmpeg: this.o.ffmpeg, exec: this.o.exec ?? nodeExec, expectedSha256: this.o.expectedSha256,
      ...(this.o.ytDlpTree ? { ytDlpTree: this.o.ytDlpTree } : {}),
    });
    return { check };
  }

  startTrack(q: string, o: TrackRequestOptions): TrackHandle {
    if (this.refused()) throw new Error(NOT_CONFIGURED);
    const allowlist = o.allowlist;
    return startTrack(q, {
      ytDlp: this.o.ytDlp, ffmpeg: this.o.ffmpeg, jsRuntime: this.o.jsRuntime, allowlist: () => allowlist, capBytes: o.capBytes, capSeconds: o.capSeconds,
      log: this.o.log, ...(this.o.cookiesFile ? { cookiesFile: this.o.cookiesFile } : {}), ...(this.o.extraEnv ? { extraEnv: this.o.extraEnv } : {}),
    });
  }

  async decode(audio: Buffer): Promise<Buffer> {
    if (this.refused()) throw new Error(NOT_CONFIGURED);
    return decodeToPcm(audio, { ffmpeg: this.o.ffmpeg, ...(this.o.extraEnv ? { extraEnv: this.o.extraEnv } : {}) });
  }
}
