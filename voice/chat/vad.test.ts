import { describe, expect, it } from 'vitest';
import { chunks, iter, RATE, silence, tone } from './test-helpers.js';
import { utterances } from './vad.js';

const collect = async (cs: Uint8Array[], silenceMs = 900, extra: { maxUtteranceMs?: number } = {}) => {
  const out: Buffer[] = [];
  for await (const u of utterances(iter(cs), { sampleRate: RATE, silenceMs, ...extra })) out.push(u);
  return out;
};
const ms = (b: Buffer) => (b.length / 2 / RATE) * 1000;

describe('vad', () => {
  it('900 ms silence closes an utterance; shorter pauses do not; speech <300 ms dropped', async () => {
    const two = await collect(chunks(tone(500), silence(900), tone(500), silence(900)));
    expect(two).toHaveLength(2);
    expect(ms(two[0]!)).toBe(500); // trailing silence trimmed

    const one = await collect(chunks(tone(500), silence(600), tone(500), silence(900)));
    expect(one).toHaveLength(1);
    expect(ms(one[0]!)).toBe(1600); // the short pause stays inside the utterance

    expect(await collect(chunks(tone(200), silence(1000)))).toHaveLength(0);
    expect(await collect(chunks(silence(300), tone(280)))).toHaveLength(0); // stream end closes, still too short
  });

  it('leading silence is skipped and the stream end closes an open utterance', async () => {
    const u = await collect(chunks(silence(400), tone(400)));
    expect(u.map(ms)).toEqual([400]);
  });

  it('a long monologue is cut at maxUtteranceMs so memory stays bounded', async () => {
    const u = await collect(chunks(tone(2500)), 900, { maxUtteranceMs: 1000 });
    expect(u.map(ms)).toEqual([1000, 1000, 500]);
  });

  it('odd-sized chunks (split samples) are handled', async () => {
    const all = Buffer.concat([tone(500), silence(900)]);
    const odd = [all.subarray(0, 1001), all.subarray(1001, 5003), all.subarray(5003)];
    expect((await collect(odd)).map(ms)).toEqual([500]);
  });
});
