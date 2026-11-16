import { describe, expect, it } from 'vitest';
import { createMeteredModel, MeteredError } from '../../agents/call/metered.js';
import { ScriptedBudget } from '../../agents/loop/loop-fixture.js';
import { auditSpy, newBus } from '../../agents/test-helpers.js';
import { estimateInputTokens } from '../../agents/context.js';
import { Budget } from '../../governance/budget.js';
import { Halt } from '../../governance/halt.js';
import { FakeConfig } from '../../governance/test-helpers.js';
import { FakeProvider, ProviderRegistry } from '../../providers/index.js';
import { GeminiStt, toWav16k, usableTranscript } from './stt.js';
import { RATE, tone } from './test-helpers.js';

function rig(texts: string[], o: { exhausted?: boolean } = {}) {
  const cfg = new FakeConfig();
  const bus = newBus();
  const budget = new ScriptedBudget(new Budget(null as never, cfg, bus));
  if (o.exhausted) budget.next = async () => ({ ok: false, scope: 'bot' });
  const fake = new FakeProvider(texts.map((text) => ({ text, usage: { inputTokens: 500, outputTokens: 10 } })), 'gemini');
  const providers = new ProviderRegistry();
  providers.register(fake);
  const spy = auditSpy();
  const halt = new Halt(cfg, { listByStatus: async () => [], update: async () => null }, bus);
  const metered = createMeteredModel({ providers, cfg, budget, audit: spy.audit, halt });
  return { stt: new GeminiStt({ metered }), fake, spy, budget };
}

describe('stt', () => {
  it('48 kHz mono PCM becomes a 16 kHz mono WAV in memory (44-byte RIFF header)', () => {
    const wav = toWav16k(tone(1000), RATE);
    expect(wav.subarray(0, 4).toString()).toBe('RIFF');
    expect(wav.subarray(8, 12).toString()).toBe('WAVE');
    expect(wav.readUInt16LE(22)).toBe(1); // mono
    expect(wav.readUInt32LE(24)).toBe(16_000);
    expect(wav.readUInt16LE(34)).toBe(16);
    expect(wav.readUInt32LE(40)).toBe(32_000); // 1 s of 16 kHz s16
    expect(wav.length).toBe(44 + 32_000);
  });

  it('sends one audio/wav media block through the metered model (gemini) and returns the transcript', async () => {
    const t = rig(['  สวัสดีพราว  ']);
    expect(await t.stt.transcribe(tone(1000), { sampleRate: RATE, lang: 'th' })).toBe('สวัสดีพราว');
    const req = t.fake.calls[0]!;
    const media = req.messages[0]!.content.find((b) => b.type === 'media');
    expect(media).toMatchObject({ type: 'media', mimeType: 'audio/wav' });
    expect(req.tools).toEqual([]);
    expect(req.system).toMatch(/transcri/i);
  });

  it('empty/garbage transcript ignored', async () => {
    for (const s of ['', '   ', '<none>', '[inaudible]', '(silence)', '...', '"…"', '♪♪', 'NONE']) expect(usableTranscript(s), s).toBe('');
    expect(usableTranscript('"เปิดเพลงหน่อย"')).toBe('เปิดเพลงหน่อย');
    const t = rig(['<none>']);
    expect(await t.stt.transcribe(tone(500), { sampleRate: RATE })).toBe('');
  });

  it('STT spend is metered (audit llm.call, /usage) and refused with a spoken "budget used up" reply when the bot budget is exhausted', async () => {
    const t = rig(['ok']);
    await t.stt.transcribe(tone(500), { sampleRate: RATE });
    expect(t.spy.entries.filter((e) => e.action === 'llm.call' && e.provider === 'gemini')).toHaveLength(1);
    expect(t.budget.reserves).toHaveLength(1);
    // exhausted budget: the metered call refuses before any provider call (the pipeline turns this into the spoken notice)
    const poor = rig(['never'], { exhausted: true });
    await expect(poor.stt.transcribe(tone(500), { sampleRate: RATE })).rejects.toMatchObject({ name: 'MeteredError', reason: 'budget' });
    expect(poor.fake.calls).toHaveLength(0);
    expect(MeteredError).toBeDefined();
  });

  it('audio is reserved at 32 tokens per second (Gemini audio docs), not as an image', () => {
    const wav = toWav16k(tone(10_000), RATE); // 10 s
    const est = estimateInputTokens({ system: '', tools: [], messages: [{ role: 'user', content: [{ type: 'media', mimeType: 'audio/wav', data: wav.toString('base64') }] }] });
    expect(est).toBeGreaterThanOrEqual(320);
    expect(est).toBeLessThan(400);
  });
});
