import { GenerateVideosOperation, GoogleGenAI } from '@google/genai';
import { safeFetch, type Resolver, type Transport } from '../../net/guard.js';
import { systemResolver, systemTransport } from '../../net/system.js';
import { sdkClientOptions } from './adapter.js';
import { GeminiHttpError } from './types.js';

/**
 * RFMD P5: Imagen and Veo through @google/genai. The API key is closed over here and never leaves: tools get only this interface (D16).
 * Safety (RF32): text-to-media only (no image/video input), strictest safety settings for images (never BLOCK_NONE/OFF); no person control for images (OD-5i),
 * the provider watermark (SynthID) is left on (no addWatermark field is sent). SDK retries are off (sdkClientOptions: attempts 1): billable requests are never re-sent.
 */
/** Output tokens as the provider reports them (generateContent usageMetadata); the tool settles from it (tools/plugins/media/cost.ts). */
export type ImageUsage = { promptTokens?: number; candidatesTokens?: number; thoughtsTokens?: number; byModality?: { modality: string; tokens: number }[] };
/**
 * One image call (M6: one image per call). `image` is the FIRST FINAL image part (thought images and any further images are dropped, though billed); `blocked` covers a prompt block,
 * a finish reason other than STOP and no image part (M12). `dropped` counts text and thought parts that were thrown away (M8: model text is never kept). `tooLarge`: the base64 was
 * over the limit and was not decoded.
 */
export type ImageOut = { image?: { data: Buffer; mime: string }; blocked: boolean; tooLarge: boolean; dropped: number; usage: ImageUsage | null };
export type VideoPoll = { done: false } | { done: true; failed: true } | { done: true; filtered: true } | { done: true; uri: string };
export interface MediaClient {
  /** M10: a free models.get; `found` false (or an error) means the pinned model is unavailable. */
  checkModel(model: string, signal: AbortSignal): Promise<{ found: boolean; actions: string[] }>;
  generateImage(r: { model: string; prompt: string; aspect: string; imageSize: string; maxOutputTokens: number; maxBytes: number; signal: AbortSignal }): Promise<ImageOut>;
  startVideo(r: { model: string; prompt: string; seconds: number; aspect: string; personGeneration: string; signal: AbortSignal }): Promise<{ name: string }>;
  pollVideo(name: string, signal: AbortSignal): Promise<VideoPoll>;
  downloadVideo(uri: string, o: { signal: AbortSignal; maxBytes: number; hosts: readonly string[] }): Promise<Buffer>;
}

/** The slice of the SDK used, so tests fake it. */
export type MediaSdk = {
  models: { generateContent(p: unknown): Promise<unknown>; generateVideos(p: unknown): Promise<unknown>; get?(p: unknown): Promise<unknown> };
  operations: { getVideosOperation(p: { operation: unknown }): Promise<unknown> };
};

/**
 * M4: every adjustable category at the strictest threshold, never OFF or BLOCK_NONE. HARM_CATEGORY_JAILBREAK is left out until a live call shows generateContent accepts it
 * (recorded reason: unverified; adding it is a code change). A 400 on a category fails the call; nothing falls back to looser.
 */
export const IMAGE_SAFETY_SETTINGS = ['HARM_CATEGORY_HARASSMENT', 'HARM_CATEGORY_HATE_SPEECH', 'HARM_CATEGORY_SEXUALLY_EXPLICIT', 'HARM_CATEGORY_DANGEROUS_CONTENT', 'HARM_CATEGORY_CIVIC_INTEGRITY']
  .map((category) => ({ category, threshold: 'BLOCK_LOW_AND_ABOVE' }));

const asHttp = (e: unknown): unknown => {
  const s = (e as { status?: unknown } | null)?.status;
  return typeof s === 'number' ? new GeminiHttpError(s) : e;
};

type Part = { text?: string; thought?: boolean; inlineData?: { data?: string; mimeType?: string } };
type GcResp = {
  promptFeedback?: { blockReason?: string };
  candidates?: { finishReason?: string; content?: { parts?: Part[] } }[];
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number; candidatesTokensDetails?: { modality?: string; tokenCount?: number }[] };
};
type VidOp = { name?: string; done?: boolean; error?: unknown; response?: { generatedVideos?: { video?: { uri?: string } }[]; raiMediaFilteredCount?: number } };

export function createGeminiMedia(o: { apiKey: string; sdk?: MediaSdk; resolver?: Resolver; transport?: Transport }): MediaClient {
  if (!o.apiKey) throw new Error('createGeminiMedia requires an apiKey');
  const sdk: MediaSdk = o.sdk ?? (new GoogleGenAI(sdkClientOptions(o.apiKey)) as unknown as MediaSdk);
  const resolver = o.resolver ?? systemResolver;
  const transport = o.transport ?? systemTransport;
  return {
    async checkModel(model, signal) {
      if (!sdk.models.get) return { found: false, actions: [] };
      try {
        const m = (await sdk.models.get({ model, config: { abortSignal: signal } })) as { name?: string; supportedActions?: string[] };
        return { found: typeof m?.name === 'string' && m.name.length > 0, actions: Array.isArray(m?.supportedActions) ? m.supportedActions : [] };
      } catch { return { found: false, actions: [] }; }
    },
    async generateImage(r) {
      let resp: GcResp;
      try {
        // M7: exactly one text part, no tools (no search grounding), no system instruction, no reference media; store:false. M1: one request, SDK retries off.
        resp = (await sdk.models.generateContent({
          model: r.model,
          contents: [{ role: 'user', parts: [{ text: r.prompt }] }],
          config: {
            responseModalities: ['IMAGE'], candidateCount: 1, maxOutputTokens: r.maxOutputTokens, thinkingConfig: { thinkingLevel: 'MINIMAL' },
            imageConfig: { imageSize: r.imageSize, aspectRatio: r.aspect }, // no personGeneration: the SDK refuses it in Developer API mode (OD-5i, tools/plugins/media/pins.ts)
            safetySettings: IMAGE_SAFETY_SETTINGS, store: false, abortSignal: r.signal, httpOptions: { retryOptions: { attempts: 1 } },
          },
        })) as GcResp;
      } catch (e) { throw asHttp(e); }
      const u = resp.usageMetadata;
      const usage: ImageUsage | null = u ? {
        ...(u.promptTokenCount !== undefined ? { promptTokens: u.promptTokenCount } : {}), ...(u.candidatesTokenCount !== undefined ? { candidatesTokens: u.candidatesTokenCount } : {}),
        ...(u.thoughtsTokenCount !== undefined ? { thoughtsTokens: u.thoughtsTokenCount } : {}),
        ...(u.candidatesTokensDetails ? { byModality: u.candidatesTokensDetails.map((d) => ({ modality: String(d.modality ?? 'UNKNOWN'), tokens: d.tokenCount ?? 0 })) } : {}),
      } : null;
      const cand = resp.candidates?.[0];
      let dropped = 0;
      let image: ImageOut['image'];
      let tooLarge = false;
      for (const p of cand?.content?.parts ?? []) {
        const b = p.inlineData?.data;
        if (p.thought || typeof p.text === 'string' || !b) { dropped++; continue; } // M8: text and thought parts are discarded, never kept
        if (image || tooLarge) { dropped++; continue; } // M6: only the first final image
        if (b.length > Math.ceil((r.maxBytes * 4) / 3) + 4) { tooLarge = true; continue; } // checked on the base64 length before decoding
        image = { data: Buffer.from(b, 'base64'), mime: p.inlineData?.mimeType ?? 'image/png' };
      }
      const blocked = !!resp.promptFeedback?.blockReason || (cand?.finishReason !== undefined && cand.finishReason !== 'STOP') || (!image && !tooLarge);
      return { ...(image && !blocked ? { image } : {}), blocked, tooLarge, dropped, usage };
    },
    async startVideo(r) {
      let op: VidOp;
      try {
        op = (await sdk.models.generateVideos({
          model: r.model, prompt: r.prompt,
          config: { numberOfVideos: 1, durationSeconds: r.seconds, aspectRatio: r.aspect, personGeneration: r.personGeneration, abortSignal: r.signal, httpOptions: { retryOptions: { attempts: 1 } } },
        })) as VidOp;
      } catch (e) { throw asHttp(e); }
      if (!op?.name) throw new Error('the provider returned no job id');
      return { name: op.name };
    },
    async pollVideo(name, signal) {
      const operation = Object.assign(new GenerateVideosOperation(), { name });
      let op: VidOp;
      try {
        op = (await sdk.operations.getVideosOperation({ operation, config: { abortSignal: signal } } as never)) as VidOp;
      } catch (e) { throw asHttp(e); }
      if (!op?.done) return { done: false };
      if (op.error) return { done: true, failed: true };
      const uri = op.response?.generatedVideos?.[0]?.video?.uri;
      if (uri) return { done: true, uri };
      return (op.response?.raiMediaFilteredCount ?? 0) > 0 ? { done: true, filtered: true } : { done: true, failed: true };
    },
    async downloadVideo(uri, d) {
      // RF33: the key goes in a header, never in a URL; a uri that already carries a key parameter is refused; the uri is never logged.
      if (/[?&]key=/i.test(uri)) throw new Error('refused: the download address carries a key');
      if (!/^https:\/\//i.test(uri)) throw new Error('refused: the download address is not https'); // G2RF5-03: the key header never travels in clear text
      // M9: the first hop is https on exactly the files API host, under /v1beta/files/ and ending in :download
      let first: URL;
      try { first = new URL(uri); } catch { throw new Error('refused: not a valid download address'); }
      if (first.protocol !== 'https:' || first.hostname !== 'generativelanguage.googleapis.com' || !first.pathname.startsWith('/v1beta/files/') || !first.pathname.endsWith(':download')) throw new Error('refused: the download address is not a files API address');
      const res = await safeFetch(uri, { resolver, transport, signal: d.signal, maxBytes: d.maxBytes, timeoutMs: 60_000, allowHosts: d.hosts, headers: { 'x-goog-api-key': o.apiKey, accept: 'video/mp4,*/*' } });
      if (res.status !== 200) throw new GeminiHttpError(res.status);
      if (res.truncated) throw new Error('refused: the video is larger than the upload limit');
      return res.body;
    },
  };
}
