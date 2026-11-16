import type { CallDeps } from '../agents/call/call.js';
import type { Org } from '../company/org.js';
import type { ConfigStore } from '../config/store.js';
import type { PromptOverrideRepo } from '../db/repos/ledger.js';
import type { SkillAiRepo } from '../db/repos/skill-ai.js';
import { AI_ACTOR, type SkillProposal, type SkillRepo } from '../db/repos/skills.js';
import { escapeCardText } from '../discord/embeds/approval.js';
import type { PromptDoc } from '../prompts/index.js';
import type { ProviderRegistry } from '../providers/registry.js';
import type { FallbackState } from '../providers/route.js';
import { HUMAN_SOURCES, proposalNotice, type SkillService } from '../skills/service.js';
import type { SkillBody } from '../skills/render.js';
import type { AuditFn } from './audit.js';
import { JudgeCaller, JudgeError } from './judge-call.js';
import { AI_SKILL_JUDGE_SYSTEM, buildSkillJudgeUser } from './skill-judge-prompt.js';

export const SKILL_JUDGE_CONCURRENCY = 1;
const URL_RE = /https?:\/\/|www\./i;

/** The escalation codes. `check:<code>` and `apply:<code>` carry the refusal code of the checks or of the apply. */
export type SkillJudgeCode =
  | `check:${string}` | `apply:${string}` | 'bad_target' | 'human_version' | 'not_active' | 'rejected_before' | 'url' | 'masked_input' | 'input_cut' | 'cap_dept' | 'cap_week'
  | 'halted' | 'disabled' | 'judge' | 'judge_timeout' | 'judge_error' | 'judge_bad_output' | 'judge_budget' | 'interrupted';

/** The fixed AI review line for a code (SA-1 3.2). `null`: no line. `judge` takes the sanitised reason instead. */
export function skillReviewText(code: SkillJudgeCode): string | null {
  if (code.startsWith('check:')) return 'Not reviewed: failed the code checks';
  if (code.startsWith('apply:')) return `Not applied: ${code.slice(6)}`.slice(0, 200);
  switch (code) {
    case 'bad_target': return 'Not reviewed: target outside the team';
    case 'human_version': return 'Escalated: the current version was written by a person';
    case 'not_active': return 'Escalated: the skill is not active';
    case 'rejected_before': return 'Escalated: a person rejected this skill before';
    case 'url': return 'Escalated: contains a link';
    case 'masked_input': return 'Not reviewed: contains a secret';
    case 'input_cut': return 'Escalated: too long to review in full';
    case 'cap_dept': case 'cap_week': return 'Escalated: AI skill cap reached';
    case 'judge_timeout': return 'Not reviewed: the AI review timed out';
    case 'judge_error': case 'judge_bad_output': case 'judge_budget': return 'Not reviewed: the AI review failed';
    case 'interrupted': return 'Not reviewed: interrupted by a restart';
    default: return null; // halted, disabled, judge (reason is passed in)
  }
}

export type SkillJudgeVerdict = 'applied' | 'escalated' | 'gone' | 'off';

export interface SkillJudgeDeps {
  cfg: Pick<ConfigStore, 'get'> & Partial<Pick<ConfigStore, 'listenerHealthy'>>;
  svc: Pick<SkillService, 'review' | 'applyByAi'>;
  proposals: Pick<SkillRepo, 'getProposal'>;
  repo: Pick<SkillAiRepo, 'offered' | 'start' | 'counts' | 'setAiReview' | 'activeSource' | 'rejectedBefore' | 'interrupted'>;
  halt: { isHalted(): boolean };
  /** The swallowing audit helper (escalate rows only; the start row and the cap claim are throwing inserts in SkillAiRepo / SkillTx). */
  audit: AuditFn;
  /** The shared literal secret list (it may grow after construction). */
  secrets: readonly string[];
  org: Org;
  prompts: Map<string, PromptDoc>;
  overrides: Pick<PromptOverrideRepo, 'getActive'>;
  providers: Pick<ProviderRegistry, 'resolve'> & Partial<Pick<ProviderRegistry, 'has' | 'get'>>;
  /** R8: the Claude API backup gate (JudgeCaller); absent = no backup. */
  fallback?: FallbackState;
  call: CallDeps;
  log: { warn(o: unknown, m?: string): void };
  /** Posts a fixed #setting alert (hq, governance). Code text and validated ids only, plus the sanitised AI line. */
  notify(title: string, text: string): Promise<void>;
  timeoutMs?: number;
}

const errName = (e: unknown): string => (e instanceof Error ? e.name : 'error');
const wireCode = (c: string): string => c.replace(/[^a-z0-9_:]/g, '_').slice(0, 40);

/**
 * GROW-1 (SA-1 3.2, Gate 1 GW-C7..C15): the AI skill judge. `offer` is spawned by SkillService.propose and never throws; `review` never throws and every failure
 * escalates to a Bot Admin. The judge's approve applies through SkillService.applyByAi (the only caller), bound to the hash of the same review() call.
 */
export class SkillJudge {
  private readonly caller: JudgeCaller;
  constructor(private readonly d: SkillJudgeDeps) { this.caller = new JudgeCaller(d, AI_SKILL_JUDGE_SYSTEM, 'skill_review', SKILL_JUDGE_CONCURRENCY); }

  /** Spawns the review. Never throws, never blocks the proposer's tool reply. */
  offer(proposalId: number): void {
    void this.review(proposalId);
  }

  private on(): boolean {
    try { return this.d.cfg.get('skills.ai.enabled') === true; } catch { return false; }
  }
  private tz(): string {
    try { return this.d.cfg.get('schedule.timezone'); } catch { return 'Asia/Bangkok'; }
  }

  /** Never throws. The exception path escalates, so a human notice is posted even when the review died before its start row (GW-C14). */
  async review(proposalId: number): Promise<SkillJudgeVerdict> {
    try {
      return await this.reviewInner(proposalId);
    } catch (err) {
      this.d.log.warn({ errName: errName(err) }, 'skill judge failed');
      await this.escalate(proposalId, 'judge_error');
      return 'escalated';
    }
  }

  private async reviewInner(id: number): Promise<SkillJudgeVerdict> {
    const p0 = await this.d.proposals.getProposal(id);
    if (!p0 || p0.status !== 'open') return 'gone';
    await this.d.repo.offered(id, p0.deptId).catch(() => undefined); // best effort: the marker only helps boot recovery
    if (!this.on()) {
      await this.d.repo.offered(id, p0.deptId, true).catch(() => undefined);
      await this.post('Skill proposal', proposalNotice(p0)); // switched off since the offer: today's notice, no AI line, no escalate row
      return 'off';
    }
    if (this.d.halt.isHalted()) { await this.escalate(id, 'halted', undefined, p0); return 'escalated'; }
    const rev = await this.d.svc.review(id);
    if (!rev.ok) {
      if (rev.code === 'not_found') return 'gone';
      await this.escalate(id, `check:${rev.code}`, undefined, p0);
      return 'escalated';
    }
    const p = rev.proposal;
    const esc = async (code: SkillJudgeCode): Promise<SkillJudgeVerdict> => { await this.escalate(id, code, undefined, p); return 'escalated'; };

    // target: still inside the proposing team
    const targetOk = p.kind === 'create'
      ? (p.targetKind === 'dept' ? p.targetId === p.deptId && this.d.org.dept(p.deptId)?.enabled === true
        : p.targetKind === 'persona' && !!p.targetId && (() => { const per = this.d.org.persona(p.targetId!); return !!per && per.deptId === p.deptId && per.enabled; })())
      : rev.attachments.every((a) => (a.targetKind === 'dept' ? a.targetId === p.deptId : this.d.org.persona(a.targetId)?.deptId === p.deptId));
    if (!targetOk) return esc('bad_target');

    // GW-C10: a person's rollback, edit, disable or rejection is durable
    if (p.kind === 'edit') {
      const st = await this.d.repo.activeSource(p.skillId);
      if (!st || st.status !== 'active') return esc('not_active');
      if (HUMAN_SOURCES.includes(st.source)) return esc('human_version');
    }
    if (await this.d.repo.rejectedBefore(p.skillId)) return esc('rejected_before');

    if ([rev.body.title, rev.body.instructions, ...rev.body.templates.flatMap((t) => [t.name, t.body]), p.payload.reason].some((f) => URL_RE.test(f))) return esc('url');
    const tz = this.tz();
    const current: SkillBody | null = p.kind === 'edit' && rev.current ? { id: p.skillId, version: rev.current.activeVersion, title: rev.current.title, instructions: rev.current.instructions, templates: rev.current.templates } : null;
    const target = p.kind === 'create' ? { kind: p.targetKind ?? 'dept', id: p.targetId ?? p.deptId } : rev.attachments.map((a) => ({ kind: a.targetKind, id: a.targetId }));
    // GW-C8: the text comes only from rev.body / rev.current of THIS review() call, never from p.payload
    const built = buildSkillJudgeUser({
      proposalId: p.id, dept: p.deptId, operation: p.kind, skillId: p.skillId, target, versionAfter: rev.body.version, body: rev.body, current, reason: p.payload.reason, secrets: this.d.secrets,
    });
    if (built.masked) return esc('masked_input');
    const maxDept = this.d.cfg.get('skills.ai.maxPerDeptWeek');
    const maxWeek = this.d.cfg.get('skills.ai.maxPerWeek');
    const counts = await this.d.repo.counts(p.deptId, tz);
    if (counts.dept >= maxDept) return esc('cap_dept');
    if (counts.week >= maxWeek) return esc('cap_week');
    if (built.inputCut) return esc('input_cut');

    await this.d.repo.start(id, p.deptId); // a THROWING insert: no start row, no judge call
    let answer;
    try {
      answer = await this.caller.run(built.text);
    } catch (err) {
      return esc(err instanceof JudgeError ? err.code : 'judge_error');
    }
    if (answer.decision === 'escalate') {
      await this.escalate(id, 'judge', answer.reason, p);
      return 'escalated';
    }

    const res = await this.d.svc.applyByAi(id, rev.sha256, async (t, row) => {
      // inside the apply transaction: memory reads and the claim on the tx client only (no pool query: AI-APPROVE G2-01)
      if (!this.on()) return 'disabled';
      if (this.d.halt.isHalted()) return 'halted';
      return t.aiApplyClaim(row.deptId, row.id, tz, maxDept, maxWeek);
    });
    if (res.ok) {
      const n = res.version;
      const undo = res.kind === 'edit' ? `/skill rollback ${res.skillId} ${n - 1} or /skill disable ${res.skillId}` : `/skill disable ${res.skillId}`;
      await this.post('Skill applied by the AI reviewer', `Skill ${res.skillId} v${n} (${res.deptId}) applied by the AI reviewer from proposal #${id}. Undo: ${undo}.`);
      return 'applied';
    }
    if (res.gone) return 'gone'; // a card was minted, or a person decided, while the judge ran
    const code = res.code === 'halted' || res.code === 'disabled' || res.code === 'cap_dept' || res.code === 'cap_week' ? res.code : (`apply:${wireCode(res.code)}` as const);
    return esc(code);
  }

  /**
   * The escalate path, never throwing: the audit row (a code only, never the judge's text), the AI line on the proposal, then the human notice with that line.
   * The notice is posted only while the proposal is still `open` (a card already minted, or a decided proposal, needs no second notice).
   */
  private async escalate(id: number, code: SkillJudgeCode, judgeReason?: string, known?: SkillProposal): Promise<void> {
    try {
      let p: SkillProposal | null = known ?? null;
      if (!p) p = await this.d.proposals.getProposal(id).catch(() => null);
      const text = code === 'judge' ? (judgeReason ?? null) : skillReviewText(code);
      await this.d.audit({ actor: AI_ACTOR, action: 'skill.ai.escalate', tool: p?.deptId ?? null, outcome: `proposal:${id} ${wireCode(code)}` });
      if (text && p) await this.d.repo.setAiReview(id, text).catch(() => undefined);
      if (p) {
        const fresh = known ? await this.d.proposals.getProposal(id).catch(() => known) : p; // status now, not at review start
        if (fresh && fresh.status !== 'open') return;
      }
      const line = text ? ` AI review: ${escapeCardText(text, 200, this.d.secrets)}` : '';
      await this.post('Skill proposal', `${p ? proposalNotice(p) : `Skill proposal #${id} needs a person. Review: /skill review ${id}`}${line}`);
    } catch (err) {
      this.d.log.warn({ errName: errName(err) }, 'skill judge escalate failed');
    }
  }

  private async post(title: string, text: string): Promise<void> {
    await this.d.notify(title, text).catch((err: unknown) => this.d.log.warn({ errName: errName(err) }, 'skill judge notice failed'));
  }

  /** Boot recovery (GW-C14): the proposals a restart cut short (or that never reached `start`) are escalated `interrupted` and their human notice is posted. Never judged again. */
  async recover(bootTime?: Date): Promise<number> {
    let rows: SkillProposal[] = [];
    try { rows = await this.d.repo.interrupted(bootTime); } catch (err) { this.d.log.warn({ errName: errName(err) }, 'skill judge recovery read failed'); return 0; }
    for (const p of rows) await this.escalate(p.id, 'interrupted', undefined, p);
    return rows.length;
  }
}
