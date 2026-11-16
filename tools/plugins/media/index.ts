import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { DEFAULT_DUTIES, dutyRefusal, type DutyId, type DutyTable } from '../../../company/duties.js';
import type { ActorRef } from '../../../company/types.js';
import { redactText } from '../../../core/logger.js';
import type { DeptId } from '../../../core/index.js';
import type { MediaJobRepo, MediaUsageRepo } from '../../../db/repos/media.js';
import { actorKey, type Budget } from '../../../governance/budget.js';
import type { MediaClient } from '../../../providers/gemini/media.js';
import { GeminiHttpError } from '../../../providers/gemini/types.js';
import { toolError, type RunState, type ToolContext, type ToolPlugin } from '../../types.js';
import type { GroupFactory } from '../index.js';
import { HIDDEN } from '../web/webSearch.js';
import type { MediaJobService } from './jobs.js';
import { ceilMicro, imageCeilingUsd, imagePrices, imageTypicalUsd, pricesValid, settleImage, videoCeilingUsd, videoPrices } from './cost.js';
import { AVAILABILITY_TTL_MS, IMAGE_ASPECTS, IMAGE_MAX_OUTPUT_TOKENS, IMAGE_MODEL, IMAGE_PERSON_SUFFIX, MAX_IMAGES_PER_CALL, MEDIA_MAX_BYTES, VIDEO_ASPECTS, VIDEO_MODEL, VIDEO_SECONDS } from './pins.js';
import { namesRealPerson, PROMPT_MAX } from './prompt.js';

/** What app.ts builds when a Gemini key exists. Tools never see the key (D16). */
export type MediaGen = {
  client: Pick<MediaClient, 'checkModel' | 'generateImage' | 'startVideo'>;
  budget: Pick<Budget, 'reserve' | 'settle' | 'release'>;
  usage: Pick<MediaUsageRepo, 'take' | 'giveBack'>;
  jobs: Pick<MediaJobService, 'submit'>;
  /** M5: video is OFF unless this is true. app.ts never sets it (OD-5 undecided, no Interactions client yet): the tool is then not even registered. */
  videoEnabled?: true;
};
export type { MediaJobRepo };

export const MEDIA_OFF = 'image and video generation is off: no Gemini key is configured';

/**
 * RFMD P5 (Gate 1 RF28-RF35, RF38): `image_generate` (Imagen) and `video_generate` (Veo, long-running job). Duty holders only (image: marketing, innovation, assistance = Praw;
 * video: marketing, assistance), read from the LIVE duties table at every call; personas never. Text-to-media only. Order of gates: strict zod -> precheck (duty, price,
 * real-person denylist, hidden characters in a tainted run) -> approval (video always; image under approvalFor and always when the run or task is tainted) -> run:
 * durable daily caps under row lock (company and person) -> budget reserve (never under localUnlimited: no provider id is passed) -> provider call -> settle -> post the code-held buffers.
 */
const IMAGE_DUTIES: readonly DutyId[] = ['marketing', 'innovation', 'assistance'];
const VIDEO_DUTIES: readonly DutyId[] = ['marketing', 'assistance'];
const RUN_CAP = { image: 2, video: 1 } as const;
const made = new WeakMap<RunState, { image: number; video: number }>();
const TIMEOUT_MS = { image: 120_000, video: 60_000 } as const; // M1: an image call lasts at most 120 s

const prompt = z.string().trim().min(3).max(PROMPT_MAX).refine((s) => !/\p{Cc}/u.test(s), 'the prompt must be plain text without control characters');
const ImageInput = z.strictObject({
  prompt: prompt.describe('What the picture shows (English or Thai, at most 400 characters). Never name real people.'),
  aspect: z.enum(IMAGE_ASPECTS).optional().describe('1:1 (default), 3:4, 4:3, 9:16 or 16:9'),
  count: z.number().int().min(1).max(MAX_IMAGES_PER_CALL).optional().describe('1 (default) or 2'),
});
const VideoInput = z.strictObject({
  prompt: prompt.describe('What the video shows (at most 400 characters). Never name real people.'),
  seconds: z.number().int().min(VIDEO_SECONDS.min).max(VIDEO_SECONDS.max).describe('Length in seconds, 5 to 8'),
  aspect: z.enum(VIDEO_ASPECTS).optional().describe('16:9 (default) or 9:16'),
});
type ImageIn = z.infer<typeof ImageInput>;
type VideoIn = z.infer<typeof VideoInput>;

const deptOf = (ctx: Pick<ToolContext, 'actor'>): DeptId | null => (ctx.actor.kind === 'head' ? ctx.actor.dept : null);
const isTainted = (ctx: Pick<ToolContext, 'tainted' | 'task'>): boolean => ctx.tainted() || ctx.task?.tainted === true;
const usd = (x: number): string => `$${x.toFixed(4)}`;

/** RF34/RF35: null when allowed. Text from code values only. */
export function mediaDutyRefusal(tool: string, duties: readonly DutyId[], ctx: Pick<ToolContext, 'actor' | 'duties'>): string | null {
  const dept = deptOf(ctx);
  if (!dept) return `${tool}: only a department head can generate media`; // personas get no media tools
  const table: DutyTable = ctx.duties?.() ?? DEFAULT_DUTIES;
  if (duties.some((d) => table[dept]?.includes(d))) return null;
  return `${tool}: ${dutyRefusal(table, dept, duties[0]!)}`;
}

/**
 * The human behind the run (G2RF5-02, RF30): the ROOT requester of the task tree when it is a human (a delegated or forward_to child task's own requester is a bot; same rule as
 * createTask.ts RF9), else the trigger user, else the acting bot's own bucket (never unlimited). Null id: no human known.
 */
async function humanOf(ctx: ToolContext): Promise<string | null> {
  const t = ctx.task;
  if (t) {
    const root = t.id === t.rootId ? t : await ctx.tasks.get(t.rootId).catch(() => null);
    if (root?.requester.kind === 'human') return root.requester.userId;
  }
  return ctx.source.userId ?? (t?.requester.kind === 'human' ? t.requester.userId : null);
}
async function personOf(ctx: ToolContext): Promise<string> {
  const id = await humanOf(ctx);
  return id ? `u:${id}` : `a:${actorKey(ctx.actor)}`;
}

const REFUSAL = {
  person: (t: string) => `${t}: the prompt names a real person or asks for a likeness; media of real people is not made. Describe a fictional or generic subject instead.`,
  hidden: (t: string) => `${t}: the prompt holds invisible characters, nothing was generated`,
  price: (t: string) => `${t}: the media price is not configured, so the call cannot be metered`,
  halted: (t: string) => `${t}: the company is halted; nothing was generated`,
} as const;

const CAP_TEXT = (kind: 'image' | 'video', scope: 'company' | 'person'): string =>
  scope === 'company' ? `The company's daily ${kind} limit is used up; try again tomorrow.` : `Your personal daily ${kind} limit is used up; try again tomorrow.`;

export const mediaGroup: GroupFactory = (deps) => {
  const gen = deps.mediaGen;
  if (!gen) return { id: 'media', disabled: MEDIA_OFF };
  const cfg = deps.cfg;
  const halted = (): boolean => deps.halt?.isHalted?.() ?? false;
  const fault = (ctx: ToolContext, tool: string, stage: string, e: unknown): void => {
    // a 400 is the provider rejecting the request (often a safety refusal): not a system fault
    if (e instanceof GeminiHttpError && e.status === 400) return;
    deps.incidents?.report({ source: 'tool', stage, toolName: tool, err: e, actor: ctx.actor, ...(ctx.task ? { taskId: ctx.task.id, taskTitle: ctx.task.title } : {}) });
  };
  const audit = (ctx: ToolContext, tool: string, outcome: string, costUsd?: number) =>
    ctx.audit({ actor: actorKey(ctx.actor), action: 'media', tool, taskId: ctx.task?.id ?? null, outcome, ...(costUsd !== undefined ? { costUsd } : {}) }).catch(() => undefined);
  const cardChange = (est: number, parts: string, p: string): string => redactText(`estimated cost ${usd(est)}; ${parts}; prompt ${JSON.stringify(p)}`).slice(0, 480);

  /** Everything refusable before any approval or spend; read live, so an approved replay re-checks it. */
  function common(tool: 'image_generate' | 'video_generate', p: string, ctx: ToolContext): string | null {
    const why = mediaDutyRefusal(tool, tool === 'image_generate' ? IMAGE_DUTIES : VIDEO_DUTIES, ctx);
    if (why) return why;
    if (!pricesValid(tool === 'image_generate' ? { ...imagePrices(cfg) } : { ...videoPrices(cfg) })) return REFUSAL.price(tool);
    if (namesRealPerson(p)) return REFUSAL.person(tool);
    if (isTainted(ctx) && HIDDEN.test(p)) return REFUSAL.hidden(tool);
    if (!ctx.source.channelId) return `${tool}: there is no thread to post the result in`;
    return null;
  }
  /** M3: what is reserved (the provable ceiling), per provider call and in total; the card shows both and the typical cost. */
  const imageCall = (): number => imageCeilingUsd(imagePrices(cfg));
  const imageEst = (i: ImageIn): number => ceilMicro((i.count ?? 1) * imageCall());
  const videoEst = (i: VideoIn): number => videoCeilingUsd(videoPrices(cfg), i.seconds);
  const imageParts = (i: ImageIn): string => `${i.count ?? 1} image(s) at ${IMAGE_MODEL.imageSize}, aspect ${i.aspect ?? '1:1'}, typical ${usd(imageTypicalUsd(imagePrices(cfg)))} each, reserved up to ${usd(imageCall())} each, a fixed no-real-people instruction is added to the prompt`;
  const videoParts = (i: VideoIn): string => `video ${i.seconds} s ${VIDEO_MODEL.resolution}, aspect ${i.aspect ?? '16:9'}`;
  // M10: a free models.get before the first reservation, trusted for 6 h
  let availableAt = -Infinity;
  async function available(): Promise<boolean> {
    if (deps.clock() - availableAt < AVAILABILITY_TTL_MS) return true;
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 10_000);
    try {
      const m = await gen!.client.checkModel(IMAGE_MODEL.id, ac.signal);
      if (m.found && m.actions.includes('generateContent')) { availableAt = deps.clock(); return true; }
      return false;
    } finally { clearTimeout(t); }
  }

  /**
   * Takes the daily slots (n), then reserves one ceiling per provider call BEFORE any call (M6: two images are two calls under one approval). On any refusal everything taken is given back.
   * Returns the reservation ids, or the refusal text.
   */
  async function admit(kind: 'image' | 'video', n: number, ests: number[], ctx: ToolContext): Promise<{ text: string } | { reservations: string[]; person: string }> {
    const person = await personOf(ctx);
    const caps = kind === 'image'
      ? { company: cfg.get('media.imagesPerDay'), person: cfg.get('media.imagesPerPersonPerDay') }
      : { company: cfg.get('media.videosPerDay'), person: cfg.get('media.videosPerPersonPerDay') };
    try {
      const t = await gen!.usage.take(kind, person, n, caps);
      if (!t.ok) return { text: CAP_TEXT(kind, t.scope) };
    } catch {
      return { text: 'The daily media counter is unavailable. Nothing was generated.' };
    }
    const ids: string[] = [];
    const undo = async () => { for (const id of ids) await gen!.budget.release(id).catch(() => undefined); await gen!.usage.giveBack(kind, person, n).catch(() => undefined); };
    for (const est of ests) {
      let r: Awaited<ReturnType<MediaGen['budget']['reserve']>>;
      try {
        // no `provider`: a media call is metered, never counted as a local call, and no localUnlimited lift can reach it (RF28/RF29)
        r = await gen!.budget.reserve({ actor: ctx.actor, ...(ctx.task ? { taskId: ctx.task.id } : {}), estUsd: est, attribution: { provider: 'gemini', model: kind === 'image' ? IMAGE_MODEL.id : VIDEO_MODEL.id, tool: kind === 'image' ? 'image_generate' : 'video_generate' } });
      } catch {
        await undo();
        return { text: 'The budget meter is unavailable. Nothing was generated.' };
      }
      if (!r.ok) {
        await undo();
        return { text: r.scope === 'price' ? REFUSAL.price(`${kind}_generate`) : r.scope === 'dept' ? `The department's monthly budget is too small to reserve this ${kind}; it was not generated.` : `The ${r.scope === 'company' ? 'company' : r.scope === 'task' ? 'task' : 'bot'} budget is too small to reserve this ${kind} (up to ${usd(est)} per provider call); it was not generated.` };
      }
      ids.push(r.reservationId);
    }
    return { reservations: ids, person };
  }
  const settle = (id: string, usdSpent: number) => gen!.budget.settle(id, usdSpent).catch((e: unknown) => deps.log.warn({ errName: e instanceof Error ? e.name : 'unknown' }, 'media settle failed'));
  const release = (id: string) => gen!.budget.release(id).catch(() => undefined);
  /** A definite provider rejection (4xx): nothing was made, so nothing is charged and the slots return. Anything else (5xx, timeout, abort) is an unknown outcome: charged in full. */
  const definiteReject = (e: unknown): boolean => e instanceof GeminiHttpError && e.status >= 400 && e.status < 500 && e.status !== 408 && e.status !== 429;

  const imageGenerate: ToolPlugin<ImageIn> = {
    name: 'image_generate',
    description: `Generate 1 or 2 pictures (${IMAGE_MODEL.imageSize}, one provider call per picture) from a text description with ${IMAGE_MODEL.id} and post them in this thread. Metered by tokens: the card shows the typical and the reserved maximum cost; ` +
      'each picture counts against a daily limit (company and per person). Text only (no editing of photos), no real people (not even by name), provider safety filters on; results carry the provider\'s SynthID watermark. Needs the marketing, innovation or assistance duty. ALWAYS needs an approval card showing the prompt and the cost.',
    kind: 'write',
    inputSchema: ImageInput,
    summary: (i) => ({ target: `image ${i.aspect ?? '1:1'} x${i.count ?? 1}`, change: cardChange(imageEst(i), imageParts(i), i.prompt) }),
    async precheck(input, ctx) {
      const why = common('image_generate', input.prompt, ctx);
      return why ? { refuse: why } : { summary: { target: `image ${input.aspect ?? '1:1'} x${input.count ?? 1}`, change: cardChange(imageEst(input), imageParts(input), input.prompt) } };
    },
    // OD-5i (owner-accepted risk, see pins.ts): EVERY image call asks, tainted or not, direct or not. The card shows the whole prompt and the cost.
    requiresApproval(input, ctx) {
      return { reason: `image_generate always needs approval${isTainted(ctx) ? ' (the run read untrusted content)' : ''}: ${cardChange(imageEst(input), imageParts(input), input.prompt)}` };
    },
    async run(input, ctx) {
      const why = common('image_generate', input.prompt, ctx);
      if (why) return toolError(why);
      if (halted()) return toolError(REFUSAL.halted('image_generate'));
      const n = input.count ?? 1;
      const c = made.get(ctx.run) ?? { image: 0, video: 0 };
      if (c.image >= RUN_CAP.image) return toolError(`image_generate: at most ${RUN_CAP.image} calls per run`);
      made.set(ctx.run, { ...c, image: c.image + 1 });
      // M10: refuse before any reservation when the pinned model is not available
      let up = false;
      try { up = await available(); } catch { up = false; }
      if (!up) { await audit(ctx, 'image_generate', 'unavailable'); return toolError('image_generate: the image model is not available right now, so nothing was generated or charged.'); }
      const prices = imagePrices(cfg);
      const ceiling = imageCall();
      const adm = await admit('image', n, Array.from({ length: n }, () => ceiling), ctx);
      if ('text' in adm) { await audit(ctx, 'image_generate', 'refused'); return toolError(`image_generate: ${adm.text}`); }
      const target = { channelId: ctx.source.channelId, ...(ctx.source.threadId ? { threadId: ctx.source.threadId } : {}) };
      const tainted = isTainted(ctx);
      let spent = 0;
      let posted = 0;
      let blocked = 0;
      let dropped = 0;
      // unstarted calls: their reservations are released and their daily slots go back
      const abandon = async (from: number) => {
        for (const id of adm.reservations.slice(from)) await release(id);
        if (n - from > 0) await gen.usage.giveBack('image', adm.person, n - from).catch(() => undefined);
      };
      for (let i = 0; i < n; i++) {
        const ac = new AbortController();
        const untrack = deps.halt?.track(ac);
        const timer = setTimeout(() => ac.abort(new Error('timeout')), TIMEOUT_MS.image);
        let out: Awaited<ReturnType<MediaClient['generateImage']>>;
        try {
          out = await gen.client.generateImage({ model: IMAGE_MODEL.id, prompt: `${input.prompt}\n\n${IMAGE_PERSON_SUFFIX}`, aspect: input.aspect ?? '1:1', imageSize: IMAGE_MODEL.imageSize, maxOutputTokens: IMAGE_MAX_OUTPUT_TOKENS, maxBytes: MEDIA_MAX_BYTES, signal: ac.signal });
        } catch (e) {
          if (definiteReject(e)) {
            await abandon(i); // this call and the rest: nothing was charged for it
            await audit(ctx, 'image_generate', 'rejected', spent);
            return toolError(`image_generate: the provider refused this request (its safety policy or an invalid request); nothing more was charged.${posted ? ` ${posted} image(s) were already posted.` : ''} Try a different description.`);
          }
          await settle(adm.reservations[i]!, ceiling); // M3: unknown outcome (timeout, abort, 5xx): settled in full
          spent += ceiling;
          await abandon(i + 1);
          await audit(ctx, 'image_generate', 'failed', spent);
          fault(ctx, 'image_generate', 'generate', e);
          return toolError('image_generate: the image service failed or timed out; the reserved maximum was counted as spent for that call. Try again later.');
        } finally {
          clearTimeout(timer);
          untrack?.();
        }
        dropped += out.dropped;
        // M3: settle from the provider's own usage, never below the delivered-unit floor; missing usage is settled in full
        const st = settleImage(prices, out.usage, out.image ? 1 : 0, ceiling);
        await settle(adm.reservations[i]!, st.usd);
        spent += st.usd;
        if (st.overrun) deps.incidents?.report({ source: 'tool', stage: 'settle above reservation', toolName: 'image_generate', err: new Error(`image call cost ${usd(st.usd)} above its reservation ${usd(ceiling)}`), actor: ctx.actor, ...(ctx.task ? { taskId: ctx.task.id, taskTitle: ctx.task.title } : {}) });
        // RF38/M6/M13: only the first final image of THIS call, its exact decoded bytes, checked to be a real PNG/JPEG within the upload limit
        const data = out.image?.data;
        const png = !!data && data.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
        const jpg = !!data && data.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]));
        if (!data || out.blocked || data.length === 0 || data.length > MEDIA_MAX_BYTES || !(png || jpg)) { blocked++; continue; }
        try {
          // owner rule: a plain message (no embed) for chat
          const id = await deps.port.postFile(ctx.actor as ActorRef, target, { type: 'chat', body: 'AI-generated image (the provider adds a SynthID watermark).' }, { name: `image-${randomBytes(4).toString('hex')}.${png ? 'png' : 'jpg'}`, data, contentType: png ? 'image/png' : 'image/jpeg' });
          await deps.provenance?.record(id, ctx.source.threadId ?? ctx.source.channelId, tainted, ctx.source.userId).catch(() => undefined);
          posted++;
        } catch {
          await abandon(i + 1);
          await audit(ctx, 'image_generate', 'post_failed', spent);
          return toolError('image_generate: the image was made but could not be posted here (the bot may lack Attach Files in this channel)');
        }
      }
      if (dropped) deps.log.info({ dropped }, 'image model text and extra parts dropped'); // M8: a count only
      if (!posted) {
        await audit(ctx, 'image_generate', 'blocked', spent);
        return toolError('image_generate: the provider returned no image (its safety filter blocked it). It was counted against the daily limit and the budget.');
      }
      await audit(ctx, 'image_generate', 'ok', spent);
      const note = blocked > 0 ? ` ${blocked} of ${n} was blocked by the provider's safety filter.` : '';
      return { content: `Generated ${posted} image(s), posted in this thread (cost ${usd(spent)}; SynthID watermark added by the provider).${note}` };
    },
  };

  const videoGenerate: ToolPlugin<VideoIn> = {
    name: 'video_generate',
    description: `Generate a short video (5 to 8 seconds) from a text description with Veo. ALWAYS needs an approval card showing the estimated cost and the prompt. It runs as a background job: the video is posted in this thread when ready (up to 15 minutes). ` +
      'Metered per second and limited per day (company and per person). Text only, no real people (not even by name), provider safety filters on; results carry the provider\'s SynthID watermark. Needs the marketing or assistance duty.',
    kind: 'write',
    inputSchema: VideoInput,
    summary: (i) => ({ target: `video ${i.seconds}s ${i.aspect ?? '16:9'}`, change: cardChange(videoEst(i), videoParts(i), i.prompt) }),
    async precheck(input, ctx) {
      const why = common('video_generate', input.prompt, ctx);
      return why ? { refuse: why } : { summary: { target: `video ${input.seconds}s ${input.aspect ?? '16:9'}`, change: cardChange(videoEst(input), videoParts(input), input.prompt) } };
    },
    // RF31: video ALWAYS asks, whatever `direct` says; the card shows the estimate and the JSON-escaped prompt.
    requiresApproval: (input) => ({ reason: `video_generate always needs approval: ${cardChange(videoEst(input), videoParts(input), input.prompt)}` }),
    async run(input, ctx) {
      const why = common('video_generate', input.prompt, ctx);
      if (why) return toolError(why);
      if (halted()) return toolError(REFUSAL.halted('video_generate'));
      const c = made.get(ctx.run) ?? { image: 0, video: 0 };
      if (c.video >= RUN_CAP.video) return toolError('video_generate: at most 1 video per run');
      made.set(ctx.run, { ...c, video: c.video + 1 });
      const est = videoEst(input);
      const adm = await admit('video', 1, [est], ctx);
      if ('text' in adm) { await audit(ctx, 'video_generate', 'refused'); return toolError(`video_generate: ${adm.text}`); }
      const ac = new AbortController();
      const untrack = deps.halt?.track(ac);
      const timer = setTimeout(() => ac.abort(new Error('timeout')), TIMEOUT_MS.video);
      let name: string;
      try {
        ({ name } = await gen.client.startVideo({ model: VIDEO_MODEL.id, prompt: input.prompt, seconds: input.seconds, aspect: input.aspect ?? '16:9', personGeneration: 'none', signal: ac.signal }));
      } catch (e) {
        if (definiteReject(e)) {
          await release(adm.reservations[0]!);
          await gen.usage.giveBack('video', adm.person, 1).catch(() => undefined);
          await audit(ctx, 'video_generate', 'rejected');
          return toolError('video_generate: the provider refused this request (its safety policy or an invalid request); nothing was charged. Try a different description.');
        }
        await settle(adm.reservations[0]!, est);
        await audit(ctx, 'video_generate', 'failed', est);
        fault(ctx, 'video_generate', 'start', e);
        return toolError('video_generate: the video service failed or timed out; the estimate was counted as spent. Try again later.');
      } finally {
        clearTimeout(timer);
        untrack?.();
      }
      // RF29: the estimate is booked as SPENT at submit (a boot zeroes reservations, so a job that outlives a restart cannot escape the budget); it is not trued down.
      await settle(adm.reservations[0]!, est);
      let jobId: string;
      try {
        jobId = await gen.jobs.submit({
          opName: name, requesterId: await humanOf(ctx), actor: ctx.actor,
          channelId: ctx.source.channelId, threadId: ctx.source.threadId, taskId: ctx.task?.id ?? null, reservedUsd: est, seconds: input.seconds, tainted: isTainted(ctx),
        });
      } catch (e) {
        fault(ctx, 'video_generate', 'job row', e);
        await audit(ctx, 'video_generate', 'job_lost', est);
        return toolError('video_generate: the video was started but the job could not be tracked, so it cannot be posted. The estimate was counted as spent.');
      }
      await audit(ctx, 'video_generate', 'submitted', est);
      return { content: `Video job ${jobId.slice(0, 8)} started (estimated cost ${usd(est)}, counted as spent now). The video will be posted in this thread when it is ready, usually within a few minutes and at most 15. Tell the user it is on the way; do not say it is done.` };
    },
  };

  // OD-5 = "video off" (owner decision, 2026-11-07; Gate 1 addendum M5). The video tool is NOT registered, so no department is offered it and a provider-named `video_generate` is an unknown
  // tool at the registry (fail closed). The code is kept; only wiring that sets `videoEnabled` (app.ts never does, a test pins that) would register it. Do not enable without a new decision.
  return { id: 'media', tools: [imageGenerate, ...(gen.videoEnabled === true ? [videoGenerate] : [])] as ToolPlugin<any>[] };
};
