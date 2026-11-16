import { randomBytes } from 'node:crypto';
import { redactText } from '../../../core/logger.js';
import type { RunState } from '../../types.js';
import { fontCss } from './fonts.js';
import { cspHash, MermaidError, readPinnedMermaid } from './mermaid.js';

/**
 * RFMD P4 / RF23 / RF24 / RF27: everything about a diagram that is decided in code, with no browser: the allowed types, the checks on the Mermaid source,
 * the fixed Mermaid configuration, the render page, and the per-task store that lets a slide deck embed a diagram made earlier in the same task tree.
 */

export const DIAGRAM_TYPES = ['flowchart', 'sequence', 'gantt', 'timeline', 'mindmap', 'class', 'er'] as const;
export type DiagramType = (typeof DIAGRAM_TYPES)[number];

/** RF24: the first-line keywords each type accepts. Not allowed: architecture (CVE-2025-54880), zenuml, anything with math/KaTeX, state, pie, C4, sankey, block, packet, ... */
export const TYPE_KEYWORDS: Readonly<Record<DiagramType, readonly string[]>> = {
  flowchart: ['flowchart', 'graph'],
  sequence: ['sequenceDiagram'],
  gantt: ['gantt'],
  timeline: ['timeline'],
  mindmap: ['mindmap'],
  class: ['classDiagram'],
  er: ['erDiagram'],
};

export const DIAGRAM_SOURCE_MAX_BYTES = 20 * 1024;
export const DIAGRAM_TITLE_MAX = 120;
/** The largest PNG kept and posted. A deck embeds up to DECK_DIAGRAMS of them, so the deck page stays under the renderer's HTML cap. */
export const DIAGRAM_PNG_MAX_BYTES = 768 * 1024;
export const DECK_DIAGRAMS = 5;
export const DIAGRAM_RENDER_TIMEOUT_MS = 15_000;
export const DIAGRAM_MAX_SIDE = 3000; // CSS px of the drawn diagram; larger is refused

/** RF24: refused anywhere in the source (case-insensitive). `<br>`, `<br/>` and the class annotation `<<...>>` stay allowed. */
const FORBIDDEN: readonly { re: RegExp; what: string }[] = [
  { re: /%%\{/, what: 'a %%{ directive' },
  { re: /\bclick\b/i, what: 'the word "click"' },
  { re: /\bcall\b/i, what: 'the word "call"' },
  { re: /href/i, what: 'href' },
  { re: /callback/i, what: 'callback' },
  { re: /javascript:/i, what: 'javascript:' },
  { re: /<script\b/i, what: '<script' },
  { re: /<iframe\b/i, what: '<iframe' },
  { re: /<img\b/i, what: '<img' },
  { re: /<a[\s/>]/i, what: '<a' },
  { re: /<foreignobject\b/i, what: '<foreignObject' },
  { re: /<style\b/i, what: '<style' },
  { re: /\bon[a-z]+\s*=/i, what: 'an on...= attribute' },
];
const NO_CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F‪-‮⁦-⁩]/;

export type SourceCheck = { ok: true; source: string; redacted: boolean } | { ok: false; why: string };

/** RF24: size (bytes), the type keyword on the first non-comment line, the forbidden list, then redaction (text inside a PNG cannot be masked afterwards). */
export function checkDiagramSource(type: DiagramType, raw: string): SourceCheck {
  if (typeof raw !== 'string' || raw.trim() === '') return { ok: false, why: 'the diagram source is empty' };
  if (Buffer.byteLength(raw, 'utf8') > DIAGRAM_SOURCE_MAX_BYTES) return { ok: false, why: `the diagram source is larger than ${DIAGRAM_SOURCE_MAX_BYTES / 1024} KB` };
  if (NO_CONTROL.test(raw)) return { ok: false, why: 'the diagram source has control characters' };
  const lines = raw.split(/\r\n|\r|\n/);
  const first = lines.find((l) => l.trim() !== '' && !/^\s*%%(?!\{)/.test(l));
  if (first === undefined) return { ok: false, why: 'the diagram source has no diagram line' };
  const word = /^\s*([A-Za-z][A-Za-z0-9]*)/.exec(first)?.[1];
  const allowed = TYPE_KEYWORDS[type];
  if (!word || !allowed.includes(word)) return { ok: false, why: `the first line of a ${type} diagram must start with ${allowed.join(' or ')}` };
  for (const f of FORBIDDEN) if (f.re.test(raw)) return { ok: false, why: `the diagram source may not contain ${f.what}` };
  const source = redactText(raw);
  return { ok: true, source, redacted: source !== raw };
}

// ---- Thai line breaks ------------------------------------------------------------------------------------------------------------------------

const THAI_RUN = /[\u0E00-\u0E7F][\u0E00-\u0E7F0-9A-Za-z ().,/]*/g;
/** Thai combining marks (above/below vowels, tone marks): they take no width, so they are not counted. */
const THAI_MARK = /[\u0E31\u0E34-\u0E3A\u0E47-\u0E4E]/g;
export const THAI_LINE_MAX = 14;
const BREAK_TYPES: ReadonlySet<DiagramType> = new Set<DiagramType>(['flowchart', 'sequence', 'mindmap', 'timeline']);
const visibleLen = (s: string): number => s.replace(THAI_MARK, '').length;
const thaiWords = typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function' ? new Intl.Segmenter('th', { granularity: 'word' }) : null;

/**
 * The pinned Mermaid wraps a label that is too wide at any character (Thai has no spaces; a zero-width space is not a break for it), which cuts words in two.
 * So a long Thai run is wrapped here with `<br/>` (already allowed by RF24) at word boundaries only. Runs only text that RF24 already accepted; the only
 * markup added is the fixed `<br/>`; no character of the user's text is changed. A single word wider than the limit stays whole on its line.
 */
export function breakThaiLabels(type: DiagramType, source: string): string {
  if (!thaiWords || !BREAK_TYPES.has(type)) return source;
  return source.replace(THAI_RUN, (run) => {
    const text = run.trimEnd();
    const tail = run.slice(text.length);
    if (visibleLen(text) <= THAI_LINE_MAX) return run;
    const lines: string[] = [];
    let cur = '';
    for (const seg of thaiWords.segment(text)) {
      const w = seg.segment;
      if (cur !== '' && visibleLen((cur + w).trimEnd()) > THAI_LINE_MAX) {
        lines.push(cur.trimEnd());
        cur = w.trimStart();
      } else cur += w;
    }
    if (cur.trim() !== '') lines.push(cur.trimEnd());
    return lines.join('<br/>') + tail;
  });
}

/** The title is shown in the posted message, so it is plain one-line text. */
export const cleanTitle = (t: string): string => redactText(t.replace(/[\u0000-\u001F\u007F‪-‮⁦-⁩]/g, ' ').replace(/\s+/g, ' ').trim()).slice(0, DIAGRAM_TITLE_MAX);

/** RF23: the fixed Mermaid configuration. Nothing in it comes from the model. */
export const MERMAID_CONFIG = {
  startOnLoad: false,
  securityLevel: 'strict',
  htmlLabels: false,
  maxTextSize: 20_000,
  maxEdges: 150,
  theme: 'neutral',
  fontFamily: 'Sarabun, sans-serif',
  // P4-POLISH: the only line breaks are the explicit <br/> from breakThaiLabels. Mermaid's own wrap cuts Thai at any character (live: 12 chars were over the width).
  wrap: false,
  markdownAutoWrap: false,
  flowchart: { htmlLabels: false, wrappingWidth: 5000 },
  deterministicIds: true,
} as const;

/**
 * RF23: the diagram page. The bundle is the only script and the CSP allows exactly its hash (no 'unsafe-eval', no network source); the Mermaid text is never
 * pasted here: it is passed as an `evaluate` argument by the driver. Throws MermaidError when the pinned file fails its check.
 */
export function buildDiagramPage(o: { dir?: URL; pin?: string } = {}): { html: string; sha256: string } {
  const { code, sha256 } = readPinnedMermaid(o);
  if (/<\/script/i.test(code)) throw new MermaidError('the mermaid bundle cannot be inlined');
  const csp = `default-src 'none'; script-src ${cspHash(code)}; style-src 'unsafe-inline'; font-src data:; img-src data:`;
  return {
    sha256,
    html: `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><style>${fontCss()}html,body{margin:0;background:#fff}#out{display:inline-block;padding:16px;background:#fff}</style></head><body><div id="out"></div><script>${code}</script></body></html>`,
  };
}

// ---- the per-task store (RF27) --------------------------------------------------------------------------------------------------------------

export const DIAGRAM_ID = /^dg-[0-9a-f]{8}$/;
export const newDiagramId = (): string => `dg-${randomBytes(4).toString('hex')}`;

const PER_SCOPE = 20;
const TOTAL_BYTES = 48 * 1024 * 1024;
/** `tainted`: the taint of the run that made it (G2RF4-02); a document embedding it inherits that taint. */
type Entry = { png: Buffer; title: string; dept: string; tainted: boolean };

/**
 * Diagram ids resolve only inside the task tree that made them (`task.rootId`; a run without a task is its own scope), so a model cannot name an id from
 * another department's task. In memory, bounded by count per scope and by total bytes (oldest first out); a restart forgets them.
 */
export class DiagramStore {
  private readonly scopes = new Map<string, Map<string, Entry>>();
  private readonly runScopes = new WeakMap<RunState, string>();
  private bytes = 0;

  scopeOf(ctx: { task: { rootId: string } | null; run: RunState }): string {
    if (ctx.task) return `task:${ctx.task.rootId}`;
    let s = this.runScopes.get(ctx.run);
    if (!s) this.runScopes.set(ctx.run, (s = `run:${randomBytes(6).toString('hex')}`));
    return s;
  }

  /**
   * A top-level conversation has no task while the run draws its diagrams (they go into the run's scope); the task is opened when doc_create asks for approval, and the
   * approved call later runs inside that task. So the run's diagrams are moved into the task's scope at that moment. Same run, same task: no id crosses tasks or users.
   */
  adopt(run: RunState, rootId: string): void {
    const from = this.runScopes.get(run);
    const src = from ? this.scopes.get(from) : undefined;
    if (!from || !src) return;
    const to = `task:${rootId}`;
    let dst = this.scopes.get(to);
    if (!dst) this.scopes.set(to, (dst = new Map()));
    for (const [k, v] of src) dst.set(k, v);
    while (dst.size > PER_SCOPE) this.dropOldest(dst);
    this.scopes.delete(from);
    this.runScopes.delete(run);
  }

  put(scope: string, id: string, e: Entry): void {
    let m = this.scopes.get(scope);
    if (!m) this.scopes.set(scope, (m = new Map()));
    m.set(id, e);
    this.bytes += e.png.length;
    while (m.size > PER_SCOPE) this.dropOldest(m);
    while (this.bytes > TOTAL_BYTES) {
      const first = this.scopes.entries().next().value;
      if (!first) break;
      if (first[1].size === 0) this.scopes.delete(first[0]);
      else this.dropOldest(first[1]);
    }
  }

  get(scope: string, id: string): Entry | null {
    return DIAGRAM_ID.test(id) ? (this.scopes.get(scope)?.get(id) ?? null) : null;
  }

  private dropOldest(m: Map<string, Entry>): void {
    const k = m.keys().next().value;
    if (k === undefined) return;
    this.bytes -= m.get(k)!.png.length;
    m.delete(k);
  }
}
