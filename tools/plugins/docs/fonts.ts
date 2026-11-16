import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

/**
 * RF16: Thai and Latin fonts are vendored (vendor/fonts, Sarabun, SIL OFL 1.1), pinned by sha256 and embedded in each document as `data:` URLs.
 * There is no web font and no CDN. The hash is checked when the file is first read in this process; a file that differs from the pin makes
 * every document fail closed (the renderer is never handed an unverified font).
 */
export const FONT_PINS: Readonly<Record<string, string>> = {
  'Sarabun-Regular.ttf': '226d4f368fbc0457990ddef2692679badfd2c1a4e89e5ac4d43c10ba7743b2f1',
  'Sarabun-Bold.ttf': 'd38308ca27d067b9a1b79006337c1f9a66c29aa016d96a9d88d3801da7fa83b9',
};

export class FontError extends Error {}

const DIR = new URL('../../../vendor/fonts/', import.meta.url);
let cached: string | null = null;

export const sha256 = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

/** Reads one pinned font; throws FontError when it is missing or its sha256 differs from the pin. */
export function readPinnedFont(name: string, dir: URL = DIR): Buffer {
  const pin = FONT_PINS[name];
  if (!pin) throw new FontError(`unknown font ${name}`);
  let data: Buffer;
  try {
    data = readFileSync(new URL(name, dir));
  } catch {
    throw new FontError(`font ${name} is missing`);
  }
  if (sha256(data) !== pin) throw new FontError(`font ${name} does not match its sha256 pin`);
  return data;
}

/** The @font-face rules (data: URLs only). Cached after the first successful verification. */
export function fontCss(): string {
  if (cached) return cached;
  const face = (name: string, weight: number) =>
    `@font-face{font-family:'Sarabun';font-style:normal;font-weight:${weight};src:url(data:font/ttf;base64,${readPinnedFont(name).toString('base64')}) format('truetype');}`;
  cached = face('Sarabun-Regular.ttf', 400) + face('Sarabun-Bold.ttf', 700);
  return cached;
}
