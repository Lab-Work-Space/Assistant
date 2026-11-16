import { z } from 'zod';
import type { ActorRef } from '../company/types.js';
import type { Org } from '../company/org.js';
import type { ConfigStore } from '../config/store.js';
import { AI_ACTOR, type SkillProposal, type SkillRepo, type SkillTx } from '../db/repos/skills.js';
import type { RetroRepo } from '../db/repos/grow.js';
import type { AuditFn } from '../governance/audit.js';
import { actorKey } from '../governance/budget.js';
import type { Classifier } from '../knowledge/classifier.js';
import { screenText } from '../knowledge/screen.js';
import type { GrantEnv } from '../tools/skill-grant.js';
import { affectedActors, applyChange, checkCaps, targetsOf, toolDelta } from './caps.js';
import {
  OPEN_PROPOSALS_PER_DEPT, PRIORITY_DEFAULT, PRIORITY_MAX, PROPOSAL_ATTEMPTS_PER_HOUR, PROPOSAL_REASON_MAX, SKILLS_IN_LIBRARY_MAX, SKILL_ID_RE, SKILL_INSTRUCTIONS_MAX,
  SKILL_TEMPLATES_MAX, SKILL_TEMPLATE_BODY_MAX, SKILL_TEMPLATE_NAME_MAX, SKILL_TITLE_MAX, TARGET_ID_RE,
} from './limits.js';
import { renderBlock, sectionBytes, type SkillBody, type SkillTemplate } from './render.js';
import { selectSkills } from './select.js';
import type { AttachmentRow, SkillRow, SkillSnapshot, SkillStatus, SkillTarget, TargetKind } from './types.js';
import { refusalText, validateDraft, type Draft, type Refusal } from './validate.js';

/** The `skill_propose` input. `.strict()` and NO `tools` field: a head can never propose a tool (SK13). */
export const SkillProposeInput = z.object({
  op: z.enum(['create', 'edit']),
  skill: z.string().min(2).max(40),
  title: z.string().trim().min(1).max(SKILL_TITLE_MAX).optional(),
  instructions: z.string().trim().min(10).max(SKILL_INSTRUCTIONS_MAX),
  templates: z.array(z.object({ name: z.string().trim().min(1).max(SKILL_TEMPLATE_NAME_MAX), body: z.string().trim().min(1).max(SKILL_TEMPLATE_BODY_MAX) }).strict()).max(SKILL_TEMPLATES_MAX).optional(),
  target: z.string().min(1).max(64).optional(),
  reason: z.string().trim().min(1).max(PROPOSAL_REASON_MAX),
}).strict();
export type SkillProposeInput = z.infer<typeof SkillProposeInput>;

export interface RunFacts { tainted: boolean; task: { id: string; tainted: boolean } | null }
export type Proposed = { ok: true; id: number; text: string } | { ok: false; code: string; error: string };

/** A lost race or a refused check inside a skill write; carries a fixed code only. The console maps it to a refused card, a slash handler to a reply. */
export class SkillRefused extends Error {
  constructor(readonly code: string, readonly detail?: string) {
    super(`skill write refused: ${code}`);
    this.name = 'SkillRefused';
  }
}

export type SkillOp =
  | { op: 'create'; id: string; draft: Draft; attach?: { kind: TargetKind; id: string; priority?: number }; seed?: { ownerDept: string } }
  | { op: 'edit'; id: string; base: number; draft: { title: string; instructions: string; templates: SkillTemplate[] } }
  | { op: 'tools'; id: string; base: number; action: 'add' | 'remove'; tool: string }
  | { op: 'attach'; id: string; base: number; kind: TargetKind; target: string; priority?: number }
  | { op: 'detach'; id: string; kind: TargetKind; target: string }
  | { op: 'status'; id: string; base: number; from: SkillStatus; to: 'active' | 'disabled' }
  | { op: 'rollback'; id: string; base: number; to: number };

export type OpResult =
  | { ok: true; id: string; version: number; bytes?: number; added: { key: string; dept: string; added: string[] }[]; risk: boolean; detail: string[] }
  | Refusal;

export interface SkillDeps {
  repo: SkillRepo;
  org: Pick<Org, 'dept' | 'persona' | 'personasOf' | 'reload'>;
  classify: Classifier;
  audit: AuditFn;
  secrets: readonly string[];
  grant: GrantEnv;
  cfg: Pick<ConfigStore, 'get'>;
  /** Posts the fixed #⚙️-setting notice (code text only). Absent in tests that do not need it. */
  notify?: (text: string) => Promise<void>;
  /** GROW-1: the one-skill-per-retro claim. Absent = no retro limit (every run is a non-retro run). */
  retro?: Pick<RetroRepo, 'claimSkill' | 'releaseSkill' | 'setSkillProposal'>;
  log?: { error(o: unknown, m?: string): void };
  now?: () => number;
}

const fail = (code: string, detail?: string): Refusal => ({ ok: false, code, ...(detail ? { detail } : {}) });
const same = <T>(a: readonly T[], b: readonly T[]): boolean => a.length === b.length && a.every((x, i) => x === b[i]);
const sameTemplates = (a: readonly SkillTemplate[], b: readonly SkillTemplate[]): boolean => a.length === b.length && a.every((t, i) => t.name === b[i]!.name && t.body === b[i]!.body);
const HOUR = 3_600_000;
/** GW-C10 (LL-C11): version sources written by a person. An AI edit never builds on these: it goes to a Bot Admin. `seed` is deliberately absent: a seed is reviewed team text released through the gates, so retros may edit it; `/skill rollback` writes `rollback`, which restores escalation. */
export const HUMAN_SOURCES: readonly string[] = ['admin', 'rollback'];

export type ApplyMode = { kind: 'card'; cardId: string; adminId: string } | { kind: 'ai' };
/** Runs inside the apply transaction after every check and write; a non-null code refuses (rolls back, the proposal stays open). */
export type BeforeCommit = (t: SkillTx, p: SkillProposal) => Promise<string | null>;
export type ApplyResult =
  | { ok: true; lines: string[]; version: number; skillId: string; deptId: string; kind: 'create' | 'edit' }
  | { ok: false; code: string; why: string; gone: boolean };
export type ApplyAiResult = ApplyResult;
/** The fixed #setting notice text of a waiting proposal (code text and validated ids only). */
export const proposalNotice = (p: { id: number; deptId: string; kind: string; skillId: string }): string => `Skill proposal #${p.id} from ${p.deptId} head: ${p.kind} ${p.skillId}. Review: /skill review ${p.id}`;
/** The AI judge as the service sees it (set after construction: the service is built before the approver, app.ts). */
export interface SkillJudgeHook { offer(proposalId: number): void }

export class SkillService {
  /** SK12: in-memory sliding window of `skill_propose` attempts per department (a restart resets it; the actor budget still bounds spend). */
  private readonly attempts = new Map<string, number[]>();

  constructor(private readonly d: SkillDeps) {}

  get repo(): SkillRepo { return this.d.repo; }

  private async rec(actor: string, action: string, tool: string, outcome: string): Promise<void> {
    await this.d.audit({ actor, action, tool, outcome }); // ids, versions and codes only (SK15)
  }

  private snapshotRow(row: SkillRow, v: SkillBody, tools: string[], bytes: number, sha: string): SkillRow {
    return { ...row, title: v.title, activeVersion: v.version, instructions: v.instructions, templates: v.templates, tools, bodyBytes: bytes, bodySha256: sha };
  }

  // ---- admin writes (every one is a single transaction with SQL compare-and-swap; SK9) ----

  /** The checks and writes of one admin op. The caller decides COMMIT or ROLLBACK (a dry run is the same code, rolled back). */
  private async exec(t: SkillTx, op: SkillOp, by: string): Promise<OpResult> {
    const before = await t.snapshot();
    const personas = await t.personas();
    const finish = async (after: SkillSnapshot, targets: SkillTarget[], version: number, bytes: number | undefined, detail: string[]): Promise<OpResult> => {
      const cap = checkCaps(after, personas, targets);
      if (cap) throw new SkillRefused(cap.code, cap.detail);
      const added = toolDelta(before, after, personas, targets);
      const risk = added.some((a) => a.added.some((x) => !(this.d.cfg.get('tools.byDept')[a.dept] ?? []).includes(x)));
      return { ok: true, id: op.id, version, ...(bytes !== undefined ? { bytes } : {}), added, risk, detail };
    };
    const refuse = (r: Refusal): never => { throw new SkillRefused(r.code, r.detail); };
    const targetOk = (kind: TargetKind, id: string): boolean => kind === 'dept' ? !!this.d.org.dept(id) : personas.some((p) => p.id === id);

    if (op.op === 'create') {
      if (op.seed && (!op.attach || op.attach.kind !== 'dept' || op.attach.id !== op.seed.ownerDept)) return fail('bad_seed');
      if (op.seed?.ownerDept === 'praw') return fail('unknown_target'); // praw is not a skill team (spec D4b)
      if ((await t.skillCount()) >= SKILLS_IN_LIBRARY_MAX) return fail('library_full');
      const v = validateDraft(op.draft, { id: op.id, version: 1, secrets: this.d.secrets, grant: this.d.grant });
      if (!v.ok) return v;
      if (op.attach && (!TARGET_ID_RE.test(op.attach.id) || !targetOk(op.attach.kind, op.attach.id))) return fail('unknown_target');
      if (!(await t.insertSkill({ id: op.id, title: v.body.title, ownerDept: op.seed?.ownerDept ?? null, createdBy: by }))) return fail('skill_exists');
      const tools = op.draft.tools ?? [];
      await t.insertVersion({ body: v.body, tools, bytes: v.bytes, sha256: v.sha256, source: op.seed ? 'seed' : 'admin', by });
      const row: SkillRow = { id: op.id, title: v.body.title, status: 'active', activeVersion: 1, ownerDept: op.seed?.ownerDept ?? null, instructions: v.body.instructions, templates: v.body.templates, tools, bodyBytes: v.bytes, bodySha256: v.sha256 };
      let after = applyChange(before, { skill: row });
      const targets: SkillTarget[] = [];
      if (op.attach) {
        const att: AttachmentRow = { skillId: op.id, targetKind: op.attach.kind, targetId: op.attach.id, priority: op.attach.priority ?? PRIORITY_DEFAULT };
        await t.insertAttachment({ skillId: op.id, kind: att.targetKind, target: att.targetId, priority: att.priority, by });
        after = applyChange(after, { addAttachment: att });
        targets.push({ kind: att.targetKind, id: att.targetId });
      }
      return finish(after, targets, 1, v.bytes, [`created v1 (${v.bytes} bytes)`]);
    }

    const cur = await t.lockSkill(op.id);
    if (!cur) return fail('unknown_skill');

    if (op.op === 'detach') {
      if (!(await t.deleteAttachment(op.id, op.kind, op.target))) return fail('stale');
      const after = applyChange(before, { removeAttachment: { skillId: op.id, targetKind: op.kind, targetId: op.target } });
      return finish(after, [{ kind: op.kind, id: op.target }], cur.activeVersion, undefined, [`detached from ${op.kind}:${op.target}`]);
    }

    if (cur.activeVersion !== op.base) return fail('stale');
    if (cur.status === 'archived') return fail('archived');
    const attached = before.attachments.filter((a) => a.skillId === op.id);
    const touched = targetsOf(attached);

    if (op.op === 'attach') {
      if (!TARGET_ID_RE.test(op.target) || !targetOk(op.kind, op.target)) return fail('unknown_target');
      // rule G is recomputed at attach: a stored tool that no longer passes refuses (never stripped silently)
      const g = validateDraft({ title: cur.title, instructions: cur.instructions, templates: cur.templates, tools: cur.tools }, { id: cur.id, version: cur.activeVersion, secrets: this.d.secrets, grant: this.d.grant });
      if (!g.ok) return g;
      const att: AttachmentRow = { skillId: op.id, targetKind: op.kind, targetId: op.target, priority: op.priority ?? PRIORITY_DEFAULT };
      if (!(await t.insertAttachment({ skillId: op.id, kind: op.kind, target: op.target, priority: att.priority, by }))) return fail('already_attached');
      return finish(applyChange(before, { addAttachment: att }), [{ kind: op.kind, id: op.target }], cur.activeVersion, undefined, [`attached to ${op.kind}:${op.target} priority ${att.priority}`]);
    }

    if (op.op === 'status') {
      if (cur.status !== op.from) return fail('stale');
      if (cur.status === op.to) return fail('nothing_to_do');
      if (op.to === 'active') {
        const g = validateDraft({ title: cur.title, instructions: cur.instructions, templates: cur.templates, tools: cur.tools }, { id: cur.id, version: cur.activeVersion, secrets: this.d.secrets, grant: this.d.grant });
        if (!g.ok) return g;
      }
      if (!(await t.setStatus(op.id, op.from, op.base, op.to))) return fail('stale');
      return finish(applyChange(before, { skill: { ...cur, status: op.to } }), touched, cur.activeVersion, undefined, [`status ${op.from} -> ${op.to}`]);
    }

    // edit, tools, rollback: a new immutable version
    let draft: Draft;
    let source: 'admin' | 'rollback' = 'admin';
    let restoredFrom: number | undefined;
    if (op.op === 'edit') {
      if (op.draft.title === cur.title && op.draft.instructions === cur.instructions && sameTemplates(op.draft.templates, cur.templates)) return fail('no_change');
      draft = { ...op.draft, tools: cur.tools };
    } else if (op.op === 'tools') {
      const has = cur.tools.includes(op.tool);
      if ((op.action === 'add') === has) return fail('nothing_to_do');
      draft = { title: cur.title, instructions: cur.instructions, templates: cur.templates, tools: op.action === 'add' ? [...cur.tools, op.tool] : cur.tools.filter((x) => x !== op.tool) };
    } else {
      if (op.to === cur.activeVersion) return fail('nothing_to_do');
      const old = await t.versionRow(op.id, op.to);
      if (!old) return fail('unknown_version');
      draft = { title: cur.title, instructions: old.instructions, templates: old.templates, tools: old.tools };
      source = 'rollback';
      restoredFrom = op.to;
    }
    const next = cur.activeVersion + 1;
    const v = validateDraft(draft, { id: cur.id, version: next, secrets: this.d.secrets, grant: this.d.grant });
    if (!v.ok) return v; // includes tool_not_allowed: a rollback or edit never strips a tool silently
    await t.insertVersion({ body: v.body, tools: draft.tools ?? [], bytes: v.bytes, sha256: v.sha256, source, ...(restoredFrom !== undefined ? { restoredFrom } : {}), by });
    if (!(await t.setActive(op.id, op.base, next, v.body.title))) throw new SkillRefused('stale'); // after the insert: roll the transaction back
    const row = this.snapshotRow(cur, v.body, draft.tools ?? [], v.bytes, v.sha256);
    return finish(applyChange(before, { skill: row }), touched, next, v.bytes, [`new version v${next} (${v.bytes} bytes)${restoredFrom !== undefined ? `, restored from v${restoredFrom}` : ''}`]);
  }

  /** Dry run: the same checks and the resulting delta, nothing written (always rolled back). */
  async preview(op: SkillOp, by: string): Promise<OpResult> {
    try {
      return await this.d.repo.tx((t) => this.exec(t, op, by), { commit: false });
    } catch (e) {
      if (e instanceof SkillRefused) return fail(e.code, e.detail);
      throw e;
    }
  }

  /** Runs the op for real. A refused or lost check throws SkillRefused and writes nothing. Reloads the org cache and audits after the commit. */
  async run(op: SkillOp, by: string): Promise<Extract<OpResult, { ok: true }>> {
    let out: OpResult;
    try {
      out = await this.d.repo.tx((t) => this.exec(t, op, by));
    } catch (e) {
      if (e instanceof SkillRefused) await this.rec(by, `skill.${auditName(op)}`, op.id, `refused:${e.code}`);
      throw e;
    }
    if (!out.ok) {
      await this.rec(by, `skill.${auditName(op)}`, op.id, `refused:${out.code}`);
      throw new SkillRefused(out.code, out.detail);
    }
    await this.reloadQuietly();
    await this.rec(by, `skill.${auditName(op)}`, op.id, `ok v${out.version}${op.op === 'tools' ? ` ${op.tool.replace(/[^a-z0-9_]/g, '').slice(0, 64)}` : ''}`);
    return out;
  }

  private async reloadQuietly(): Promise<void> {
    try { await this.d.org.reload(); } catch (err) { this.d.log?.error({ err: err instanceof Error ? err.message.slice(0, 120) : 'error' }, 'org reload after a skill write failed'); }
  }

  // ---- head proposals ----

  private overCap(dept: string): boolean {
    const now = (this.d.now ?? Date.now)();
    const recent = (this.attempts.get(dept) ?? []).filter((x) => now - x < HOUR);
    const over = recent.length >= PROPOSAL_ATTEMPTS_PER_HOUR;
    recent.push(now); // refusals count too
    this.attempts.set(dept, recent.slice(-PROPOSAL_ATTEMPTS_PER_HOUR * 2));
    return over;
  }

  private async refuseProp(who: string, r: Refusal): Promise<Proposed> {
    await this.rec(who, 'skill.propose', 'skill_propose', `refused:${r.code}`);
    return { ok: false, code: r.code, error: refusalText(r) };
  }

  /**
   * `skill_propose`. Heads only (never Praw, never a persona), never from a tainted run (K3 parity with proposePrompt), only for the head's own department and its
   * members. The proposal row is the only effect: nothing reaches a prompt before a Bot Admin reads the full text on a card and confirms (SK3, S3).
   */
  async propose(actor: ActorRef, run: RunFacts, input: SkillProposeInput, classify: Classifier = this.d.classify): Promise<Proposed> {
    const who = actorKey(actor);
    if (actor.kind !== 'head' || actor.dept === 'praw') return this.refuseProp(who, fail('not_head')); // Praw's "*" reaches this tool: admin-authored skills only
    const dept: string = actor.dept;
    if (run.tainted || run.task?.tainted) return this.refuseProp(who, fail('tainted'));
    if (this.overCap(dept)) return this.refuseProp(who, fail('attempt_cap')); // before any screen, lint or classifier call (SK12)
    const id = input.skill.trim();
    if (!SKILL_ID_RE.test(id)) return this.refuseProp(who, fail('bad_id'));
    // G2SK-07: the reason is screened too (secret-shaped text, control characters); it only ever shows on the card, but nothing unscreened is stored.
    const screenedReason = screenText(input.reason.replace(/\s+/g, ' ').trim(), { max: PROPOSAL_REASON_MAX, secrets: this.d.secrets, pii: false, multiline: false });
    if (!screenedReason.ok) return this.refuseProp(who, fail('screen', 'reason'));
    const reason = screenedReason.text;
    if ((await this.d.repo.countOpen(dept)) >= OPEN_PROPOSALS_PER_DEPT) return this.refuseProp(who, fail('open_cap'));
    if (await this.d.repo.pendingFor(id)) return this.refuseProp(who, fail('pending_exists'));

    const existing = await this.d.repo.get(id);
    let target: { kind: TargetKind; id: string } | undefined;
    let prevBlock = '';
    let base = 0;
    let draft: Draft;
    let tools: string[] = [];
    if (input.op === 'create') {
      if (existing) return this.refuseProp(who, fail('skill_exists'));
      if (!input.title) return this.refuseProp(who, fail('invalid', 'title'));
      if (!input.target || input.target === 'dept') target = { kind: 'dept', id: dept };
      else {
        const p = TARGET_ID_RE.test(input.target) ? this.d.org.persona(input.target) : null;
        if (!p || p.deptId !== dept || !p.enabled) return this.refuseProp(who, fail('bad_target'));
        target = { kind: 'persona', id: p.id };
      }
      draft = { title: input.title, instructions: input.instructions, templates: input.templates ?? [] };
    } else {
      if (!existing) return this.refuseProp(who, fail('unknown_skill'));
      if (existing.status === 'archived') return this.refuseProp(who, fail('archived'));
      if (existing.ownerDept !== dept) return this.refuseProp(who, fail('not_owner')); // NULL owner fails too
      const atts = await this.d.repo.attachmentsOf(id);
      const outside = atts.some((a) => !(a.targetKind === 'dept' ? a.targetId === dept : this.d.org.persona(a.targetId)?.deptId === dept));
      if (outside) return this.refuseProp(who, fail('attached_outside_dept'));
      base = existing.activeVersion;
      tools = existing.tools;
      prevBlock = renderBlock({ id, version: base, title: existing.title, instructions: existing.instructions, templates: existing.templates });
      draft = { title: input.title ?? existing.title, instructions: input.instructions, templates: input.templates ?? existing.templates };
      if (draft.title === existing.title && draft.instructions === existing.instructions && sameTemplates(draft.templates, existing.templates)) return this.refuseProp(who, fail('no_change'));
    }
    const v = validateDraft(draft, { id, version: base + 1, secrets: this.d.secrets });
    if (!v.ok) return this.refuseProp(who, v);
    // budget and caps as they would be after the change (a proposal that can never apply is refused now)
    const capFail = await this.capsPreview(id, v.body, tools, target, existing);
    if (capFail) return this.refuseProp(who, capFail);
    const verdict = await classify({ ref: `skills/${id}`, prev: prevBlock, next: v.block, actor });
    if (!verdict.allow) return this.refuseProp(who, verdict.code === 'unavailable' || verdict.code === 'timeout' ? fail('unavailable') : fail(`classifier:${verdict.code}`));
    // GROW-1: a retro run proposes at most one skill. The claim is one conditional UPDATE keyed on the task id, so a non-retro run on a retro task stays capped by the same row;
    // it is given back when the proposal is refused or the write throws (try/finally), and keeps the proposal id when it works.
    const task = run.task;
    let slot: 'claimed' | 'used' | 'not_retro' = 'not_retro';
    if (task && this.d.retro) {
      try {
        slot = await this.d.retro.claimSkill(task.id);
      } catch (err) {
        this.d.log?.error({ errName: err instanceof Error ? err.name : 'unknown' }, 'retro skill claim failed');
        return this.refuseProp(who, fail('unavailable'));
      }
      if (slot === 'used') return this.refuseProp(who, fail('retro_skill_used'));
    }
    let row: Awaited<ReturnType<SkillRepo['createProposal']>> | undefined;
    try {
      row = await this.d.repo.createProposal({
        deptId: dept, kind: input.op, skillId: id, baseVersion: base, ...(target ? { target } : {}),
        payload: { title: v.body.title, instructions: v.body.instructions, templates: v.body.templates, tools, reason }, verdict: { lint: 'ok', classifier: 'allow' }, proposer: `heads/${dept}`,
      });
    } finally {
      if (slot === 'claimed' && task && this.d.retro) {
        await (row?.ok === true ? this.d.retro.setSkillProposal(task.id, row.id) : this.d.retro.releaseSkill(task.id)).catch((err: unknown) => this.d.log?.error({ errName: err instanceof Error ? err.name : 'unknown' }, 'retro skill claim update failed'));
      }
    }
    if (!row.ok) return this.refuseProp(who, fail('pending_exists'));
    await this.rec(who, 'skill.propose', 'skill_propose', `proposal:${row.id} skill:${id} op:${input.op}`);
    // GROW-1 (C5, GW-C13): with the AI review on, the judge goes first and the human notice is posted by it, after an escalation. The reply never claims success.
    if (this.judge && this.aiOn()) {
      try { this.judge.offer(row.id); } catch (err) { this.d.log?.error({ errName: err instanceof Error ? err.name : 'unknown' }, 'skill judge offer failed'); await this.notifyHuman(row.id, dept, input.op, id); }
      return { ok: true, id: row.id, text: `Proposal #${row.id} saved. An AI reviewer checks it first; if it does not approve, a Bot Admin reviews it. NOTHING has changed yet. Do not say it is done.` };
    }
    await this.notifyHuman(row.id, dept, input.op, id);
    return { ok: true, id: row.id, text: `Proposal #${row.id} saved. NOTHING has changed: a Bot Admin must review and confirm it. Do not say it is done.` };
  }

  private judge: SkillJudgeHook | undefined;
  setJudge(j: SkillJudgeHook): void { this.judge = j; }
  /** `skills.ai.enabled` is on; a read error counts as off. */
  private aiOn(): boolean {
    try { return this.d.cfg.get('skills.ai.enabled') === true; } catch { return false; }
  }
  private async notifyHuman(id: number, dept: string, op: string, skill: string): Promise<void> {
    await this.d.notify?.(proposalNotice({ id, deptId: dept, kind: op, skillId: skill })).catch((err: unknown) => this.d.log?.error({ err: err instanceof Error ? err.message.slice(0, 120) : 'error' }, 'skill proposal notice failed'));
  }

  /** Budget and caps on the snapshot after a proposal would apply (read-only). */
  private async capsPreview(id: string, body: SkillBody, tools: string[], target: { kind: TargetKind; id: string } | undefined, existing: SkillRow | null): Promise<Refusal | null> {
    return this.d.repo.tx(async (t) => {
      const before = await t.snapshot();
      const personas = await t.personas();
      const row: SkillRow = { id, title: body.title, status: 'active', activeVersion: body.version, ownerDept: existing?.ownerDept ?? null, instructions: body.instructions, templates: body.templates, tools, bodyBytes: 0, bodySha256: '' };
      let after = applyChange(before, { skill: row });
      let targets = targetsOf(before.attachments.filter((a) => a.skillId === id));
      if (target) {
        after = applyChange(after, { addAttachment: { skillId: id, targetKind: target.kind, targetId: target.id, priority: PRIORITY_DEFAULT } });
        targets = [target];
      }
      return checkCaps(after, personas, targets);
    }, { commit: false });
  }

  // ---- review and apply of a proposal ----

  /** For the card: the stored proposal re-screened and re-linted (SK7 mint), with the state it would apply to. Refuses with a code, never with text. */
  async review(proposalId: number): Promise<
    | { ok: true; proposal: SkillProposal; body: SkillBody; block: string; bytes: number; sha256: string; current: SkillRow | null; attachments: AttachmentRow[]; budget: { key: string; bytes: number }[] }
    | Refusal
  > {
    const p = await this.d.repo.getProposal(proposalId);
    if (!p || p.status !== 'open') return fail('not_found');
    const version = p.kind === 'create' ? 1 : p.baseVersion + 1;
    const v = validateDraft({ title: p.payload.title, instructions: p.payload.instructions, templates: p.payload.templates }, { id: p.skillId, version, secrets: this.d.secrets });
    if (!v.ok) return v;
    const current = await this.d.repo.get(p.skillId);
    if (p.kind === 'edit' && (!current || current.activeVersion !== p.baseVersion)) return fail('stale');
    const target = p.kind === 'create' && p.targetKind && p.targetId ? { kind: p.targetKind, id: p.targetId } : undefined;
    const capFail = await this.capsPreview(p.skillId, v.body, p.payload.tools, target, current);
    if (capFail) return capFail;
    const info = await this.d.repo.tx(async (t) => {
      const before = await t.snapshot();
      const personas = await t.personas();
      const row: SkillRow = { id: p.skillId, title: v.body.title, status: 'active', activeVersion: version, ownerDept: p.deptId, instructions: v.body.instructions, templates: v.body.templates, tools: p.payload.tools, bodyBytes: v.bytes, bodySha256: v.sha256 };
      let after = applyChange(before, { skill: row });
      let targets = targetsOf(before.attachments.filter((a) => a.skillId === p.skillId));
      if (target) { after = applyChange(after, { addAttachment: { skillId: p.skillId, targetKind: target.kind, targetId: target.id, priority: PRIORITY_DEFAULT } }); targets = [target]; }
      return { attachments: before.attachments.filter((a) => a.skillId === p.skillId), budget: affectedActors(personas, targets).map((a) => ({ key: a.key, bytes: sectionBytes(selectSkills(after, { dept: a.dept, ...(a.personaId ? { personaId: a.personaId } : {}) })) })) };
    }, { commit: false });
    return { ok: true, proposal: p, body: v.body, block: v.block, bytes: v.bytes, sha256: v.sha256, current, attachments: info.attachments, budget: info.budget };
  }

  /**
   * SK6: applies a confirmed proposal in one transaction under the write lock. Order of refusals: a proposal not bound to THIS card is left alone; every check
   * (a) to (g) runs before any write; a changed base, owner, attachment, target or hash closes the proposal `stale`; a budget or cap refusal reopens it.
   * The signature and behaviour are unchanged (GW-C7); the body is `applyCore` in card mode.
   */
  async applyProposal(cardId: string, proposalId: number, adminId: string, expectSha: string): Promise<{ ok: true; lines: string[]; version: number } | { ok: false; code: string; why: string }> {
    const r = await this.applyCore(proposalId, { kind: 'card', cardId, adminId }, expectSha);
    return r.ok ? { ok: true, lines: r.lines, version: r.version } : { ok: false, code: r.code, why: r.why };
  }

  /**
   * GROW-1 (GW-C7, C8): the AI reviewer's apply. The ONLY caller is SkillJudge (a grep test pins it). `expectSha` is the hash of the same `review()` call whose text the judge saw.
   * `beforeCommit` runs on the transaction after every check and write; a non-null code rolls everything back and the proposal stays open.
   */
  async applyByAi(proposalId: number, expectSha: string, beforeCommit?: BeforeCommit): Promise<ApplyAiResult> {
    return this.applyCore(proposalId, { kind: 'ai' }, expectSha, beforeCommit);
  }

  /**
   * One apply for both modes (SA-1 C4). Card mode locks a `card` proposal bound to its card; AI mode locks an `open` one and answers `gone` for any other status.
   * In AI mode every write is `system:ai-approver`, a create with tools never applies (GW-C9), and an edit needs an active skill whose active version came from a proposal (GW-C10).
   */
  private async applyCore(proposalId: number, mode: ApplyMode, expectSha: string, beforeCommit?: BeforeCommit): Promise<ApplyResult> {
    const ai = mode.kind === 'ai';
    const closer = mode.kind === 'card' ? mode.adminId : AI_ACTOR; // reviewed_by of every row this apply closes
    const by = mode.kind === 'card' ? `user:${mode.adminId}` : AI_ACTOR; // the audit actor and the attachment writer
    const audit = ai ? 'skill.ai.apply' : 'skill.apply';
    type Out = { ok: true; lines: string[]; version: number; skillId: string; deptId: string; kind: 'create' | 'edit' } | { ok: false; code: string; stale: boolean | null };
    const out: Out = await this.d.repo.tx(async (t): Promise<Out> => {
      const p = await t.lockProposal(proposalId);
      const ours = !!p && (mode.kind === 'ai' ? p.status === 'open' : p.status === 'card' && p.cardId === mode.cardId);
      if (!p || !ours) return { ok: false, code: ai ? 'gone' : 'stale', stale: null }; // not ours to close
      const stale = async (code: string): Promise<Out> => { await t.closeProposal(p.id, 'stale', closer, `stale:${code}`); return { ok: false, code, stale: true }; };
      const reopen = async (code: string): Promise<Out> => { if (!ai) await t.reopenProposal(p.id); return { ok: false, code, stale: false }; }; // an AI apply never left `open`
      if (ai && p.kind === 'create' && p.payload.tools.length > 0) return { ok: false, code: 'tools', stale: false }; // GW-C9: no tool by construction
      const cur = await t.lockSkill(p.skillId);
      const before = await t.snapshot();
      const personas = await t.personas();
      const atts = before.attachments.filter((a) => a.skillId === p.skillId);
      // (a) the base
      if (p.kind === 'create') { if (cur) return stale('skill_exists'); } else {
        if (!cur) return stale('unknown_skill');
        if (cur.activeVersion !== p.baseVersion) return stale('stale');
        if (cur.status === 'archived') return stale('archived');
        // (c) owner
        if (cur.ownerDept !== p.deptId) return stale('not_owner');
        // (g) tools unchanged from the base version
        if (!same(cur.tools, p.payload.tools)) return stale('stale');
        if (ai) {
          // GW-C10 in the transaction: a person's disable or rollback that landed while the judge ran still wins
          if (cur.status !== 'active') return { ok: false, code: 'not_active', stale: false };
          if (HUMAN_SOURCES.includes((await t.versionRow(cur.id, cur.activeVersion))?.source ?? 'admin')) return { ok: false, code: 'human_version', stale: false };
        }
      }
      // (d) every attachment is the proposer department or a persona that is in it NOW
      for (const a of atts) {
        const ok = a.targetKind === 'dept' ? a.targetId === p.deptId : personas.find((x) => x.id === a.targetId)?.deptId === p.deptId;
        if (!ok) return stale('attached_outside_dept');
      }
      // (e) a create target still exists, is enabled and belongs to the department
      let target: SkillTarget | undefined;
      if (p.kind === 'create') {
        if (!p.targetKind || !p.targetId) return stale('bad_target');
        if (p.targetKind === 'dept') { if (p.targetId !== p.deptId || (await t.deptEnabled(p.deptId)) !== true) return stale('bad_target'); } else {
          const per = personas.find((x) => x.id === p.targetId);
          if (!per || !per.enabled || per.deptId !== p.deptId) return stale('bad_target');
        }
        target = { kind: p.targetKind, id: p.targetId };
      }
      // (b) the stored text still screens and lints, and hashes to what the admin (or the judge) saw
      const version = p.kind === 'create' ? 1 : p.baseVersion + 1;
      const v = validateDraft({ title: p.payload.title, instructions: p.payload.instructions, templates: p.payload.templates }, { id: p.skillId, version, secrets: this.d.secrets });
      if (!v.ok) return stale(v.code.startsWith('lint:') ? 'lint' : v.code);
      if (v.sha256 !== expectSha) return stale('stale');
      // (f) budget and caps on the state after the change
      const row: SkillRow = { id: p.skillId, title: v.body.title, status: 'active', activeVersion: version, ownerDept: p.deptId, instructions: v.body.instructions, templates: v.body.templates, tools: p.payload.tools, bodyBytes: v.bytes, bodySha256: v.sha256 };
      let after = applyChange(before, { skill: row });
      let targets = targetsOf(atts);
      if (target) { after = applyChange(after, { addAttachment: { skillId: p.skillId, targetKind: target.kind, targetId: target.id, priority: PRIORITY_DEFAULT } }); targets = [target]; }
      const cap = checkCaps(after, personas, targets);
      if (cap) return reopen(cap.code);
      if (p.kind === 'create') {
        if ((await t.skillCount()) >= SKILLS_IN_LIBRARY_MAX) return reopen('library_full');
        if (!(await t.insertSkill({ id: p.skillId, title: v.body.title, ownerDept: p.deptId, createdBy: p.proposer }))) return stale('skill_exists');
        await t.insertVersion({ body: v.body, tools: p.payload.tools, bytes: v.bytes, sha256: v.sha256, source: 'proposal', proposalId: p.id, by: p.proposer });
        await t.insertAttachment({ skillId: p.skillId, kind: target!.kind, target: target!.id, priority: PRIORITY_DEFAULT, by });
      } else {
        await t.insertVersion({ body: v.body, tools: p.payload.tools, bytes: v.bytes, sha256: v.sha256, source: 'proposal', proposalId: p.id, by: p.proposer });
        if (!(await t.setActive(p.skillId, p.baseVersion, version, v.body.title))) throw new SkillRefused('stale'); // rolls the transaction back
      }
      if (beforeCommit) {
        const refused = await beforeCommit(t, p); // the AI cap claim is the last write; any refusal rolls the whole transaction back
        if (refused) throw new SkillRefused(refused);
      }
      await t.closeProposal(p.id, 'applied', closer, `version:${version}`);
      return { ok: true, lines: [`Skill ${p.skillId} is now at v${version} (${v.bytes} bytes).`], version, skillId: p.skillId, deptId: p.deptId, kind: p.kind };
    }).catch(async (e: unknown) => {
      if (e instanceof SkillRefused) return { ok: false as const, code: e.code, stale: null };
      throw e;
    });
    if (!out.ok) {
      if (!(ai && out.code === 'gone')) await this.rec(by, audit, `proposal:${proposalId}`, `refused:${out.code}`);
      return { ok: false, code: out.code, why: refusalText({ code: out.code }), gone: ai && out.code === 'gone' };
    }
    await this.reloadQuietly();
    await this.rec(by, audit, `proposal:${proposalId}`, `ok v${out.version}`);
    return out;
  }

  async rejectProposal(proposalId: number, adminId: string): Promise<boolean> {
    const ok = await this.d.repo.reject(proposalId, adminId);
    await this.rec(`user:${adminId}`, 'skill.reject', `proposal:${proposalId}`, ok ? 'ok' : 'refused:not_found');
    return ok;
  }

  /** open -> card for this admin card (false: the proposal is not open any more). */
  async bindCard(proposalId: number, cardId: string, adminId: string): Promise<boolean> {
    return this.d.repo.attachCard(proposalId, cardId, `user:${adminId}`);
  }

  async releaseCard(cardId: string): Promise<void> {
    await this.d.repo.releaseCard(cardId);
  }
}

const auditName = (op: SkillOp): string =>
  op.op === 'create' && op.seed ? 'seed' : op.op === 'tools' ? `tools.${op.action}` : op.op === 'status' ? (op.to === 'active' ? 'enable' : 'disable') : op.op;
