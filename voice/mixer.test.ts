import { describe, expect, it } from 'vitest';
import { PcmMixer } from './mixer.js';

const s16 = (...v: number[]) => { const b = Buffer.alloc(v.length * 2); v.forEach((x, i) => b.writeInt16LE(x, i * 2)); return b; };
const read = (b: Buffer) => Array.from({ length: b.length / 2 }, (_, i) => b.readInt16LE(i * 2));
const run = async (m: PcmMixer, input: Buffer[]) => {
  const out: Buffer[] = [];
  m.on('data', (c: Buffer) => out.push(c));
  const ended = new Promise((r) => m.once('end', r));
  for (const c of input) m.write(c);
  m.end();
  await ended;
  return read(Buffer.concat(out));
};

describe('mixer', () => {
  it('adds the overlay to the music sample by sample, saturating at int16', async () => {
    const m = new PcmMixer();
    const done = m.add(s16(100, -100, 30000, -30000));
    expect(await run(m, [s16(1, 2, 10000, -10000, 7, 8)])).toEqual([101, -98, 32767, -32768, 7, 8]);
    await done;
  });

  it('music chunks split mid-sample are handled; the overlay continues across chunks', async () => {
    const m = new PcmMixer();
    void m.add(s16(10, 20, 30));
    const music = s16(1, 1, 1, 1);
    expect(await run(m, [music.subarray(0, 3), music.subarray(3)])).toEqual([11, 21, 31, 1]);
  });

  it('music that ends first: the rest of the reply is still played, then add() resolves', async () => {
    const m = new PcmMixer();
    const done = m.add(s16(5, 6, 7));
    expect(await run(m, [s16(1)])).toEqual([6, 6, 7]);
    await done;
  });

  it('destroy resolves pending replies (leave, a replaced source)', async () => {
    const m = new PcmMixer();
    const done = m.add(s16(1, 2));
    m.destroy();
    await done;
  });

  it('queues at most 2 clips: a third is dropped (resolves at once, never mixed)', async () => {
    const m = new PcmMixer();
    const a = m.add(s16(1, 1));
    const b = m.add(s16(2, 2));
    let thirdDone = false;
    void m.add(s16(100, 100)).then(() => { thirdDone = true; });
    await Promise.resolve();
    expect(thirdDone).toBe(true);
    expect(await run(m, [s16(0, 0, 0, 0)])).toEqual([1, 1, 2, 2]); // clips 1 and 2 mixed one after the other, the third absent
    await Promise.all([a, b]);
  });

  it('an aborted clip (overlay timeout) is dropped from the queue and its promise resolves', async () => {
    const m = new PcmMixer();
    const ac = new AbortController();
    const a = m.add(s16(50, 50, 50, 50), ac.signal);
    const b = m.add(s16(7, 7));
    ac.abort();
    await a;
    expect(m.mixing).toBe(true); // b is still queued
    expect(await run(m, [s16(0, 0, 0, 0)])).toEqual([7, 7, 0, 0]); // the dropped clip left no sound behind
    await b;
    const late = new AbortController();
    late.abort();
    await new PcmMixer().add(s16(1), late.signal); // already aborted: resolves immediately
  });
});
