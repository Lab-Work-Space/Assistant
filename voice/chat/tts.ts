// decodeToPcm and PCM_CAP live in media/decode.ts (shared with the media sidecar).
export { decodeToPcm, PCM_CAP } from '../../media/decode.js';

/** Text to speech: returns raw s16le 48 kHz stereo PCM (the voice session's only input format, P8), in memory. */
export interface Tts {
  synthesize(text: string, voice: string): Promise<Buffer>;
}

/** An Edge neural voice name (`voice.ttsVoice`); it is interpolated into the SSML `<voice name>`, so nothing else may pass. */
export const TTS_VOICE_RE = /^[a-z]{2,3}-[A-Z]{2}-[A-Za-z]+Neural$/;
export const MAX_SPOKEN_CHARS = 800;
/** Edge mp3 for one reply (24 kHz 48 kbit/s is 6 kB/s: about 5 minutes) and the decoded PCM (192 kB/s: 2 minutes). */
export const MP3_CAP = 2 * 1024 * 1024;
const SYNTH_TIMEOUT_MS = 30_000;

/** Reply text as something to say: no code, links, mentions or markdown marks; one line; capped at a word boundary. */
export function speakableText(s: string, max = MAX_SPOKEN_CHARS): string {
  let t = String(s)
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<(?:@[!&]?|#|a?:\w+:)\d+>/g, ' ')
    .replace(/\bhttps?:\/\/\S+/gi, ' ')
    .replace(/[*_~|]{1,3}/g, '')
    .replace(/^\s{0,3}(?:#{1,6}|>|[-+]|\d+\.)\s+/gm, '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (t.length > max) {
    const cut = t.slice(0, max);
    const sp = cut.lastIndexOf(' ');
    t = (sp > max * 0.6 ? cut.slice(0, sp) : cut).trim();
  }
  return t;
}

const XML: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' };
/** msedge-tts puts the text into its SSML template unescaped; escaping makes every character text, never markup. */
export const ssmlEscape = (s: string): string => s.replace(/[&<>"']/g, (c) => XML[c]!);

/** Text (already escaped) + voice → encoded audio (mp3). */
export type EdgeSynth = (text: string, voice: string) => Promise<Buffer>;

type EdgeModule = { MsEdgeTTS: new (o: { connectionTimeoutMs?: number; synthesisTimeoutMs?: number }) => EdgeClient; OUTPUT_FORMAT: Record<string, string> };
type EdgeClient = {
  setMetadata(voice: string, format: string): Promise<void>;
  toStream(text: string): { audioStream: AsyncIterable<Buffer> & { destroy(): void } };
  close(): void;
};

/**
 * msedge-tts 2.1.1 (pinned, task-37-report Step 0): one WebSocket per reply to the fixed Microsoft endpoint
 * `wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1` (nothing user-influenced: not the host, not the
 * path). Only `setMetadata` + `toStream` are used: never `toFile` (writes files) and never `getVoices` (axios). The reply text goes
 * to Microsoft (docs/features/media-music-voice.md#voice-and-music). Bounded by a byte cap and a wall-clock timeout; the client is closed after every reply.
 */
export function edgeSynth(o: { capBytes?: number; timeoutMs?: number; load?: () => Promise<EdgeModule> } = {}): EdgeSynth {
  const cap = o.capBytes ?? MP3_CAP;
  return async (text, voice) => {
    const m = await (o.load ?? loadEdge)();
    const client = new m.MsEdgeTTS({ connectionTimeoutMs: 10_000, synthesisTimeoutMs: 15_000 });
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => (client.close(), reject(new Error('Edge TTS timed out'))), o.timeoutMs ?? SYNTH_TIMEOUT_MS);
    });
    const run = async () => {
      await client.setMetadata(voice, m.OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3 ?? 'audio-24khz-48kbitrate-mono-mp3');
      const { audioStream } = client.toStream(text);
      const parts: Buffer[] = [];
      let n = 0;
      for await (const c of audioStream) {
        n += c.length;
        if (n > cap) {
          audioStream.destroy();
          throw new Error('Edge TTS audio over its cap');
        }
        parts.push(Buffer.from(c));
      }
      return Buffer.concat(parts);
    };
    try {
      return await Promise.race([run(), timeout]);
    } finally {
      clearTimeout(timer);
      client.close();
    }
  };
}

async function loadEdge(): Promise<EdgeModule> {
  const m = (await import('msedge-tts')) as unknown as EdgeModule & { default?: EdgeModule };
  return m.MsEdgeTTS ? m : m.default!;
}

/** Edge TTS (Microsoft) → the media backend's decode (our ffmpeg) → PCM for VoiceSession.overlay. */
export class EdgeTts implements Tts {
  private readonly synth: EdgeSynth;

  constructor(private readonly o: { decode: (mp3: Buffer) => Promise<Buffer>; synth?: EdgeSynth }) {
    this.synth = o.synth ?? edgeSynth();
  }

  async synthesize(text: string, voice: string): Promise<Buffer> {
    if (!TTS_VOICE_RE.test(voice)) throw new Error('voice.ttsVoice is not an Edge neural voice name');
    const say = ssmlEscape(speakableText(text));
    if (!say) throw new Error('nothing to say');
    const mp3 = await this.synth(say, voice);
    if (!mp3.length) throw new Error('Edge TTS returned no audio');
    return this.o.decode(mp3);
  }
}
