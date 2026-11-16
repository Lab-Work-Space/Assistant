import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_DUTIES } from '../../../company/duties.js';
import type { ActorRef } from '../../../company/types.js';
import { CONFIG_DEFAULTS } from '../../../config/defaults.js';
import { LIFTED_CAPS } from '../../../governance/budget.js';
import { FakeConfig } from '../../../governance/test-helpers.js';
import { GeminiHttpError } from '../../../providers/gemini/types.js';
import type { ToolContext } from '../../types.js';
import { webRig } from '../web/test-helpers.js';
import type { PluginDeps } from '../deps.js';
import { mediaGroup, type MediaGen } from './index.js';
import { IMAGE_MODEL, IMAGE_PERSON_SUFFIX, RETIRED_MODEL_IDS, VIDEO_MODEL } from './pins.js';

const MKT: ActorRef = { kind: 'head', dept: 'marketing' };
const USAGE = { promptTokens: 100, candidatesTokens: 1120, thoughtsTokens: 0, byModality: [{ modality: 'IMAGE', tokens: 1120 }] };
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.from('fake')]);

type Over = { video?: boolean; actor?: ActorRef; direct?: boolean; tainted?: boolean; cfg?: Record<string, unknown>; duties?: Record<string, readonly string[]>; userId?: string | null; noGen?: boolean;
  reserve?: (r: { estUsd: number }) => unknown; images?: () => Promise<unknown>; models?: () => Promise<unknown>; startVideo?: () => Promise<unknown>; takeOk?: (n: number) => unknown; halted?: boolean };

async function rig(o: Over = {}) {
  const cfg = new FakeConfig((o.cfg ?? {}) as never);
  const posted: { file: { name: string; data: Buffer; contentType: string }; payload: { type: string; body: string } }[] = [];
  const port = { postFile: vi.fn(async (_a: ActorRef, _t: unknown, payload: never, file: never) => (posted.push({ file, payload }), `m${posted.length}`)) };
  let nres = 0;
  const reserve = vi.fn<(r: { estUsd: number }) => Promise<unknown>>(async (r) => (o.reserve ? o.reserve(r) : { ok: true, reservationId: `r${nres++ + 1}` }));
  const settle = vi.fn(async () => undefined);
  const release = vi.fn(async () => undefined);
  const take = vi.fn(async (_k: string, _p: string, n: number) => (o.takeOk ? o.takeOk(n) : { ok: true }));
  const giveBack = vi.fn(async () => undefined);
  const submit = vi.fn(async () => 'job-1234-abcd');
  const generateImage = vi.fn<(r: Record<string, unknown>) => Promise<unknown>>(o.images ?? (async () => ({ image: { data: PNG, mime: 'image/png' }, blocked: false, tooLarge: false, dropped: 0, usage: USAGE })));
  const checkModel = vi.fn(o.models ?? (async () => ({ found: true, actions: ['generateContent'] })));
  const startVideo = vi.fn(o.startVideo ?? (async () => ({ name: 'operations/abc' })));
  const gen = { client: { checkModel, generateImage, startVideo }, budget: { reserve, settle, release }, usage: { take, giveBack }, jobs: { submit }, ...(o.video === false ? {} : { videoEnabled: true as const }) } as unknown as MediaGen;
  const incidents = { report: vi.fn(() => '') };
  const records: unknown[][] = [];
  const deps = { cfg, port, log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }, clock: () => 0, halt: { track: () => () => undefined, isHalted: () => o.halted === true },
    provenance: { record: vi.fn(async (...a: unknown[]) => void records.push(a)) }, incidents, ...(o.noGen ? {} : { mediaGen: gen }) } as unknown as PluginDeps;
  const g = mediaGroup(deps);
  if (!('tools' in g)) return { disabled: g.disabled } as never;
  const actor = o.actor ?? MKT;
  const r = await webRig(g.tools as never, { actor, duties: () => o.duties ?? DEFAULT_DUTIES, direct: o.direct ?? true,
    source: { channelId: 'ch1', threadId: 'th1', messageId: null, userId: o.userId === undefined ? 'u1' : o.userId, attachments: [] } } as Partial<ToolContext>);
  if (o.tainted) r.c.run.markTainted();
  return { ...r, posted, reserve, settle, release, take, giveBack, submit, generateImage, checkModel, startVideo, incidents, records, cfg, tools: g.tools };
}
const img = (extra: object = {}) => ({ prompt: 'a red bicycle in a sunny park', ...extra });
const vid = (extra: object = {}) => ({ prompt: 'waves on a beach at sunset', seconds: 8, ...extra });

describe('RF28 / M2 / M10 config and pins', () => {
  it('defaults: the published token prices, caps 20/2 company and 5/1 per person, none in LIFTED_CAPS', () => {
    const d = CONFIG_DEFAULTS;
    expect([d['media.image.inPerMTok'], d['media.image.textOutPerMTok'], d['media.image.imageOutPerMTok']]).toEqual([1.5, 7.5, 30]);
    expect([d['media.video.inPerMTok'], d['media.video.textOutPerMTok'], d['media.video.videoOutPerMTok']]).toEqual([1.5, 9, 12]);
    expect([d['media.imagesPerDay'], d['media.videosPerDay'], d['media.imagesPerPersonPerDay'], d['media.videosPerPersonPerDay']]).toEqual([20, 2, 5, 1]);
    for (const k of Object.keys(d).filter((x) => x.startsWith('media.'))) expect(LIFTED_CAPS as readonly string[]).not.toContain(k);
  });
  it('M10 pins: exact ids, none retired, no alias; no person field on the image pin (OD-5i)', () => {
    expect(IMAGE_MODEL).toEqual({ id: 'gemini-nano-banana-2.1', api: 'generateContent', imageSize: '1K', tokensPerImage: 1120 });
    expect(IMAGE_MODEL).not.toHaveProperty('personGeneration');
    expect(VIDEO_MODEL).toMatchObject({ id: 'gemini-omni-1.2-flash', api: 'interactions', resolution: '720p', tokensPerSecond: 5792 });
    for (const m of [IMAGE_MODEL.id, VIDEO_MODEL.id]) {
      expect(RETIRED_MODEL_IDS).not.toContain(m);
      expect(m).not.toMatch(/latest|1\.1/);
    }
  });
  it('the group is off without a client; OD-5 video off: only image_generate is registered, so a provider-named video_generate is an unknown tool', async () => {
    expect(((await rig({ noGen: true })) as unknown as { disabled: string }).disabled).toMatch(/no Gemini key/);
    const r = await rig({ video: false }); // what app.ts wires: it never sets videoEnabled
    expect(r.tools.map((t: { name: string }) => t.name)).toEqual(['image_generate']);
    expect((await r.reg.runApproved('video_generate', vid(), r.c)).content).toMatch(/unknown tool video_generate/);
    expect(r.startVideo).not.toHaveBeenCalled();
    expect(r.take).not.toHaveBeenCalled();
    expect(CONFIG_DEFAULTS['tools.byDept'].marketing).not.toContain('video_generate');
    expect(CONFIG_DEFAULTS['tools.byDept'].praw).not.toContain('video_generate');
  });
});

describe('M3 / RF29 reserve the ceiling per provider call, settle from real usage', () => {
  it('image: one reservation per call at the provable ceiling BEFORE the call (no provider id, no model), settled from usage', async () => {
    const r = await rig();
    const res = await r.reg.runApproved('image_generate', img(), r.c);
    expect(res.isError).toBeUndefined();
    expect(r.reserve).toHaveBeenCalledTimes(1);
    const arg = r.reserve.mock.calls[0]![0] as Record<string, unknown>;
    expect(arg.estUsd).toBe(0.064512); // (2048 x 1.5 + 2048 x 30) / 1e6: the capped output ceiling
    expect(arg).not.toHaveProperty('provider');
    expect(arg).not.toHaveProperty('model');
    // SPEND-1 S10: only the rollup attribution rides along (never a top-level provider or model: RF28/RF29)
    expect(arg.attribution).toEqual({ provider: 'gemini', model: expect.stringMatching(/^gemini-/), tool: 'image_generate' });
    expect(Object.keys(arg).sort()).toEqual(['actor', 'attribution', 'estUsd', 'taskId']);
    expect(r.reserve.mock.invocationCallOrder[0]).toBeLessThan(r.generateImage.mock.invocationCallOrder[0]!);
    expect(r.settle).toHaveBeenCalledWith('r1', 0.03375); // 100 x 1.5 + 1120 x 30
    expect(res.content).toMatch(/cost \$0\.0338/);
  });
  it('two images are two sequential calls: both reservations are taken before the first call, the cap counts 2', async () => {
    const r = await rig();
    await r.reg.runApproved('image_generate', img({ count: 2 }), r.c);
    expect(r.reserve).toHaveBeenCalledTimes(2);
    expect(r.generateImage).toHaveBeenCalledTimes(2);
    expect(r.reserve.mock.invocationCallOrder[1]).toBeLessThan(r.generateImage.mock.invocationCallOrder[0]!);
    expect(r.take).toHaveBeenCalledWith('image', 'u:42', 2, expect.anything());
    expect(r.posted).toHaveLength(2);
  });
  it('missing usage, an unknown modality and non-finite numbers settle IN FULL; thought tokens are added; the delivered floor holds; an overrun files an incident', async () => {
    for (const usage of [null, { promptTokens: 0, candidatesTokens: 0 }, { promptTokens: 10, candidatesTokens: 100, byModality: [{ modality: 'AUDIO', tokens: 100 }] }, { promptTokens: Number.NaN, candidatesTokens: 5 }]) {
      const r = await rig({ images: async () => ({ image: { data: PNG, mime: 'image/png' }, blocked: false, tooLarge: false, dropped: 0, usage }) });
      await r.reg.runApproved('image_generate', img(), r.c);
      expect(r.settle).toHaveBeenCalledWith('r1', 0.064512);
    }
    const t = await rig({ images: async () => ({ image: { data: PNG, mime: 'image/png' }, blocked: false, tooLarge: false, dropped: 0, usage: { ...USAGE, thoughtsTokens: 1000 } }) });
    await t.reg.runApproved('image_generate', img(), t.c);
    expect(t.settle).toHaveBeenCalledWith('r1', 0.04125); // + 1000 thought tokens x 7.5
    const f = await rig({ images: async () => ({ image: { data: PNG, mime: 'image/png' }, blocked: false, tooLarge: false, dropped: 0, usage: { promptTokens: 1, candidatesTokens: 10, byModality: [{ modality: 'IMAGE', tokens: 10 }] } }) });
    await f.reg.runApproved('image_generate', img(), f.c);
    expect(f.settle).toHaveBeenCalledWith('r1', 0.0336); // floor: 1120 tokens x 30 for the delivered image
    const o = await rig({ images: async () => ({ image: { data: PNG, mime: 'image/png' }, blocked: false, tooLarge: false, dropped: 0, usage: { promptTokens: 1, candidatesTokens: 40_000, byModality: [{ modality: 'IMAGE', tokens: 40_000 }] } }) });
    await o.reg.runApproved('image_generate', img(), o.c);
    expect((o.settle.mock.calls[0] as unknown as [string, number])[1]).toBeGreaterThan(0.064512);
    expect(o.incidents.report).toHaveBeenCalledTimes(1);
  });
  it('residual output tokens beyond the per-modality counts are billed at the dearest media rate', async () => {
    const r = await rig({ images: async () => ({ image: { data: PNG, mime: 'image/png' }, blocked: false, tooLarge: false, dropped: 0, usage: { promptTokens: 0 + 100, candidatesTokens: 2120, byModality: [{ modality: 'IMAGE', tokens: 1120 }] } }) });
    await r.reg.runApproved('image_generate', img(), r.c);
    expect(r.settle).toHaveBeenCalledWith('r1', 0.06375); // 100 x 1.5 + 1120 x 30 + 1000 x 30
  });
  it('SPEND-1 S20: a department refusal names the department monthly budget, never the bot', async () => {
    const r = await rig({ reserve: () => ({ ok: false, scope: 'dept' }) });
    const res = await r.reg.runApproved('image_generate', img(), r.c);
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res)).toContain("department's monthly budget");
    expect(JSON.stringify(res)).not.toMatch(/bot budget/);
    expect(r.generateImage).not.toHaveBeenCalled();
    expect(r.giveBack).toHaveBeenCalledWith('image', 'u:42', 1);
  });
  it('a refused reservation (the 0.99 ceiling does not fit a budget) means no provider call and the slots go back', async () => {
    const r = await rig({ reserve: () => ({ ok: false, scope: 'bot' }) });
    const res = await r.reg.runApproved('image_generate', img(), r.c);
    expect(res.isError).toBe(true);
    expect(r.generateImage).not.toHaveBeenCalled();
    expect(r.giveBack).toHaveBeenCalledWith('image', 'u:42', 1);
  });
  it('a refused second reservation releases the first and gives all slots back; nothing is called', async () => {
    let n = 0;
    const r = await rig({ reserve: () => (++n === 1 ? { ok: true, reservationId: 'a' } : { ok: false, scope: 'task' }) });
    expect((await r.reg.runApproved('image_generate', img({ count: 2 }), r.c)).isError).toBe(true);
    expect(r.release).toHaveBeenCalledWith('a');
    expect(r.giveBack).toHaveBeenCalledWith('image', 'u:42', 2);
    expect(r.generateImage).not.toHaveBeenCalled();
  });
  it('a timeout or 5xx settles that call in full, releases the unstarted one and reports; a 4xx releases everything unstarted, gives slots back and is not reported', async () => {
    const a = await rig({ images: async () => { throw new GeminiHttpError(503); } });
    expect((await a.reg.runApproved('image_generate', img({ count: 2 }), a.c)).isError).toBe(true);
    expect(a.generateImage).toHaveBeenCalledTimes(1);
    expect(a.settle).toHaveBeenCalledWith('r1', 0.064512);
    expect(a.release).toHaveBeenCalledWith('r2');
    expect(a.giveBack).toHaveBeenCalledWith('image', 'u:42', 1);
    expect(a.incidents.report).toHaveBeenCalledTimes(1);
    const b = await rig({ images: async () => { throw new GeminiHttpError(400); } });
    expect((await b.reg.runApproved('image_generate', img(), b.c)).isError).toBe(true);
    expect(b.settle).not.toHaveBeenCalled();
    expect(b.release).toHaveBeenCalledTimes(1);
    expect(b.giveBack).toHaveBeenCalledTimes(1);
    expect(b.incidents.report).not.toHaveBeenCalled();
  });
  it('M10: when models.get does not find the model or lacks generateContent, nothing is reserved or called; a good answer is cached for 6 hours', async () => {
    for (const m of [async () => ({ found: false, actions: [] }), async () => ({ found: true, actions: ['predict'] }), async () => { throw new Error('net'); }]) {
      const r = await rig({ models: m as never });
      const res = await r.reg.runApproved('image_generate', img(), r.c);
      expect(res.content).toMatch(/not available/);
      expect(r.reserve).not.toHaveBeenCalled();
      expect(r.take).toHaveBeenCalledTimes(0);
    }
    const ok = await rig();
    await ok.reg.runApproved('image_generate', img(), ok.c);
    await ok.reg.runApproved('image_generate', img(), ok.c);
    expect(ok.checkModel).toHaveBeenCalledTimes(1);
    expect((ok.checkModel.mock.calls as unknown as string[][])[0]![0]).toBe('gemini-nano-banana-2.1');
  });
  it('M6/M7/OD-5i: the provider call gets the pinned model, 1K, the output cap and the prompt plus the fixed no-real-people suffix; no personGeneration', async () => {
    const r = await rig();
    await r.reg.runApproved('image_generate', img({ aspect: '16:9' }), r.c);
    expect(r.generateImage.mock.calls[0]![0]).toEqual({ model: 'gemini-nano-banana-2.1', prompt: `a red bicycle in a sunny park\n\n${IMAGE_PERSON_SUFFIX}`, aspect: '16:9', imageSize: '1K', maxOutputTokens: 2048, maxBytes: 10_000_000, signal: expect.any(AbortSignal) });
  });
});

describe('RF30 daily caps', () => {
  it('uses the configured company and person caps and counts images, not calls', async () => {
    const r = await rig();
    await r.reg.runApproved('image_generate', img({ count: 2 }), r.c);
    expect(r.take).toHaveBeenCalledWith('image', 'u:42', 2, { company: 20, person: 5 });
    const v = await rig();
    await v.reg.runApproved('video_generate', vid(), v.c);
    expect(v.take).toHaveBeenCalledWith('video', 'u:42', 1, { company: 2, person: 1 });
  });
  it('a refused cap stops before any reservation; the text names the scope', async () => {
    const r = await rig({ takeOk: () => ({ ok: false, scope: 'person' }) });
    const res = await r.reg.runApproved('image_generate', img(), r.c);
    expect(res.content).toMatch(/personal daily image limit/);
    expect(r.reserve).not.toHaveBeenCalled();
    const c = await rig({ takeOk: () => ({ ok: false, scope: 'company' }) });
    expect((await c.reg.runApproved('image_generate', img(), c.c)).content).toMatch(/company's daily image limit/);
  });
  it('no human on the run: the cap is the acting bot\'s own, never unlimited', async () => {
    const r = await rig({ userId: null });
    await r.reg.runApproved('image_generate', img(), r.c);
    expect(r.take.mock.calls[0]![1]).toBe('u:42'); // the root task requester
    expect(String(r.take.mock.calls[0]![1])).toMatch(/^[ua]:/);
  });
});

describe('OD-5 video off is wired off', () => {
  it('app.ts never sets videoEnabled', async () => {
    const { readFileSync } = await import('node:fs');
    expect(readFileSync(new URL('../../../app.ts', import.meta.url), 'utf8')).not.toMatch(/videoEnabled/);
  });
});

describe('RF31 approvals', () => {
  it('video ALWAYS asks, direct or not, and shows the estimate and the JSON-escaped prompt; nothing is spent', async () => {
    const r = await rig({ direct: true });
    const res = await r.reg.run('video_generate', vid({ prompt: 'a "quoted" scene' }), r.c);
    expect(res.content).toMatch(/NOT DONE YET/);
    expect(r.startVideo).not.toHaveBeenCalled();
    expect(r.reserve).not.toHaveBeenCalled();
    const req = (r.approvals.request.mock.calls[0] as unknown as [{ reason: string; tool: { name: string; input: unknown } }])[0];
    expect(req.reason).toContain('estimated cost $1.3455');
    expect(req.reason).toContain(JSON.stringify('a "quoted" scene'));
    expect(req.tool).toMatchObject({ name: 'video_generate', input: { seconds: 8 } });
  });
  it('OD-5i: EVERY image call asks, direct or not, tainted or not; nothing is reserved, called or spent before the approval; the card carries the cost and the whole prompt', async () => {
    for (const o of [{ direct: true }, { direct: false }, { direct: true, tainted: true }]) {
      const r = await rig(o);
      const res = await r.reg.run('image_generate', img({ prompt: 'a "quoted" red bicycle' }), r.c);
      expect(res.content, JSON.stringify(o)).toMatch(/NOT DONE YET/);
      expect(r.generateImage).not.toHaveBeenCalled();
      expect(r.reserve).not.toHaveBeenCalled();
      expect(r.take).not.toHaveBeenCalled();
      const req = (r.approvals.request.mock.calls[0] as unknown as [{ reason: string; tool: { name: string; input: unknown } }])[0];
      expect(req.tool.name).toBe('image_generate');
      expect(req.reason).toContain(JSON.stringify('a "quoted" red bicycle'));
      expect(req.reason).toMatch(/reserved up to \$0\.0645 each/);
    }
    const t = await rig({ direct: true });
    (t.c.task as { tainted: boolean }).tainted = true;
    expect((await t.reg.run('image_generate', img(), t.c)).content).toMatch(/NOT DONE YET/);
  });
  it('M3/M6 (B): the reservation ceiling is built from the output-token cap and fits budget.taskUsd 0.5 and the 0.05 to 0.10 target', async () => {
    const { imageCeilingUsd, imagePrices } = await import('./cost.js');
    const c = imageCeilingUsd(imagePrices(new FakeConfig() as never));
    expect(c).toBe(0.064512);
    expect(c).toBeGreaterThanOrEqual(0.05);
    expect(c).toBeLessThanOrEqual(0.1);
    expect(c).toBeLessThan(CONFIG_DEFAULTS['budget.taskUsd']);
  });
  it('(B) a 1K image that does not fit under the cap (finish reason MAX_TOKENS) fails closed: nothing posted, settled from usage, never retried with a higher cap', async () => {
    const r = await rig({ images: async () => ({ blocked: true, tooLarge: false, dropped: 0, usage: { promptTokens: 100, candidatesTokens: 2048, byModality: [{ modality: 'IMAGE', tokens: 2048 }] } }) });
    const res = await r.reg.runApproved('image_generate', img(), r.c);
    expect(res.isError).toBe(true);
    expect(r.generateImage).toHaveBeenCalledTimes(1);
    expect(r.posted).toHaveLength(0);
    expect(r.settle).toHaveBeenCalledWith('r1', 0.061590); // 100 x 1.5 + 2048 x 30, from usage
  });
  it('a tainted prompt with invisible characters is refused outright (even on replay)', async () => {
    const r = await rig({ tainted: true });
    const res = await r.reg.runApproved('image_generate', img({ prompt: 'a cat​on a mat' }), r.c);
    expect(res.isError).toBe(true);
    expect(res.content).toMatch(/invisible characters/);
    expect(r.take).not.toHaveBeenCalled();
  });
  it('the card fits the 500 character cap for a maximum-length prompt full of quotes', async () => {
    const r = await rig({ direct: false });
    await r.reg.run('video_generate', vid({ prompt: '"'.repeat(400) }), r.c);
    const req = (r.approvals.request.mock.calls[0] as unknown as [{ reason: string }])[0];
    expect(req.reason).toContain('estimated cost');
    expect(req.reason.length).toBeLessThanOrEqual(500);
  });
});

describe('G2RF5-04 whole-word real-person denylist', () => {
  it('common words that merely contain a name are NOT refused', async () => {
    for (const p of ['cloud computing diagram', 'a money market chart', 'macronutrient pie chart', 'a stock computation poster', 'ถนนสายหลักตอนกลางคืน']) {
      const r = await rig();
      expect((await r.reg.runApproved('image_generate', img({ prompt: p }), r.c)).isError, p).toBeUndefined();
    }
  });
  it('whole names, punctuation and spelled-out forms are still refused; Thai names match inside Thai text', async () => {
    for (const p of ['Putin, standing', 'a statue of (Macron)', 'neymar-style jersey', 'E.L.O.N  M.U.S.K on a rocket', 'e l o n m u s k', 'ภาพของทรัมป์กำลังพูด', 'ภาพลิซ่ายืนบนเวที']) {
      const r = await rig();
      expect((await r.reg.runApproved('image_generate', img({ prompt: p }), r.c)).isError, p).toBe(true);
    }
  });
});

describe('G2RF5-02 the per-person cap and the job use the ROOT human requester', () => {
  async function child(userId: string | null) {
    const r = await rig({ userId });
    const root = r.c.task!;
    const kid = await (r.c.tasks as any).create({ title: 'c', description: 'd', deptId: 'marketing', owner: MKT, requester: { kind: 'bot', actor: MKT } as never, origin: 'delegated', parentId: root.id });
    return { r, root, kid };
  }
  it('a delegated child task (bot requester, no trigger user) is charged to the root human, for images and for the video job', async () => {
    const { r, kid } = await child(null);
    expect(kid.rootId).toBe(r.c.task!.id);
    const c2 = { ...r.c, task: kid };
    await r.reg.runApproved('image_generate', img(), c2);
    expect(r.take.mock.calls[0]![1]).toBe('u:42');
    const r2 = await child(null);
    await r2.r.reg.runApproved('video_generate', vid(), { ...r2.r.c, task: r2.kid });
    expect(r2.r.take.mock.calls[0]![1]).toBe('u:42');
    expect(r2.r.submit).toHaveBeenCalledWith(expect.objectContaining({ requesterId: '42' }));
  });
  it('the root requester wins over a non-root trigger user; with no human anywhere the bot bucket is used', async () => {
    const { r, kid } = await child('someone-else');
    await r.reg.runApproved('image_generate', img(), { ...r.c, task: kid });
    expect(r.take.mock.calls[0]![1]).toBe('u:42');
    const n = await rig({ userId: null });
    (n.c.task as any).requester = { kind: 'bot', actor: MKT };
    await n.reg.runApproved('image_generate', img(), n.c);
    expect(n.take.mock.calls[0]![1]).toBe('a:head:marketing');
  });
});

describe('RF32 safety', () => {
  it('real-person names are refused in Latin and Thai, with zero-width tricks and spacing, and nothing is spent', async () => {
    for (const p of ['a portrait of Elon Musk smiling', 'portrait of E​lon  Musk', 'elonmusk on mars', 'ทรัมป์ ยืนบนเวที', 'deepfake of my boss', 'ＤＯＮＡＬＤ　ＴＲＵＭＰ waving']) {
      const r = await rig();
      const res = await r.reg.runApproved('image_generate', img({ prompt: p }), r.c);
      expect(res.isError, p).toBe(true);
      expect(res.content).toMatch(/real person/);
      expect(r.take).not.toHaveBeenCalled();
      expect(r.generateImage).not.toHaveBeenCalled();
    }
  });
  it('an ordinary prompt passes (no false positive on common words)', async () => {
    const r = await rig();
    expect((await r.reg.runApproved('image_generate', img({ prompt: 'a modified trumpet and a modern poster' }), r.c)).isError).toBeUndefined();
  });
  it('M12: a blocked result (block reason, a finish reason other than STOP, no image part) returns a fixed message, nothing is posted, and it is settled from usage (in full when there is none)', async () => {
    const withUsage = await rig({ images: async () => ({ blocked: true, tooLarge: false, dropped: 0, usage: { promptTokens: 100, candidatesTokens: 0 } }) });
    const res = await withUsage.reg.runApproved('image_generate', img(), withUsage.c);
    expect(res.isError).toBe(true);
    expect(res.content).toMatch(/safety filter blocked/);
    expect(withUsage.settle).toHaveBeenCalledWith('r1', 0.00015); // input tokens only, no delivered unit
    expect(withUsage.posted).toHaveLength(0);
    const noUsage = await rig({ images: async () => ({ blocked: true, tooLarge: false, dropped: 0, usage: null }) });
    await noUsage.reg.runApproved('image_generate', img(), noUsage.c);
    expect(noUsage.settle).toHaveBeenCalledWith('r1', 0.064512);
    // a blocked image the provider still returned is not posted
    const flagged = await rig({ images: async () => ({ image: { data: PNG, mime: 'image/png' }, blocked: true, tooLarge: false, dropped: 0, usage: USAGE }) });
    expect((await flagged.reg.runApproved('image_generate', img(), flagged.c)).isError).toBe(true);
    expect(flagged.posted).toHaveLength(0);
  });
  it('text-to-media only: the schemas have no image, url or attachment field', async () => {
    const r = await rig();
    expect((await r.reg.runApproved('image_generate', img({ image: 'x' }), r.c)).isError).toBe(true);
    expect((await r.reg.runApproved('image_generate', img({ url: 'https://x' }), r.c)).isError).toBe(true);
  });
  it('inputs are bounded: control characters, 401 chars, 3 images, 2 or 9 seconds', async () => {
    const r = await rig();
    for (const bad of [img({ prompt: 'a\u0007b cat' }), img({ prompt: 'x'.repeat(401) }), img({ count: 3 })]) expect((await r.reg.runApproved('image_generate', bad, r.c)).isError).toBe(true);
    for (const s of [2, 9, 8.5]) expect((await r.reg.runApproved('video_generate', vid({ seconds: s }), r.c)).isError).toBe(true);
    expect(r.take).not.toHaveBeenCalled();
  });
});

describe('RF34 / RF35 duty gating, enforced at call time', () => {
  it('image: marketing, rnd and praw may; video: marketing and praw only; the others are refused with a code-written owner line', async () => {
    const may = async (dept: string, tool: 'image_generate' | 'video_generate') => {
      const r = await rig({ actor: { kind: 'head', dept } as ActorRef });
      const res = tool === 'image_generate' ? await r.reg.run(tool, img(), r.c) : await r.reg.runApproved(tool, vid(), r.c);
      return !res.isError;
    };
    expect(await may('marketing', 'image_generate')).toBe(true);
    expect(await may('rnd', 'image_generate')).toBe(true);
    expect(await may('praw', 'image_generate')).toBe(true);
    for (const d of ['finance', 'hr', 'sales', 'software', 'it', 'ops', 'hq']) expect(await may(d, 'image_generate'), d).toBe(false);
    expect(await may('marketing', 'video_generate')).toBe(true);
    expect(await may('praw', 'video_generate')).toBe(true);
    expect(await may('rnd', 'video_generate')).toBe(false);
    const f = await rig({ actor: { kind: 'head', dept: 'finance' } });
    expect((await f.reg.runApproved('image_generate', img(), f.c)).content).toMatch(/does not own duty marketing; the owner is @/);
  });
  it('the LIVE duties table decides: moving the duty changes the answer without a restart', async () => {
    const table: Record<string, readonly string[]> = { ...DEFAULT_DUTIES, marketing: [], finance: ['marketing'] };
    const m = await rig({ duties: table });
    expect((await m.reg.runApproved('image_generate', img(), m.c)).isError).toBe(true);
    const f = await rig({ duties: table, actor: { kind: 'head', dept: 'finance' } });
    expect((await f.reg.runApproved('image_generate', img(), f.c)).isError).toBeUndefined();
  });
  it('personas never, even in a department that holds the duty', async () => {
    const r = await rig({ actor: { kind: 'persona', personaId: 'any' } });
    const res = await r.reg.runApproved('image_generate', img(), r.c);
    expect(res.isError).toBe(true);
    expect(res.content).toMatch(/only a department head/);
  });
  it('an unoffered tool name is refused by the registry allowlist, and a provider-invented one is unknown', async () => {
    const r = await rig();
    (r.c.org as unknown as { toolsFor: () => string[] }).toolsFor = () => ['image_generate'];
    expect((await r.reg.run('video_generate', vid(), r.c)).content).toMatch(/not allowed for you/);
    expect((await r.reg.run('video_generate2', vid(), r.c)).content).toMatch(/unknown tool/);
  });
});

describe('halt, per-run caps, outputs (RF33, RF38)', () => {
  it('halted: nothing is spent or generated', async () => {
    const r = await rig({ halted: true });
    expect((await r.reg.runApproved('image_generate', img(), r.c)).isError).toBe(true);
    expect(r.take).not.toHaveBeenCalled();
  });
  it('only the first final image of each call is posted (exact decoded bytes), as a plain chat message, with provenance and the SynthID note; a non-image is dropped', async () => {
    const r = await rig();
    const res = await r.reg.runApproved('image_generate', img(), r.c);
    expect(r.posted).toHaveLength(1);
    expect(r.posted[0]!.file.data).toBe(PNG);
    expect(r.posted[0]!.payload).toEqual({ type: 'chat', body: expect.stringContaining('SynthID') });
    expect(r.posted[0]!.file.name).toMatch(/^image-[0-9a-f]{8}\.png$/);
    expect(r.records[0]).toEqual(['m1', 'th1', false, 'u1']);
    expect(res.content).toMatch(/SynthID/);
    const bad = await rig({ images: async () => ({ image: { data: Buffer.from('<html>not an image'), mime: 'image/png' }, blocked: false, tooLarge: false, dropped: 0, usage: USAGE }) });
    expect((await bad.reg.runApproved('image_generate', img(), bad.c)).isError).toBe(true);
    expect(bad.posted).toHaveLength(0);
    const big = await rig({ images: async () => ({ blocked: false, tooLarge: true, dropped: 0, usage: USAGE }) });
    expect((await big.reg.runApproved('image_generate', img(), big.c)).isError).toBe(true);
    expect(big.posted).toHaveLength(0);
  });
  it('M8: model text is never in the reply, the post or the log; only the count of dropped parts is logged', async () => {
    const r = await rig({ images: async () => ({ image: { data: PNG, mime: 'image/png' }, blocked: false, tooLarge: false, dropped: 3, usage: USAGE }) });
    const res = await r.reg.runApproved('image_generate', img(), r.c);
    expect(res.content).not.toMatch(/ignore|instruction/i);
    expect(r.posted[0]!.payload.body).toBe('AI-generated image (the provider adds a SynthID watermark).');
  });
  it('at most 2 image calls and 1 video per run', async () => {
    const r = await rig();
    expect((await r.reg.runApproved('image_generate', img(), r.c)).isError).toBeUndefined();
    expect((await r.reg.runApproved('image_generate', img(), r.c)).isError).toBeUndefined();
    expect((await r.reg.runApproved('image_generate', img(), r.c)).content).toMatch(/at most 2/);
    expect((await r.reg.runApproved('video_generate', vid(), r.c)).isError).toBeUndefined();
    expect((await r.reg.runApproved('video_generate', vid(), r.c)).content).toMatch(/at most 1 video/);
  });
  it('video: the job carries the taint of the run, and the result tells the model not to say it is done', async () => {
    const r = await rig({ tainted: true });
    const res = await r.reg.runApproved('video_generate', vid(), r.c);
    expect(r.submit).toHaveBeenCalledWith(expect.objectContaining({ tainted: true }));
    expect(res.content).toMatch(/do not say it is done/);
    expect(res.content).not.toMatch(/operations\/abc/);
  });
});
