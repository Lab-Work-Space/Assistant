import type { ConfigStore } from '../../../config/store.js';
import { IMAGE_MAX_OUTPUT_TOKENS, IMAGE_MODEL, PROMPT_TOKEN_CAP, VIDEO_MODEL, VIDEO_OUTPUT_EXTRA_TOKENS } from './pins.js';

/**
 * RFMD P5 M2/M3: token prices per modality and the reserve/settle arithmetic. Prices come from config (floored at 50 % of list in the schema); the token units per image
 * and per video second are code constants next to the pins. Everything is rounded UP to micro-dollars for reservations and to the nearest micro-dollar for settles.
 */
type Cfg = Pick<ConfigStore, 'get'>;
export type ImagePrices = { inPerMTok: number; textOutPerMTok: number; imageOutPerMTok: number };
export type VideoPrices = { inPerMTok: number; textOutPerMTok: number; videoOutPerMTok: number };

export const imagePrices = (cfg: Cfg): ImagePrices => ({ inPerMTok: cfg.get('media.image.inPerMTok'), textOutPerMTok: cfg.get('media.image.textOutPerMTok'), imageOutPerMTok: cfg.get('media.image.imageOutPerMTok') });
export const videoPrices = (cfg: Cfg): VideoPrices => ({ inPerMTok: cfg.get('media.video.inPerMTok'), textOutPerMTok: cfg.get('media.video.textOutPerMTok'), videoOutPerMTok: cfg.get('media.video.videoOutPerMTok') });
const ok = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0;
export const pricesValid = (p: Record<string, number>): boolean => Object.values(p).every(ok);

export const ceilMicro = (x: number): number => Math.ceil(Number((x * 1e6).toFixed(4))) / 1e6;
const roundMicro = (x: number): number => Math.round(x * 1e6) / 1e6;

/** M3/M6: the ceiling of ONE image call: the input cap plus the output-token cap that is sent as maxOutputTokens, at the dearer of the media and text rates (about $0.065). */
export const imageCeilingUsd = (p: ImagePrices): number =>
  ceilMicro((PROMPT_TOKEN_CAP * p.inPerMTok + IMAGE_MAX_OUTPUT_TOKENS * Math.max(p.imageOutPerMTok, p.textOutPerMTok)) / 1e6);
/** M3: the typical cost of one 1K image (shown on the card next to the ceiling). */
export const imageTypicalUsd = (p: ImagePrices): number => ceilMicro((IMAGE_MODEL.tokensPerImage * p.imageOutPerMTok) / 1e6);
/** M3: video ceiling: input cap plus (seconds x tokens per second + 65,536) at the dearer rate. */
export const videoCeilingUsd = (p: VideoPrices, seconds: number): number =>
  ceilMicro((PROMPT_TOKEN_CAP * p.inPerMTok + (seconds * VIDEO_MODEL.tokensPerSecond + VIDEO_OUTPUT_EXTRA_TOKENS) * Math.max(p.videoOutPerMTok, p.textOutPerMTok)) / 1e6);

export type Usage = {
  promptTokens?: number; candidatesTokens?: number; thoughtsTokens?: number;
  /** output tokens by modality as the provider reports them (generateContent: candidatesTokensDetails) */
  byModality?: { modality: string; tokens: number }[];
};
export type Settled = { usd: number; basis: 'usage' | 'full'; overrun: boolean };

/**
 * M3 settle for an image call: `in x prompt + sum(per-modality output) + thoughts x textOut + residual at the dearest media rate`, never below the delivered-unit floor.
 * Missing or zero usage, an unknown modality or a non-finite number is settled IN FULL (the reservation). Thought tokens are added (never assumed to be inside the counts).
 * Above the reservation: booked at the actual amount and flagged (the caller files an incident).
 */
export function settleImage(p: ImagePrices, u: Usage | null | undefined, delivered: number, reserved: number): Settled {
  const full: Settled = { usd: reserved, basis: 'full', overrun: false };
  if (!u) return full;
  const nums = [u.promptTokens ?? 0, u.candidatesTokens ?? 0, u.thoughtsTokens ?? 0, ...(u.byModality ?? []).map((m) => m.tokens)];
  if (nums.some((n) => !Number.isFinite(n) || n < 0)) return full;
  if ((u.promptTokens ?? 0) + (u.candidatesTokens ?? 0) <= 0) return full;
  let out = 0;
  let counted = 0;
  for (const m of u.byModality ?? []) {
    const rate = m.modality === 'IMAGE' ? p.imageOutPerMTok : m.modality === 'TEXT' ? p.textOutPerMTok : null;
    if (rate === null) return full; // unknown modality
    out += m.tokens * rate;
    counted += m.tokens;
  }
  const total = u.candidatesTokens ?? 0;
  if (total > counted) out += (total - counted) * Math.max(p.imageOutPerMTok, p.textOutPerMTok);
  const actual = ((u.promptTokens ?? 0) * p.inPerMTok + out + (u.thoughtsTokens ?? 0) * p.textOutPerMTok) / 1e6;
  const floor = (delivered * IMAGE_MODEL.tokensPerImage * p.imageOutPerMTok) / 1e6;
  const usd = roundMicro(Math.max(actual, floor));
  return { usd, basis: 'usage', overrun: usd > reserved };
}
