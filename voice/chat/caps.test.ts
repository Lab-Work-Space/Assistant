import { describe, expect, it } from 'vitest';
import { FakeConfig } from '../../governance/test-helpers.js';
import { FakeVoiceSession } from '../../tests/fakes/voice.js';
import { VoiceMinuteCap } from './caps.js';
import { VoicePipeline, type VoicePipelineDeps } from './pipeline.js';
import { chunks, fakeAsk, flush, silence, tone } from './test-helpers.js';

const log = { info() {}, warn() {}, error() {} };

describe('VoiceMinuteCap', () => {
  it('counts seconds per user per UTC day', () => {
    let now = Date.parse('2026-11-01T10:00:00Z');
    const cap = new VoiceMinuteCap(new FakeConfig({ 'limits.voiceMinPerUserDay': 1 }), () => now);
    expect(cap.take('u1', 50)).toBe(true);
    expect(cap.take('u1', 20)).toBe(false); // 70 s > 60 s
    expect(cap.exhausted('u1')).toBe(false);
    expect(cap.take('u1', 10)).toBe(true);
    expect(cap.exhausted('u1')).toBe(true);
    expect(cap.take('u2', 30)).toBe(true); // per user
    now = Date.parse('2026-11-02T00:00:01Z');
    expect(cap.exhausted('u1')).toBe(false); // a new day
  });
});

describe('caps.test.ts', () => {
  it('voice minutes over limits.voiceMinPerUserDay refused with a spoken notice', async () => {
    const cfg = new FakeConfig({ 'limits.voiceMinPerUserDay': 1 });
    const s = new FakeVoiceSession();
    await s.join('vc', 'g');
    const transcribed: number[] = [];
    const { ask, calls } = fakeAsk('ok');
    const spoken: string[] = [];
    const d: VoicePipelineDeps = {
      session: s, stt: { transcribe: async (pcm) => (transcribed.push(pcm.length), 'สวัสดี') },
      tts: { synthesize: async (t) => (spoken.push(t), Buffer.from(t)) }, secrets: [], ask, cfg, announce: async () => {}, log, audit: async () => {},
      channel: { channelId: 'tc', parentChannelId: null }, nameOf: (u) => u, allowed: () => true, isBot: () => false, minutes: new VoiceMinuteCap(cfg, () => 0),
    };
    const p = new VoicePipeline(d);
    p.start();
    s.speak('u1', chunks(tone(40_000), silence(900))); // 40 s: within the 60 s cap
    await flush(80);
    s.speak('u1', chunks(tone(30_000), silence(900))); // would reach 70 s: refused, not sent to STT
    await flush(80);
    s.speak('u1', chunks(tone(1000), silence(900)));
    await flush(80);
    expect(transcribed).toHaveLength(1);
    expect(calls).toHaveLength(1);
    const notices = spoken.filter((t) => /นาที|minutes/.test(t));
    expect(notices).toHaveLength(1); // spoken once, then the user is ignored
    // the user who is over the cap is no longer decoded at all
    const before = s.decoded.length;
    s.speak('u1', chunks(tone(500), silence(900)));
    await flush(20);
    expect(s.decoded.length).toBe(before);
    p.stop();
  });
});
