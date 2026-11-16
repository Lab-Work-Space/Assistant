import { createHash, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { docsRoot } from './root.js';
import { z } from 'zod';
import { DEFAULT_DUTIES, dutyRefusal, type DutyTable } from '../../../company/duties.js';
import type { CompanyProfile } from '../../../company/profile.js';
/** Kinds that are legally meaningless without the issuer's tax ID; refused until company.profile.taxId is set. */
const TAX_ID_KINDS: ReadonlySet<string> = new Set(['tax_invoice', 'withholding_tax_cert']);
import { cleanCardText } from '../../../company/forward.js';
import { redactText } from '../../../core/logger.js';
import type { IncidentSink } from '../../../core/incidents.js';
import type { DeptId } from '../../../core/index.js';
import { toolError, type RunState, type ToolContext, type ToolPlugin } from '../../types.js';
import type { GroupFactory } from '../index.js';
import { LIMITS, SandboxError, Workspace } from '../workspace/sandbox.js';
import { breakThaiLabels, buildDiagramPage, checkDiagramSource, cleanTitle, DIAGRAM_TYPES, DiagramStore, newDiagramId, MERMAID_CONFIG, DIAGRAM_SOURCE_MAX_BYTES, type DiagramType } from './diagram.js';
import { MermaidError } from './mermaid.js';
import { FontError } from './fonts.js';
import { DOC_KINDS, isDraftKind, KIND_INFO, needsProfile, type DocKind } from './kinds.js';
import { computeTotals, fmtSatang, MoneyError, toSatang, whtOn, type Totals } from './money.js';
import { PDF_MAX_BYTES, RenderError, type DocRenderer } from './render.js';
import { dataSizeProblem, DATA_MAX_BYTES, KIND_FIELD_HINTS, KIND_SCHEMAS, parseDataText, type DocData } from './schemas.js';
import { buildDocument, draftRef } from './templates.js';
import { RENDERER_OFF } from './boot.js';

/**
 * `doc_create(kind, data)` (RFMD P3, Gate 1 RF15-RF22, RF35, RF38). A department head turns structured data into a business document: the HTML template is
 * code-owned per kind, the amounts are computed here in integer satang, the page is rendered to PDF by the separate renderer container (docs/render.ts), a CSV
 * is made for tabular kinds, both files are posted in the run's own thread and a copy is kept in the department's document folder.
 *
 * Gates, in order: strict zod per kind (size, numbers, no totals) -> precheck (duty from the LIVE table, company.profile for money kinds, audience room)
 * -> approval (money, tax and HR-offer kinds ALWAYS ask, whatever `direct` says; every other kind is a write under approvalFor) -> render. Money and tax
 * kinds and the offer letter carry the DRAFT watermark; the schemas have no number, signature or recipient field; the tool can post nowhere but the
 * run's own thread, and the bytes it attaches are the ones it just made (never a path or URL from the model).
 */

const Input = z.object({
  kind: z.enum(DOC_KINDS).describe('The document kind'),
  data: z.string().min(2).describe('The JSON text of an object with the fields of that kind (see the tool description); amounts in baht with at most 2 decimals; NO totals: they are computed by code'),
}).strict().superRefine((v, ctx) => {
  const size = dataSizeProblem(v.data);
  if (size) return void ctx.addIssue({ code: 'custom', path: ['data'], message: size });
  const obj = parseDataText(v.data);
  if (!obj) return void ctx.addIssue({ code: 'custom', path: ['data'], message: 'data must be the JSON text of one object' });
  const r = KIND_SCHEMAS[v.kind].safeParse(obj);
  if (!r.success) for (const i of r.error.issues.slice(0, 8)) ctx.addIssue({ code: 'custom', path: ['data', ...i.path], message: i.message });
});
type In = z.infer<typeof Input>;

const RUN_CAP = 3;
const created = new WeakMap<RunState, number>();

const DESCRIPTION = `Create a business document as a PDF (and a CSV for tables) from structured data. Kinds and fields:\n${DOC_KINDS.map((k) => `- ${k}: ${KIND_FIELD_HINTS[k]}`).join('\n')}\n` +
  'slides makes a landscape slide deck (one slide per section); plan and slides can embed diagrams made earlier in this task with diagram_create (diagramId). Dates are YYYY-MM-DD. Subtotal, VAT 7% (vat:true), withholding tax and totals are computed by code: do not send totals. Money, tax and offer-letter documents are DRAFTS ' +
  `watermarked "DRAFT", always need approval, and are never sent outside; they need the company profile to be set. The department must hold the kind's duty (meeting_minutes, plan, slides and report: any head). At most ${RUN_CAP} per run.`;

/** The validated data of an input that already passed `Input` (the JSON text parsed again; the registry stores the text, so a replay parses it too). */
function dataOf(input: In): DocData[DocKind] {
  return KIND_SCHEMAS[input.kind].parse(parseDataText(input.data)) as DocData[DocKind];
}

const deptOf = (ctx: Pick<ToolContext, 'actor' | 'org'>): DeptId | null =>
  ctx.actor.kind === 'head' ? ctx.actor.dept : ((ctx.org.persona(ctx.actor.personaId)?.deptId as DeptId | undefined) ?? null);

/** RF22: duty refusal text from code values only (the WS12 refusal for the kind's first duty), or null when allowed. */
export function kindRefusal(kind: DocKind, ctx: Pick<ToolContext, 'actor' | 'org' | 'duties'>): string | null {
  const info = KIND_INFO[kind];
  if (info.duties === 'any_head') return ctx.actor.kind === 'head' ? null : `doc_create: ${kind} can be made by a department head only`;
  const dept = deptOf(ctx);
  if (!dept) return `doc_create: the department could not be determined`;
  const table: DutyTable = ctx.duties?.() ?? DEFAULT_DUTIES;
  if (info.duties.some((d) => table[dept]?.includes(d))) return null;
  return `doc_create: ${kind}: ${dutyRefusal(table, dept, info.duties[0]!)}`;
}

/** The totals the approval card and the result show, computed by code from the validated data (null for kinds without amounts). */
function cardFacts(kind: DocKind, data: DocData[DocKind]): { who: string; money: string } {
  const clean = (s: string) => cleanCardText(s, 80);
  switch (kind) {
    case 'purchase_request': { const d = data as DocData['purchase_request']; return { who: `requester ${clean(d.requester)}`, money: totalsText(computeTotals({ lines: d.lines, vat: d.vat ?? false, discount: d.discount })) }; }
    case 'purchase_order': { const d = data as DocData['purchase_order']; return { who: `supplier ${clean(d.supplier.name)}`, money: totalsText(computeTotals({ lines: d.lines, vat: d.vat ?? false, discount: d.discount, whtRate: d.whtRate })) }; }
    case 'quotation': { const d = data as DocData['quotation']; return { who: `customer ${clean(d.customer.name)}`, money: totalsText(computeTotals({ lines: d.lines, vat: d.vat ?? false, discount: d.discount })) }; }
    case 'invoice_receipt': { const d = data as DocData['invoice_receipt']; return { who: `customer ${clean(d.customer.name)}`, money: totalsText(computeTotals({ lines: d.lines, vat: d.vat ?? false, discount: d.discount, whtRate: d.whtRate })) }; }
    case 'tax_invoice': { const d = data as DocData['tax_invoice']; return { who: `customer ${clean(d.customer.name)}`, money: totalsText(computeTotals({ lines: d.lines, vat: true, discount: d.discount })) }; }
    case 'withholding_tax_cert': { const d = data as DocData['withholding_tax_cert']; const w = whtOn(d.amountPaid, d.whtRate); return { who: `payee ${clean(d.payee.name)}`, money: `paid ${fmtSatang(w.paid)}, withheld ${d.whtRate}% = ${fmtSatang(w.wht)} THB` }; }
    case 'expense_report': { const d = data as DocData['expense_report']; return { who: `employee ${clean(d.employee)}`, money: `total ${fmtSatang(d.expenses.reduce((s, e) => s + toSatang(e.amount), 0))} THB` }; }
    case 'offer_letter': { const d = data as DocData['offer_letter']; return { who: `candidate ${clean(d.candidate)}`, money: `monthly salary ${fmtSatang(toSatang(d.monthlySalary))} THB` }; }
    default: return { who: '', money: '' };
  }
}
const totalsText = (t: Totals): string =>
  `subtotal ${fmtSatang(t.subtotal)}${t.discount ? `, discount ${fmtSatang(t.discount)}` : ''}, VAT ${fmtSatang(t.vat)}${t.wht ? `, withholding ${t.whtRate}% ${fmtSatang(t.wht)}` : ''}, payable ${fmtSatang(t.payable)} THB`;

/** What an approval card shows: kind, the counterparty and the totals computed by code (never model-supplied totals). */
function summaryLine(kind: DocKind, data: DocData[DocKind]): string {
  const f = cardFacts(kind, data);
  return `${isDraftKind(kind) ? 'DRAFT ' : ''}${KIND_INFO[kind].title.split(' (')[0]}${f.who ? `; ${f.who}` : ''}${f.money ? `; ${f.money}` : ''}`;
}

const isoDate = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
const sha = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex');

/** BOTLOG-1: render faults of the system (renderer down, crashed, timed out) go to #bot-log; content problems (too large, too long, bad diagram text, busy) do not. */
function reportRender(deps: { incidents?: IncidentSink }, ctx: ToolContext, stage: string, e: unknown): void {
  if (e instanceof RenderError && !['unavailable', 'failed', 'timeout'].includes(e.code)) return;
  deps.incidents?.report({ source: 'tool', stage, toolName: stage === 'render' ? 'doc_create' : 'diagram_create', err: e, actor: ctx.actor, ...(ctx.task ? { taskId: ctx.task.id, taskTitle: ctx.task.title } : {}) });
}

const RENDER_TEXT: Record<string, string> = {
  busy: 'the document renderer is busy; try again in a minute',
  timeout: 'rendering took too long (20 s); make the document shorter',
  too_large: 'the document is too large (the PDF may be at most 8 MB); make it shorter',
  too_many_pages: 'the document is too long (at most 30 pages); make it shorter',
  unavailable: 'the document renderer is unavailable',
  failed: 'the document could not be rendered',
  bad_source: 'the diagram could not be drawn',
};

// ---- diagram_create (RFMD P4) ---------------------------------------------------------------------------------------------------------------

const DiagramInput = z.object({
  type: z.enum(DIAGRAM_TYPES).describe('flowchart (also org charts), sequence, gantt, timeline, mindmap, class, er'),
  source: z.string().min(1).max(60_000).describe(`Mermaid text, at most ${DIAGRAM_SOURCE_MAX_BYTES / 1024} KB; the first line must be the type keyword (flowchart/graph, sequenceDiagram, gantt, timeline, mindmap, classDiagram, erDiagram)`),
  title: z.string().trim().min(1).max(200).describe('A short title shown with the picture'),
}).strict().superRefine((v, ctx) => {
  const c = checkDiagramSource(v.type, v.source);
  if (!c.ok) ctx.addIssue({ code: 'custom', path: ['source'], message: c.why });
});
type DiagramIn = z.infer<typeof DiagramInput>;
const DIAGRAM_RUN_CAP = 4;
const diagramsMade = new WeakMap<RunState, number>();

const DIAGRAM_DESCRIPTION = `Draw a diagram from Mermaid text and post it as a PNG in this thread. Types: ${DIAGRAM_TYPES.join(', ')}. The source must start with the type's keyword ` +
  '(flowchart or graph; sequenceDiagram; gantt; timeline; mindmap; classDiagram; erDiagram), at most 20 KB. Not allowed: %%{ directives, a --- front-matter block, click/call/href/callback ' +
  'lines, links, HTML other than <br>. Plain text labels only. Returns a diagram id that doc_create (kinds plan and slides) can embed in this same task. At most ' + DIAGRAM_RUN_CAP + ' per run.';

/** Diagram ids a plan or slides document names, in order. */
function diagramIdsOf(kind: DocKind, data: DocData[DocKind]): string[] {
  if (kind !== 'plan' && kind !== 'slides') return [];
  return (data as DocData['plan']).sections.flatMap((s) => (s.diagramId ? [s.diagramId] : []));
}

export const docsGroup: GroupFactory = (deps) => {
  if (!deps.renderer) return { id: 'docs', disabled: deps.rendererDisabled ?? RENDERER_OFF, ...(deps.rendererFailed ? { error: true as const } : {}) };
  const renderer: DocRenderer = deps.renderer;
  // RF21: department documents live in a folder of their own, OUTSIDE Praw's workspace root, so Praw's read_file / list_files can never reach HR or finance files.
  const folder = docsRoot({ docsDir: deps.docsDir, workspaceRoot: deps.workspaceRoot ?? join(process.cwd(), 'data/workspace/praw') });
  if (!folder.ok) return { id: 'docs', disabled: `doc_create is off: ${folder.why}` };
  const folderRoot = folder.root;
  const store = new DiagramStore();
  const workspaces = new Map<string, Workspace>();
  const workspaceOf = (dept: string): Workspace | null => {
    let w = workspaces.get(dept);
    if (!w) workspaces.set(dept, (w = new Workspace(join(folderRoot, dept), { limits: { fileBytes: PDF_MAX_BYTES, totalBytes: 4 * LIMITS.totalBytes, files: 1000 } })));
    return w;
  };

  const docCreate: ToolPlugin<In> = {
    name: 'doc_create',
    description: DESCRIPTION,
    kind: 'write', // RF21: approvalFor applies to every kind; money, tax and offer kinds add the always-ask rule below
    inputSchema: Input,
    summary: (i) => ({ target: `document ${i.kind}`, change: summaryLine(i.kind, dataOf(i)) }),
    onApprovalTask: (_i, ctx, task) => store.adopt(ctx.run, task.rootId), // diagrams drawn before the conversation had a task follow the approval into it
    async precheck(input, ctx) {
      const refuse = (text: string) => ({ refuse: text });
      const kind = input.kind;
      const info = KIND_INFO[kind];
      const why = kindRefusal(kind, ctx);
      if (why) return refuse(why);
      if (needsProfile(kind) && !deps.cfg.get('company.profile')) return refuse(`doc_create: ${kind} needs the company profile (name, address, tax ID); the Founder sets it with /settings set company.profile`);
      if (TAX_ID_KINDS.has(kind) && !deps.cfg.get('company.profile')?.taxId) return refuse(`doc_create: ${kind} needs the company tax ID in company.profile; it is not set yet`);
      // RF21: HR, money and tax files post only in the owning department's own room or task thread (never in another department's channel, for example after a cross-department reply)
      if (info.restrictedAudience) {
        const dept = deptOf(ctx);
        const room = ctx.source.channelId ? deps.org?.deptOfChannel(ctx.source.channelId) ?? null : null;
        if (!dept || !room || room !== dept) return refuse(`doc_create: a ${kind} is posted only in the ${dept ?? 'owning'} department's own room or task thread; ask for it there`);
      }
      const scope = store.scopeOf(ctx);
      for (const id of diagramIdsOf(kind, dataOf(input))) if (!store.get(scope, id)) return refuse(`doc_create: diagram ${id} was not made in this task; make it first with diagram_create`);
      let facts: ReturnType<typeof cardFacts>;
      try {
        facts = cardFacts(kind, dataOf(input));
      } catch (e) {
        return refuse(`doc_create: ${e instanceof MoneyError ? e.message : 'the amounts are invalid'}`);
      }
      void facts;
      return { summary: { target: `document ${kind}`, change: summaryLine(kind, dataOf(input)) } };
    },
    // RF21: money, tax and HR-offer kinds ALWAYS ask, whatever `direct` says; the registry adds the central write rule for the other kinds.
    requiresApproval(input) {
      if (!isDraftKind(input.kind)) return false;
      let facts = '';
      try { facts = summaryLine(input.kind, dataOf(input)); } catch { /* the precheck already refused invalid amounts */ }
      return { reason: redactText(`doc_create ${input.kind}: a DRAFT financial or HR document always needs approval. ${facts}`).slice(0, 500) };
    },
    async run(input, ctx) {
      const kind = input.kind;
      const info = KIND_INFO[kind];
      if ((created.get(ctx.run) ?? 0) >= RUN_CAP) return toolError(`doc_create: at most ${RUN_CAP} documents per run`);
      const parsed = KIND_SCHEMAS[kind].safeParse(parseDataText(input.data));
      if (!parsed.success) return toolError('doc_create: the data is not valid');
      const dept = deptOf(ctx);
      if (!dept) return toolError('doc_create: the department could not be determined');
      const profile: CompanyProfile | null = deps.cfg.get('company.profile');
      if (needsProfile(kind) && !profile) return toolError('doc_create: the company profile is not set');
      if (TAX_ID_KINDS.has(kind) && !profile?.taxId) return toolError('doc_create: the company tax ID is not set');
      // global rule 9: the taint of the run that asked (an approved replay inherits the task's taint, G2-04), never less than the task's own
      let tainted = ctx.tainted() || ctx.task?.tainted === true;
      const now = deps.clock();
      const ref = draftRef();
      // RF27: ids resolve only inside this task tree; the PNGs are the ones the code stored when diagram_create made them
      const scope = store.scopeOf(ctx);
      const diagrams = new Map<string, Buffer>();
      for (const id of diagramIdsOf(kind, parsed.data as DocData[DocKind])) {
        const e = store.get(scope, id);
        if (!e) return toolError(`doc_create: diagram ${id} was not made in this task; make it first with diagram_create`);
        diagrams.set(id, e.png);
        if (e.tainted) tainted = true; // G2RF4-02: a diagram drawn by a tainted run taints the document that embeds it
      }
      let built: ReturnType<typeof buildDocument>;
      try {
        built = buildDocument(kind, parsed.data as DocData[DocKind], { ref, generated: isoDate(now), profile, diagrams });
      } catch (e) {
        if (e instanceof MoneyError) return toolError(`doc_create: ${e.message}`);
        if (e instanceof FontError) return toolError('doc_create: the document fonts failed their integrity check; nothing was rendered');
        return toolError('doc_create: the document could not be built');
      }
      created.set(ctx.run, (created.get(ctx.run) ?? 0) + 1);
      let out: { pdf: Buffer; pages: number };
      try {
        out = await renderer.renderPdf(built.html);
      } catch (e) {
        reportRender(deps, ctx, 'render', e);
        return toolError(`doc_create: ${RENDER_TEXT[e instanceof RenderError ? e.code : 'failed']}`);
      }
      // RF17/RF38: the names come from code only: kind + date + random suffix
      const stem = `${kind}-${isoDate(now).replace(/-/g, '')}-${randomBytes(3).toString('hex')}`;
      const pdfName = `${stem}.pdf`;
      const csvName = `${stem}.csv`;
      const pdfSha = sha(out.pdf);
      deps.log.info({ kind, dept, pages: out.pages, bytes: out.pdf.length, sha256: pdfSha, csv: built.csv !== null }, 'document created');

      // The department's copy, written by code, with a sidecar that carries the run's taint (global rule 9).
      let copied = false;
      const ws = workspaceOf(dept);
      if (ws) {
        try {
          await ws.write(pdfName, out.pdf, false);
          if (built.csv) await ws.write(csvName, built.csv, false);
          await ws.write(`${stem}.meta.json`, JSON.stringify({ kind, ref, dept, taskId: ctx.task?.id ?? null, tainted, draft: isDraftKind(kind), pdfSha256: pdfSha, createdAt: new Date(now).toISOString() }), false);
          copied = true;
        } catch (e) {
          deps.log.warn({ kind, why: e instanceof SandboxError ? 'sandbox' : 'io' }, 'document copy failed');
        }
      }

      // Posting: only the run's own thread / channel; the bytes are the ones made above.
      if (!ctx.source.channelId) return toolError('doc_create: there is no thread to post the document in');
      const target = { channelId: ctx.source.channelId, ...(ctx.source.threadId ? { threadId: ctx.source.threadId } : {}) };
      const draftNote = isDraftKind(kind) ? '\nDRAFT — ต้องตรวจสอบก่อนใช้ (not signed, not issued, not sent)' : '';
      const body = `📄 ${info.title}\nRef ${ref} · ${out.pages} page${out.pages === 1 ? '' : 's'}${draftNote}`;
      const where = ctx.source.threadId ?? ctx.source.channelId;
      try {
        const id = await deps.port.postFile(ctx.actor, target, { type: 'chat', body }, { name: pdfName, data: out.pdf, contentType: 'application/pdf' });
        await deps.provenance?.record(id, where, tainted, ctx.source.userId).catch(() => undefined);
        if (built.csv) {
          const id2 = await deps.port.postFile(ctx.actor, target, { type: 'chat', body: `Table data of ${ref} (CSV)` }, { name: csvName, data: Buffer.from(built.csv, 'utf8'), contentType: 'text/csv; charset=utf-8' });
          await deps.provenance?.record(id2, where, tainted, ctx.source.userId).catch(() => undefined);
        }
      } catch {
        return toolError(`doc_create: the document was made${copied ? ` and saved in the ${dept} document folder` : ''} but could not be posted here (the bot may lack Attach Files in this channel)`);
      }
      const facts = built.totals && info.money ? cardFacts(kind, parsed.data as DocData[DocKind]).money : '';
      return {
        content: `Created ${info.title.split(' (')[0]} ${ref}: ${out.pages} page(s), posted in this thread as ${pdfName}${built.csv ? ` with ${csvName}` : ''}.${copied ? ` A copy is kept in the ${dept} document folder.` : ''}` +
          `${facts ? ` Computed by code: ${facts}.` : ''}${isDraftKind(kind) ? ' It is a DRAFT: unsigned, no legal number, not sent to anyone.' : ''}`,
      };
    },
  };
  const diagramCreate: ToolPlugin<DiagramIn> = {
    name: 'diagram_create',
    description: DIAGRAM_DESCRIPTION,
    kind: 'write', // RF27: no approval only through NO_APPROVAL_TOOLS (tools/policy-approval.ts); the output goes only to this run's thread or channel
    inputSchema: DiagramInput,
    summary: (i) => ({ target: `diagram ${i.type}`, change: cleanCardText(i.title, 80) }),
    requiresApproval: () => false,
    async precheck(input) {
      const c = checkDiagramSource(input.type, input.source);
      return c.ok ? { summary: { target: `diagram ${input.type}`, change: cleanCardText(input.title, 80) } } : { refuse: `diagram_create: ${c.why}` };
    },
    async run(input, ctx) {
      if ((diagramsMade.get(ctx.run) ?? 0) >= DIAGRAM_RUN_CAP) return toolError(`diagram_create: at most ${DIAGRAM_RUN_CAP} diagrams per run`);
      const c = checkDiagramSource(input.type, input.source);
      if (!c.ok) return toolError(`diagram_create: ${c.why}`);
      if (!ctx.source.channelId) return toolError('diagram_create: there is no thread to post the diagram in');
      if (!renderer.renderDiagram) return toolError('diagram_create: the renderer cannot draw diagrams');
      let page: ReturnType<typeof buildDiagramPage>;
      try {
        page = buildDiagramPage();
      } catch (e) {
        deps.log.warn({ why: e instanceof MermaidError ? e.message : 'build' }, 'diagram page refused');
        return toolError('diagram_create: the diagram library failed its integrity check; nothing was drawn');
      }
      diagramsMade.set(ctx.run, (diagramsMade.get(ctx.run) ?? 0) + 1);
      let out: { png: Buffer; width: number; height: number };
      try {
        out = await renderer.renderDiagram({ html: page.html, config: MERMAID_CONFIG }, breakThaiLabels(input.type, c.source));
      } catch (e) {
        const code = e instanceof RenderError ? e.code : 'failed';
        reportRender(deps, ctx, 'render diagram', e);
        // a syntax error text comes from the library about the model's own text; it is redacted and cut before the model sees it
        return toolError(`diagram_create: ${code === 'bad_source' && e instanceof Error ? redactText(e.message).slice(0, 280) : RENDER_TEXT[code]}`);
      }
      const id = newDiagramId();
      const tainted = ctx.tainted() || ctx.task?.tainted === true;
      const title = cleanTitle(input.title);
      const png = out.png;
      store.put(store.scopeOf(ctx), id, { png, title, dept: deptOf(ctx) ?? '', tainted });
      deps.log.info({ type: input.type, bytes: png.length, sha256: sha(png), mermaid: page.sha256.slice(0, 12), redacted: c.redacted }, 'diagram created');
      const target = { channelId: ctx.source.channelId, ...(ctx.source.threadId ? { threadId: ctx.source.threadId } : {}) };
      const name = `diagram-${id}.png`;
      try {
        const mid = await deps.port.postFile(ctx.actor, target, { type: 'chat', body: `🖼️ ${title}
Diagram ${id} (${input.type})` }, { name, data: png, contentType: 'image/png' });
        await deps.provenance?.record(mid, ctx.source.threadId ?? ctx.source.channelId, tainted, ctx.source.userId).catch(() => undefined);
      } catch {
        return toolError('diagram_create: the diagram was drawn but could not be posted here (the bot may lack Attach Files in this channel)');
      }
      return { content: `Created diagram ${id} (${input.type}): posted in this thread as ${name}. To put it in a plan or slide deck of this task, use diagramId "${id}" in doc_create.${c.redacted ? ' Secret-looking text in the source was masked.' : ''}` };
    },
  };
  return { id: 'docs', tools: [docCreate, ...(renderer.renderDiagram ? [diagramCreate] : [])] as ToolPlugin<any>[] };
};

export { DATA_MAX_BYTES };
