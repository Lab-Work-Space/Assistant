import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

/**
 * RF23 / RF25: Mermaid is vendored (vendor/mermaid, MIT), pinned by version and sha256, and handed to the render page from the host. It is never loaded
 * from a CDN. The hash is checked every time the file is read (a changed file is never cached past a check): a mismatch is a fixed refusal and
 * nothing reaches Chrome.
 */
export const MERMAID_VERSION = '12.2.0';
export const MERMAID_SHA256 = 'a8a6a6f805b074a8261a2825c86f99c8054acb3b35f50bb7e24a4f9f2c3c3b9f';
export const MERMAID_MIN_VERSION = '11.10.0'; // CVE-2025-54880 (architecture iconText XSS) is fixed from here

export class MermaidError extends Error {}

const DIR = new URL('../../../vendor/mermaid/', import.meta.url);
export const sha256Hex = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex');

/** The bundle text, verified against the pin right now. Throws MermaidError when it is missing or differs. */
export function readPinnedMermaid(o: { dir?: URL; pin?: string } = {}): { code: string; sha256: string } {
  let data: Buffer;
  try {
    data = readFileSync(new URL('mermaid.min.js', o.dir ?? DIR));
  } catch {
    throw new MermaidError('the mermaid bundle is missing');
  }
  const sha = sha256Hex(data);
  if (sha !== (o.pin ?? MERMAID_SHA256)) throw new MermaidError('the mermaid bundle does not match its sha256 pin');
  return { code: data.toString('utf8'), sha256: sha };
}

/** CSP source for an inline script with this exact content: 'sha256-<base64>'. */
export const cspHash = (code: string): string => `'sha256-${createHash('sha256').update(code, 'utf8').digest('base64')}'`;
