import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeConfig } from '../../governance/test-helpers.js';
import { FakeVoiceSession } from '../../tests/fakes/voice.js';
import { VoiceMinuteCap } from './caps.js';
import { VoicePipeline } from './pipeline.js';
import { chunks, fakeAsk, flush, silence, tone } from './test-helpers.js';
import { decodeToPcm, EdgeTts, speakableText, ssmlEscape, TTS_VOICE_RE } from './tts.js';

const FFMPEG = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'tests', 'fakes', 'bin', 'ffmpeg');
const log = { info() {}, warn() {}, error() {} };
let dir: string | null = null;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

describe('tts', () => {
  it('reply text is made speakable: markdown, links, code and mentions are dropped, length capped', () => {
    expect(speakableText('**สวัสดี** ดู [ลิงก์](https://x.example/a) `code` <@123> https://y.example/b ค่ะ')).toBe('สวัสดี ดู ลิงก์ code ค่ะ');
    expect(speakableText('```\nconst a = 1\n```\nเสร็จแล้ว')).toBe('เสร็จแล้ว');
    expect(speakableText('ก'.repeat(5000)).length).toBeLessThanOrEqual(800);
  });

  it('SSML is escaped so reply text can never add tags (voice, prosody, audio) to the Edge request', () => {
    expect(ssmlEscape(`<voice name="x">&'"`)).toBe('&lt;voice name=&quot;x&quot;&gt;&amp;&apos;&quot;');
    expect(TTS_VOICE_RE.test('th-TH-NiwatNeural')).toBe(true);
    for (const bad of ['th-TH-Niwat"><x', 'th-TH-NiwatNeural ', '../x', '']) expect(TTS_VOICE_RE.test(bad), bad).toBe(false);
  });

  it('EdgeTts sends escaped text and decodes the mp3 with our ffmpeg (pipe only, s16le 48 kHz stereo)', async () => {
    dir = mkdtempSync(join(tmpdir(), 'tts-test-'));
    const logFile = join(dir, 'argv.log');
    const sent: { text: string; voice: string }[] = [];
    const tts = new EdgeTts({ decode: (b) => decodeToPcm(b, { ffmpeg: FFMPEG, extraEnv: { FAKE_BIN_LOG: logFile } }), synth: async (text, voice) => (sent.push({ text, voice }), Buffer.from('MP3DATA')) });
    const pcm = await tts.synthesize('a < b & "c"', 'th-TH-NiwatNeural');
    expect(pcm.toString()).toBe('MP3DATA'); // the fake ffmpeg passes stdin through
    expect(sent).toEqual([{ text: 'a &lt; b &amp; &quot;c&quot;', voice: 'th-TH-NiwatNeural' }]);
    expect(readFileSync(logFile, 'utf8')).toContain('-protocol_whitelist pipe -i pipe:0 -vn -f s16le -ar 48000 -ac 2 pipe:1');
    await expect(tts.synthesize('hi', 'bad"voice')).rejects.toThrow(/voice/);
  });

  it('decodeToPcm enforces its output cap', async () => {
    await expect(decodeToPcm(Buffer.alloc(4096), { ffmpeg: FFMPEG, timeoutMs: 5000, capBytes: 1024 })).rejects.toThrow(/cap|too long/i);
  });

  it('error → text reply posted instead, no crash', async () => {
    const s = new FakeVoiceSession();
    await s.join('vc', 'g');
    const posted: string[] = [];
    const { ask } = fakeAsk('ตอบเป็นข้อความแทน S3cretLiteral99');
    const p = new VoicePipeline({
      session: s, stt: { transcribe: async () => 'สวัสดี' }, tts: { synthesize: async () => { throw new Error('edge down'); } }, secrets: ['S3cretLiteral99'], ask,
      cfg: new FakeConfig(), announce: async (t) => void posted.push(t), log, audit: async () => {},
      channel: { channelId: 'tc', parentChannelId: null }, nameOf: (u) => u, allowed: () => true, isBot: () => false, minutes: new VoiceMinuteCap(new FakeConfig(), () => 0),
    });
    p.start();
    s.speak('u1', chunks(tone(500), silence(900)));
    await flush(60);
    expect(posted).toEqual(['ตอบเป็นข้อความแทน [REDACTED]']); // P24: the fallback text is masked too
    expect(s.overlays).toHaveLength(0);
    expect(s.ducked).toBe(false);
    p.stop();
  });
});
