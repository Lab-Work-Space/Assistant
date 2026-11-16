import { describe, expect, it } from 'vitest';
import { VisionCap } from '../../../agents/loop/vision.js';
import { FakeConfig } from '../../../governance/test-helpers.js';
import { SHEETS, THAI_JSON, receiptRig } from './receipt-fixture.js';

describe('vision cap in the tools (P15)', () => {
  it('every extract_receipt extraction takes one slot of the human; over the cap: error, no download, no model call', async () => {
    const vision = new VisionCap(new FakeConfig({ 'limits.visionPerUserDay': 2 }), () => 0);
    const rig = await receiptRig({ vision, replies: [THAI_JSON, THAI_JSON, THAI_JSON] });
    expect((await rig.reg.run('extract_receipt', {}, rig.c)).isError).toBeFalsy();
    expect((await rig.reg.run('extract_receipt', {}, rig.c)).isError).toBeFalsy();
    const calls = rig.provider.calls.length;
    const c = await rig.reg.run('extract_receipt', {}, rig.c);
    expect(c.isError).toBe(true);
    expect(c.content).toMatch(/daily limit/i);
    expect(rig.provider.calls.length).toBe(calls);
  });
});

describe('halt-linked download (T32 minor)', () => {
  it('the download runs under a controller registered with halt; a halt aborts it before any model call, and it is released after', async () => {
    let released = 0;
    const halt = { track: (ac: AbortController) => { ac.abort(new Error('halt')); return () => { released++; }; } };
    const rig = await receiptRig({ halt });
    const res = await rig.reg.run('extract_receipt', {}, rig.c);
    expect(res.isError).toBe(true);
    expect(rig.provider.calls).toHaveLength(0);
    expect(released).toBe(1);
  });

  it('a normal run is tracked and released once', async () => {
    let tracked = 0;
    let released = 0;
    const halt = { track: () => { tracked++; return () => { released++; }; } };
    const rig = await receiptRig({ halt });
    expect((await rig.reg.run('extract_receipt', {}, rig.c)).isError).toBeFalsy();
    expect([tracked, released]).toEqual([1, 1]);
  });
});

describe('extract_receipt hint', () => {
  it('names sheets_append_receipt only when the actor may call it (finance stays read-only by default)', async () => {
    const may = await receiptRig({ sheets: SHEETS });
    expect((await may.reg.run('extract_receipt', {}, may.c)).content).toContain('sheets_append_receipt');
    const readOnly = await receiptRig({ sheets: SHEETS });
    readOnly.c.org = { ...readOnly.c.org, toolsFor: () => ['extract_receipt'] };
    const res = await readOnly.reg.run('extract_receipt', {}, readOnly.c);
    expect(res.isError).toBeFalsy();
    expect(res.content).toContain('Receipt read');
    expect(res.content).not.toContain('sheets_append_receipt');
  });
});
