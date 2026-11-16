import { localDay } from '../../company/calendar.js';
import type { ConfigStore } from '../../config/store.js';
import type { AiApproverRepo, AiDay } from '../../db/repos/ai-approver.js';
import type { ProjectDay, ProjectRepo } from '../../db/repos/projects.js';
import type { ReleaseDay, ReleaseRepo } from '../../db/repos/releases.js';
import type { SkillAiDay, SkillAiRepo } from '../../db/repos/skill-ai.js';
import { escapeCardText } from '../../discord/embeds/approval.js';
import type { OutboundPayload } from '../loop/payload.js';

/** The digest is posted at the first tick at or after this local hour (schedule.timezone), on workdays and off days alike. */
export const AI_DIGEST_HOUR = 18;

export interface AiDigestDeps {
  repo: Pick<AiApproverRepo, 'day'>;
  /** GROW-1: the Skills part (AI-applied skills and skill escalations). Absent = no Skills part. */
  skills?: Pick<SkillAiRepo, 'day'>;
  /** AUTO-1: the Autopilot part (approvals without a card, refusals, budgets used up, grants). Absent = no Autopilot part. */
  autopilot?: Pick<ProjectRepo, 'day'>;
  /** R5 RELEASE-1: the Releases line (counts for today). Absent = no Releases line. */
  releases?: Pick<ReleaseRepo, 'day'>;
  /** R6 MCP-1 (spec 5.12): the MCP line (counts for today). Absent = no MCP line. */
  mcp?: { day(tz: string): Promise<McpDay> };
  /** R7 PLUGIN-FORGE (spec 5.10): the forge line (counts for today). Absent = no forge line. */
  forge?: { day(tz: string): Promise<ForgeDay> };
  cfg: Pick<ConfigStore, 'get'>;
  secrets?: readonly string[];
  now: () => number | Date;
  log: { error(obj: unknown, msg?: string): void };
  daily: { claim(day: string, kind: 'ai_digest'): Promise<boolean> };
  /** Posts the digest (hq to #bot-log). */
  post(p: OutboundPayload): Promise<unknown>;
}

/** R7: today's plugin builds and the servers waiting for `/mcp approve` (from the build and forge rows; no text). */
export interface ForgeDay { builds: number; staged: number; failed: number; installed: number; waiting: number }
const forgeEmpty = (f: ForgeDay | undefined): boolean => !f || !(Number(f.builds) || Number(f.staged) || Number(f.failed) || Number(f.installed) || Number(f.waiting));
/** R6: today's external tool counts (from the audit rows; no text of a call). */
export interface McpDay { calls: number; failed: number; quarantined: number }
const mcpEmpty = (m: McpDay | undefined): boolean => !m || !(Number(m.calls) || Number(m.failed) || Number(m.quarantined));
const EMPTY_AUTO: ProjectDay = { projects: [], tools: [], refused: [], exhausted: [], grants: [] };
const companyEmpty = (a: ProjectDay): boolean => !a.company || (!a.company.total && !a.company.capHit && !a.company.treeGrants.length);
const projectEmpty = (a: ProjectDay): boolean => !a.projects.length && !a.tools.length && !a.refused.length && !a.exhausted.length && !a.grants.length;
const autoEmpty = (a: ProjectDay): boolean => projectEmpty(a) && companyEmpty(a);

const relEmpty = (r: ReleaseDay | undefined): boolean => !r || !(Number(r.requested) || Number(r.released) || Number(r.rejected) || Number(r.expired) || Number(r.failed) || Number(r.waiting));

const errName = (e: unknown): string => (e instanceof Error ? e.name : 'error');

/**
 * AI-APPROVE-1 (AA-C20): the daily AI approval digest. Fixed text plus counts, tool names (escapeCardText 64), codes and at most 5 sanitised judge
 * reasons (escapeCardText 120 with secrets). Its own `ai_digest` claim, taken only when there is at least one review; no model reaches this class.
 */
export class AiDigest {
  private done: string | null = null;
  private running = false;

  constructor(private readonly d: AiDigestDeps) {}

  private nowMs(): number {
    const n = this.d.now();
    return typeof n === 'number' ? n : n.getTime();
  }

  private localHour(tz: string): number {
    return Number(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', hour: '2-digit' }).format(this.nowMs()));
  }

  payload(day: AiDay, skills: SkillAiDay = { applied: [], escalations: [] }, auto: ProjectDay = EMPTY_AUTO, rel?: ReleaseDay, mcp?: McpDay, forge?: ForgeDay): OutboundPayload | null {
    if (day.reviews < 1 && skills.applied.length < 1 && skills.escalations.length < 1 && autoEmpty(auto) && relEmpty(rel) && mcpEmpty(mcp) && forgeEmpty(forge)) return null;
    const secrets = this.d.secrets ?? [];
    const one = (s: string, max: number): string => escapeCardText(s.replace(/\s+/g, ' ').trim(), max, secrets);
    const lines: string[] = [`Reviews today: ${day.reviews}.`];
    if (day.approvals.length) lines.push('', 'Approved by the AI, per tool:', ...day.approvals.map((x) => `- ${one(x.tool, 64)}: ${x.n}`));
    if (day.escalations.length) lines.push('', 'Escalated to a person, per code:', ...day.escalations.map((x) => `- ${one(x.code, 64)}: ${x.n}`));
    if (day.reasons.length) lines.push('', 'Latest judge reasons:', ...day.reasons.slice(0, 5).map((r) => `- ${one(r, 120)}`));
    lines.push('', `Cap reached today: ${day.capHit ? 'yes' : 'no'}`);
    if (skills.applied.length) lines.push('', 'Skills applied by the AI:', ...skills.applied.map((x) => `- ${one(x.skillId, 64)} v${Math.trunc(x.version)} (${one(x.deptId, 64)})`));
    if (skills.escalations.length) lines.push('', 'Skill proposals escalated, per code:', ...skills.escalations.map((x) => `- ${one(x.code, 64)}: ${x.n}`));
    const n = (x: number): number => Math.trunc(Number(x));
    if (!projectEmpty(auto)) {
      lines.push('', 'Autopilot:');
      if (auto.projects.length) lines.push('Approved without a card, per project:', ...auto.projects.map((x) => `- #${n(x.id)} ${one(x.title, 60)}: ${n(x.n)}`));
      if (auto.tools.length) lines.push('Per tool:', ...auto.tools.slice(0, 10).map((x) => `- ${one(x.tool, 64)}: ${n(x.n)}`));
      if (auto.refused.length) lines.push('Refused as data-like, per code:', ...auto.refused.map((x) => `- ${one(x.code, 64)}: ${n(x.n)}`));
      if (auto.exhausted.length) lines.push('Budget used up today:', ...auto.exhausted.map((x) => `- #${n(x.id)} ${one(x.title, 60)}`));
      if (auto.grants.length) lines.push('Tools granted to a project today:', ...auto.grants.slice(0, 25).map((x) => `- #${n(x.projectId)} ${one(x.dept, 32)} ${one(x.tool, 64)}`));
    }
    // AUTO-2 (SA-1 5.6, AC-C13): fixed labels, counts, closed codes and root8 ids only; no text of a task, a tool input or a message.
    const c = auto.company;
    if (c && !companyEmpty(auto)) {
      lines.push('', 'Company autopilot (no project):', `Approved without a card: ${n(c.total)}`);
      if (c.tools.length) lines.push('Per tool:', ...c.tools.slice(0, 10).map((x) => `- ${one(x.tool, 64)}: ${n(x.n)}`));
      if (c.capHit) lines.push(`Cap reached today: ${c.capHit === 'day' ? 'daily cap' : c.capHit === 'person' ? 'a per-person daily cap' : 'a task tree cap'}`);
      if (c.treeGrants.length) lines.push('Tools granted to a task tree today:', ...c.treeGrants.slice(0, 25).map((x) => `- ${one(x.root8, 8)} ${one(x.dept, 32)} ${one(x.tool, 64)}`));
    }
    // R5 RELEASE-1: a fixed label and six integers; no title, slug or text of a request.
    if (rel && !relEmpty(rel)) lines.push('', 'Releases:', `Requested ${n(rel.requested)}, released ${n(rel.released)}, rejected ${n(rel.rejected)}, expired ${n(rel.expired)}, failed ${n(rel.failed)}; waiting now ${n(rel.waiting)}.`);
    // R6 MCP-1 (spec 5.12): one fixed line and three integers; omitted when all three are 0.
    if (mcp && !mcpEmpty(mcp)) lines.push('', `MCP today: ${n(mcp.calls)} call(s), ${n(mcp.failed)} failed, ${n(mcp.quarantined)} quarantined.`);
    // R7 PLUGIN-FORGE (spec 5.10): one fixed line and five integers; omitted when all five are 0.
    if (forge && !forgeEmpty(forge)) lines.push('', `Plugin forge today: ${n(forge.builds)} build(s), ${n(forge.staged)} staged, ${n(forge.failed)} failed, ${n(forge.installed)} installed; ${n(forge.waiting)} waiting for /mcp approve.`);
    return { type: 'alert', origin: 'governance', title: 'AI approval digest', body: lines.join('\n').slice(0, 4000) };
  }

  /** At or after 18:00 local: read first, claim only when there was at least one review (an empty day must not use up the claim), then post. Never throws. */
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const tz = this.d.cfg.get('schedule.timezone');
      const today = localDay(this.nowMs(), tz).date;
      if (this.done === today || this.localHour(tz) < AI_DIGEST_HOUR) return;
      const skills = this.d.skills ? await this.d.skills.day(tz).catch((err: unknown) => { this.d.log.error({ errName: errName(err) }, 'ai digest skills read failed'); return undefined; }) : undefined;
      const auto = this.d.autopilot ? await this.d.autopilot.day(tz).catch((err: unknown) => { this.d.log.error({ errName: errName(err) }, 'ai digest autopilot read failed'); return undefined; }) : undefined;
      const rel = this.d.releases ? await this.d.releases.day(tz).catch((err: unknown) => { this.d.log.error({ errName: errName(err) }, 'ai digest releases read failed'); return undefined; }) : undefined;
      const mcp = this.d.mcp ? await this.d.mcp.day(tz).catch((err: unknown) => { this.d.log.error({ errName: errName(err) }, 'ai digest mcp read failed'); return undefined; }) : undefined;
      const forge = this.d.forge ? await this.d.forge.day(tz).catch((err: unknown) => { this.d.log.error({ errName: errName(err) }, 'ai digest forge read failed'); return undefined; }) : undefined;
      const p = this.payload(await this.d.repo.day(tz), skills, auto, rel, mcp, forge);
      if (!p) return;
      this.done = today;
      if (!(await this.d.daily.claim(today, 'ai_digest'))) return;
      await this.d.post(p).catch((err: unknown) => this.d.log.error({ errName: errName(err) }, 'ai digest post failed'));
    } catch (err) {
      this.d.log.error({ errName: errName(err) }, 'ai digest failed');
    } finally {
      this.running = false;
    }
  }
}
