import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { newRunState } from '../../types.js';
import { approvalFor, BOT_TALK_TOOLS, isNoApproval, NO_APPROVAL_TOOLS } from '../../policy-approval.js';
import { breakThaiLabels, THAI_LINE_MAX, buildDiagramPage, checkDiagramSource, cleanTitle, DECK_DIAGRAMS, DiagramStore, DIAGRAM_ID, DIAGRAM_SOURCE_MAX_BYTES, MERMAID_CONFIG, newDiagramId, TYPE_KEYWORDS, type DiagramType } from './diagram.js';
import { cspHash, MERMAID_MIN_VERSION, MERMAID_SHA256, MERMAID_VERSION, MermaidError, readPinnedMermaid, sha256Hex } from './mermaid.js';

const FLOW = 'flowchart TD\n  A[Start] --> B[End]';

describe('RF24 source checks', () => {
  it('size: at most 20 KB counted in BYTES (Thai is 3 bytes a character)', () => {
    expect(DIAGRAM_SOURCE_MAX_BYTES).toBe(20 * 1024);
    const pad = (n: number) => `${FLOW}\n%% ${'a'.repeat(n)}`;
    expect(checkDiagramSource('flowchart', pad(DIAGRAM_SOURCE_MAX_BYTES - Buffer.byteLength(`${FLOW}\n%% `))).ok).toBe(true);
    expect(checkDiagramSource('flowchart', pad(DIAGRAM_SOURCE_MAX_BYTES)).ok).toBe(false);
    const thai = `${FLOW}\n%% ${'ก'.repeat(7000)}`; // 7000 chars, 21000 bytes
    expect(thai.length).toBeLessThan(DIAGRAM_SOURCE_MAX_BYTES);
    expect(checkDiagramSource('flowchart', thai)).toMatchObject({ ok: false, why: expect.stringContaining('20 KB') });
    expect(checkDiagramSource('flowchart', '   \n')).toMatchObject({ ok: false });
  });

  it('type keyword: the first non-comment, non-blank line must carry the keyword of the requested type', () => {
    const ok: Record<DiagramType, string> = {
      flowchart: 'flowchart LR\n A-->B', sequence: 'sequenceDiagram\n A->>B: hi', gantt: 'gantt\n title t\n dateFormat YYYY-MM-DD\n section s\n t :2026-11-03, 2d',
      timeline: 'timeline\n title t\n 2026 : a', mindmap: 'mindmap\n root((r))\n  a', class: 'classDiagram\n class A', er: 'erDiagram\n A ||--o{ B : has',
    };
    for (const [t, src] of Object.entries(ok)) expect(checkDiagramSource(t as DiagramType, src), t).toMatchObject({ ok: true });
    expect(checkDiagramSource('flowchart', 'graph TD\n A-->B').ok).toBe(true);
    // comments and blank lines before the keyword are fine; a different type's keyword is not
    expect(checkDiagramSource('flowchart', '\n%% a comment\n\n  flowchart TD\n A-->B').ok).toBe(true);
    expect(checkDiagramSource('sequence', FLOW).ok).toBe(false);
    expect(checkDiagramSource('flowchart', 'sequenceDiagram\n A->>B: x').ok).toBe(false);
    // keywords that are not allowed at all
    for (const bad of ['architecture-beta\n service a(server)[A]', 'zenuml\n A.b()', 'stateDiagram-v2\n [*] --> A', 'pie\n "a": 1', 'flowchartx TD', 'Flowchart TD', 'A-->B'])
      for (const t of Object.keys(TYPE_KEYWORDS)) expect(checkDiagramSource(t as DiagramType, bad).ok, `${t}: ${bad}`).toBe(false);
    expect(checkDiagramSource('flowchart', '---\ntitle: x\nconfig:\n  theme: dark\n---\nflowchart TD\n A-->B').ok).toBe(false); // front matter
  });

  it('refuses the forbidden constructs anywhere in the text, in any case', () => {
    const bad = ['%%{init: {"securityLevel":"loose"}}%%', 'click A "http://x"', 'CLICK A call f()', 'A --> B\n call cb()', 'A[<a href="x">y</a>]', 'A[x] --> B; href B', 'A --> B\n callback A', 'A["javascript:alert(1)"]',
      'A[<script>x</script>]', 'A[<SCRIPT>x]', 'A[<iframe src=x>]', 'A[<img src=x onerror=1>]', 'A[<a >x]', 'A[<foreignObject>x]', 'A[<style>x]', 'A[x onmouseover = 1]', 'A[ONCLICK=1]'];
    for (const b of bad) expect(checkDiagramSource('flowchart', `flowchart TD\n  ${b}`).ok, b).toBe(false);
    expect(checkDiagramSource('flowchart', 'flowchart TD\n A-->B %%{init}%%').ok).toBe(false); // directive after text
  });

  it('allows <br>, <br/> and the class annotation <<...>>, and words that merely contain a refused word', () => {
    expect(checkDiagramSource('flowchart', 'flowchart TD\n A["one<br>two<br/>three"] --> B').ok).toBe(true);
    expect(checkDiagramSource('class', 'classDiagram\n class Shape\n <<abstract>> Shape\n <<interface>> Shape\n <<styled>> Shape').ok).toBe(true);
    expect(checkDiagramSource('flowchart', 'flowchart TD\n A[Online store] --> B[Recall plan]').ok).toBe(true);
  });

  it('refuses control and bidi characters', () => {
    expect(checkDiagramSource('flowchart', `${FLOW}\n A[x\u0000y]`).ok).toBe(false);
    expect(checkDiagramSource('flowchart', `${FLOW}\n A[x‮y]`).ok).toBe(false);
  });

  it('RF24 redaction: secret-looking text is masked in the source that is rendered (a PNG cannot be masked afterwards)', () => {
    const key = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789';
    const r = checkDiagramSource('flowchart', `flowchart TD\n A[token ${key}] --> B`);
    expect(r).toMatchObject({ ok: true, redacted: true });
    if (r.ok) expect(r.source).not.toContain(key);
    expect(cleanTitle(`T ${key}‮\n x`)).not.toContain(key);
  });

  it('the fixed Mermaid configuration (RF23)', () => {
    expect(MERMAID_CONFIG).toMatchObject({ securityLevel: 'strict', htmlLabels: false, startOnLoad: false, maxTextSize: 20_000, flowchart: { htmlLabels: false } });
    expect(MERMAID_CONFIG.maxEdges).toBeLessThanOrEqual(200);
    // G2RF4-01 (RF25 residual): the DOMPurify 3.4.12 advisories need IN_PLACE / RETURN_DOM / SAFE_FOR_TEMPLATES / an xhtml parser, which Mermaid only
    // passes through `dompurifyConfig`. It must never be set here; directives and front matter (the other way to set it) are refused by RF24.
    expect(Object.keys(MERMAID_CONFIG)).not.toContain('dompurifyConfig');
    expect(Object.keys(MERMAID_CONFIG)).not.toContain('secure');
    expect(checkDiagramSource('flowchart', '%%{init: {"dompurifyConfig": {"RETURN_DOM": true}}}%%\nflowchart TD\n A-->B').ok).toBe(false);
    expect(checkDiagramSource('flowchart', '---\nconfig:\n  dompurifyConfig:\n    IN_PLACE: true\n---\nflowchart TD\n A-->B').ok).toBe(false);
  });

  it('G2RF4-01: the bundled DOMPurify is the reviewed 3.4.12 (a bump must re-run the OSV check and revisit the accepted residual)', () => {
    const code = readPinnedMermaid().code;
    expect(code.match(/\.version="3\.[0-9.]+"/g)).toEqual(['.version="3.4.12"']);
  });
});

describe('RF25 the pinned bundle', () => {
  it('the vendored file has the pinned sha256 (a test fails when it differs), version >= 11.10.0, SHA256SUMS and the licence agree', () => {
    const dir = new URL('../../../vendor/mermaid/', import.meta.url);
    const file = readFileSync(new URL('mermaid.min.js', dir));
    expect(sha256Hex(file)).toBe(MERMAID_SHA256);
    expect(readFileSync(new URL('SHA256SUMS', dir), 'utf8')).toContain(`${MERMAID_SHA256}  mermaid.min.js`);
    expect(readFileSync(new URL('LICENSE', dir), 'utf8')).toMatch(/MIT/);
    expect(readFileSync(new URL('README.md', dir), 'utf8')).toContain(MERMAID_VERSION);
    const v = (s: string) => s.split('.').map(Number);
    const [a, b, c] = v(MERMAID_VERSION);
    const [x, y, z] = v(MERMAID_MIN_VERSION);
    expect(a! > x! || (a === x && (b! > y! || (b === y && c! >= z!)))).toBe(true);
    expect(file.toString('utf8')).toContain(`"${MERMAID_VERSION}"`);
    expect(readPinnedMermaid().sha256).toBe(MERMAID_SHA256);
  });

  it('a bundle that differs from the pin is refused and no page is built (fixed MermaidError, nothing reaches Chrome)', () => {
    const d = mkdtempSync(join(tmpdir(), 'mm-'));
    try {
      const real = readFileSync(new URL('../../../vendor/mermaid/mermaid.min.js', import.meta.url));
      writeFileSync(join(d, 'mermaid.min.js'), Buffer.concat([real, Buffer.from('\n;alert(1)')]));
      const dir = pathToFileURL(`${d}/`);
      expect(() => readPinnedMermaid({ dir })).toThrow(MermaidError);
      expect(() => readPinnedMermaid({ dir })).toThrow(/sha256 pin/);
      expect(() => buildDiagramPage({ dir })).toThrow(MermaidError);
      // the same file passes against its own hash: the check is the hash, not the name
      expect(readPinnedMermaid({ dir, pin: sha256Hex(readFileSync(join(d, 'mermaid.min.js'))) }).code).toContain('alert(1)');
      // checked at EVERY load: a file changed after a good load is caught the next time
      writeFileSync(join(d, 'mermaid.min.js'), real);
      expect(() => readPinnedMermaid({ dir })).not.toThrow();
      writeFileSync(join(d, 'mermaid.min.js'), 'tampered');
      expect(() => readPinnedMermaid({ dir })).toThrow(MermaidError);
      rmSync(join(d, 'mermaid.min.js'));
      expect(() => readPinnedMermaid({ dir })).toThrow(/missing/);
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  it('the page: one inline script allowed by its hash in the CSP, no src/link/img/iframe, no remote URL, no unsafe-eval, and the Mermaid text is not in it', () => {
    const { html, sha256 } = buildDiagramPage();
    expect(sha256).toBe(MERMAID_SHA256);
    const csp = /Content-Security-Policy" content="([^"]+)"/.exec(html)![1]!;
    expect(csp).toMatch(/^default-src 'none'; script-src 'sha256-[A-Za-z0-9+/=]+'; /);
    expect(csp).not.toMatch(/unsafe-eval|https?:|\*/);
    const code = readPinnedMermaid().code;
    expect(csp).toContain(cspHash(code));
    const shell = html.replace(code, '');
    expect(shell).not.toMatch(/<script[^>]*\ssrc|<link|<img|<iframe|https?:\/\//i);
    expect((html.match(/<script/g) ?? []).length).toBe(1);
  });
});

describe('RF27 the approval allow-list and the diagram store', () => {
  it('diagram_create skips approval only through the named NO_APPROVAL_TOOLS list, which is not BOT_TALK_TOOLS', () => {
    expect(NO_APPROVAL_TOOLS).toEqual(['diagram_create', 'ws_create', 'ws_delete', 'ws_export', 'ws_run', 'ws_write']);
    expect(BOT_TALK_TOOLS).not.toContain('diagram_create');
    expect(isNoApproval('diagram_create')).toBe(true);
    const ctx = { direct: false, tainted: () => true };
    const s = { tool: 'diagram_create', target: 'diagram flowchart', change: 't' };
    expect(approvalFor('write', ctx, s)).toBe(false); // even undirected and tainted: only a picture in the run's own thread
    expect(approvalFor('write', ctx, { ...s, tool: 'doc_create' })).toMatchObject({ reason: expect.any(String) });
    expect(approvalFor('write', ctx, { ...s, tool: 'diagram_create2' })).toMatchObject({ reason: expect.any(String) });
    expect(approvalFor('destructive', ctx, s)).toMatchObject({ reason: expect.any(String) }); // the list never lifts a destructive call
  });

  it('ids look like dg-xxxxxxxx; they resolve only inside the same task tree (or the same run), never across trees, and unknown ids are null', () => {
    const id = newDiagramId();
    expect(id).toMatch(DIAGRAM_ID);
    const st = new DiagramStore();
    const run = newRunState();
    const a = st.scopeOf({ task: { rootId: 'rootA' }, run });
    const b = st.scopeOf({ task: { rootId: 'rootB' }, run });
    expect(a).not.toBe(b);
    expect(st.scopeOf({ task: { rootId: 'rootA' }, run: newRunState() })).toBe(a); // another run of the same tree
    st.put(a, id, { png: Buffer.from('x'), title: 't', dept: 'sales', tainted: false });
    expect(st.get(a, id)?.png.toString()).toBe('x');
    expect(st.get(b, id)).toBeNull();
    expect(st.get(a, 'dg-00000000')).toBeNull();
    expect(st.get(a, '../etc/passwd')).toBeNull();
    // without a task a run is its own scope, stable within the run
    const r1 = newRunState();
    expect(st.scopeOf({ task: null, run: r1 })).toBe(st.scopeOf({ task: null, run: r1 }));
    expect(st.scopeOf({ task: null, run: r1 })).not.toBe(st.scopeOf({ task: null, run: newRunState() }));
  });

  it('the store is bounded: at most 20 per scope (oldest out)', () => {
    const st = new DiagramStore();
    const ids = Array.from({ length: 22 }, () => newDiagramId());
    for (const id of ids) st.put('s', id, { png: Buffer.alloc(10), title: '', dept: '', tainted: false });
    expect(st.get('s', ids[0]!)).toBeNull();
    expect(st.get('s', ids[1]!)).toBeNull();
    expect(st.get('s', ids[21]!)).not.toBeNull();
    expect(DECK_DIAGRAMS).toBe(5);
  });
});

describe('P4-POLISH Thai line breaks (breakThaiLabels)', () => {
  const LONG = 'หัวหน้าอนุมัติการลาของพนักงานภายในสามวัน';
  it('wraps a long Thai label with <br/> only at word boundaries; no character of the text is lost or changed', () => {
    const out = breakThaiLabels('flowchart', `flowchart TD\n A[${LONG}] --> B[จบ]`);
    const label = /A\[(.*?)\]/.exec(out)![1]!;
    expect(label).toContain('<br/>');
    expect(label.replace(/<br\/>/g, '')).toBe(LONG);
    const seg = new Intl.Segmenter('th', { granularity: 'word' });
    const words = new Set([...seg.segment(LONG)].map((x) => x.segment));
    for (const line of label.split('<br/>')) expect(line.length).toBeGreaterThan(0), expect([...seg.segment(line)].every((x) => words.has(x.segment))).toBe(true);
    expect(out).toContain('B[จบ]');
  });
  it('leaves a short label, a non-Thai source and unsupported types alone; a <br/> already in the text stays', () => {
    expect(breakThaiLabels('flowchart', 'flowchart TD\n A[พนักงานยื่นใบลา] --> B')).toBe('flowchart TD\n A[พนักงานยื่นใบลา] --> B');
    expect(breakThaiLabels('flowchart', FLOW)).toBe(FLOW);
    expect(breakThaiLabels('gantt', `gantt\n ${LONG} :a1, 2026-01-01, 3d`)).toContain(LONG);
    expect(breakThaiLabels('er', `erDiagram\n ${LONG} ||--o{ B : x`)).toContain(LONG);
    expect(breakThaiLabels('flowchart', 'flowchart TD\n A[พนักงาน<br/>ยื่นใบลา]')).toBe('flowchart TD\n A[พนักงาน<br/>ยื่นใบลา]');
  });
  it('adds no markup but <br/>, so a source RF24 accepted stays acceptable; the check still sees the original text', () => {
    const src = `flowchart TD\n A[${LONG}] --> B`;
    expect(checkDiagramSource('flowchart', src).ok).toBe(true);
    const out = breakThaiLabels('flowchart', src);
    expect(out.replace(/<br\/>/g, '')).toBe(src);
    expect(checkDiagramSource('flowchart', out).ok).toBe(true);
    expect(checkDiagramSource('flowchart', `flowchart TD\n A[${LONG} click x] --> B`).ok).toBe(false);
    expect(THAI_LINE_MAX).toBeGreaterThan(0);
  });
  it('keeps a single over-long word whole', () => {
    const w = 'ประสิทธิภาพประสิทธิผล';
    expect(breakThaiLabels('mindmap', `mindmap\n  root((${w}))`).replace(/<br\/>/g, '')).toContain(w);
  });
  it('the fixed config turns Mermaid auto-wrap off, so the <br/> lines are the only breaks', () => {
    expect(MERMAID_CONFIG.wrap).toBe(false);
    expect(MERMAID_CONFIG.markdownAutoWrap).toBe(false);
    expect(MERMAID_CONFIG.flowchart.wrappingWidth).toBeGreaterThanOrEqual(2000);
    expect(MERMAID_CONFIG.flowchart.htmlLabels).toBe(false);
    expect(MERMAID_CONFIG.htmlLabels).toBe(false);
  });
  it('the live labels wrap at word boundaries within the limit', () => {
    const out = breakThaiLabels('flowchart', 'flowchart TD\n A[ทีมการตลาดเขียนแคปชันและออกแบบภาพ] --> B[ส่งกลับให้ทีมแก้ไขตามคำแนะนำ]');
    expect(out).toContain('A[ทีมการตลาดเขียน<br/>แคปชันและออกแบบ<br/>ภาพ]');
    expect(out).toContain('B[ส่งกลับให้ทีมแก้ไข<br/>ตามคำแนะนำ]');
  });
});
