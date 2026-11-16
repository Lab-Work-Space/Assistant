import type { ActorRef } from '../company/types.js';
import type { ConfigStore } from '../config/store.js';
import type { ProjectRepo } from '../db/repos/projects.js';
import { isAlwaysCard } from '../tools/autopilot.js';
import type { AutopilotDecision, AutopilotPort } from '../tools/types.js';
import { precheckCall } from './ai-approver.js';
import { inputFlags } from './ai-approver-prompt.js';

export interface AutopilotDeps {
  cfg: Pick<ConfigStore, 'get'>;
  halted: () => boolean;
  repo: Pick<ProjectRepo, 'projectOf' | 'claimApproval' | 'toolsFor' | 'toolsForTask' | 'grantTool' | 'companyRoot' | 'claimCompany' | 'grantTreeTool' | 'treeToolsFor'>;
  /** A persona's department (the project grants are per department). */
  org: { persona(id: string): { deptId: string } | null | undefined };
  /** The MAIN registry's `describe` (AA-C1: the hard-deny classes are read from the registry, never copied). */
  describe: (name: string) => { kind?: string } | undefined;
  secrets: readonly string[];
  /** `ProjectService.exhausted`: the one budget notice (a claim-first CAS; never throws). */
  exhausted: (projectId: number) => Promise<boolean>;
  /** AUTO-2 3.8: the once-per-day cap notice (repo.claimCapNotice, then a bot-log post). Never throws; a throw is swallowed here and the card is still filed. Optional so a rig without it still decides. */
  capNotice?: (which: 'day' | 'tree' | 'person') => Promise<void>;
  log: { error(o: unknown, m?: string): void };
}

/** R6 MC-C1: no project-tool or tree-tool row can offer an external (MCP) tool; those are granted only with /mcp depts. A second line behind the SQL filter. */
export const dropMcp = (names: readonly string[]): string[] => names.filter((n) => !n.startsWith('mcp_'));
const errName = (e: unknown): string => (e instanceof Error ? e.name : 'unknown');
const CARD: AutopilotDecision = { kind: 'card' };
type RefuseCode = Extract<AutopilotDecision, { kind: 'refuse' }>['code'];
const refuse = (code: RefuseCode, company: boolean): AutopilotDecision => (company ? { kind: 'refuse', code, company: true } : { kind: 'refuse', code });
/** SA-1 3.8 / 5.3: fixed refusal texts of a project tool grant. */
export const GRANT_TEXT = { exists: 'Your department already has that tool in this project.', cap: 'This project already has 10 granted tools.' } as const;

/** AUTO-2 3.8, AC-C13: the cap notice. Fixed text: the only variable is a closed 3-value code from the claim, never model or person text. */
export const CAP_NOTICE_TITLE = 'Company autopilot cap reached';
export const capNoticeBody = (which: 'day' | 'tree' | 'person'): string =>
  `The company autopilot cap was reached (${which === 'day' ? 'the daily cap' : which === 'person' ? 'a per-person daily cap' : 'a task tree cap'}). Calls that need approval now go to the card path (AI approver, then a person) until the cap resets. Nothing is blocked by the cap itself. The caps are autopilot.company.maxApprovalsPerDay, autopilot.company.maxApprovalsPerTree and autopilot.company.maxApprovalsPerPersonDay (psql).`;

/** AUTO-2 3.7: the fixed refusal texts of a task-tree tool grant. */
export const GRANT_TREE_TEXT = { exists: 'Your department already has that tool in this task tree.', cap: 'This task tree already has 5 granted tools.' } as const;

export type ProjectGrantResult = { kind: 'granted'; projectId: number } | { kind: 'granted_tree'; rootId: string } | { kind: 'refused'; text: string } | { kind: 'not_project' };

/**
 * AUTO-1 (SA-1 3.3, Gate 1 AP-C1..C3, AP-C10, AP-C14): the decision for one call that needs approval, made inline by the registry for the task owner's own call inside an active
 * project. `decide` never throws: every fault answers `card` (today's rules, a person decides). It logs `errName` only and never a tool input, a title or a goal.
 */
export class AutopilotService implements AutopilotPort {
  constructor(private readonly d: AutopilotDeps) {}

  projectOf(taskId: string): Promise<{ id: number; rootTaskId: string; deadline: string } | null> {
    return this.d.repo.projectOf(taskId).catch(() => null);
  }

  /** AUTO-2 3.1: enabled, scope 'company' and not halted. Synchronous; any read error is false (project rules). Never throws. */
  companyOn(): boolean {
    try {
      return this.d.cfg.get('autopilot.enabled') === true && this.d.cfg.get('autopilot.scope') === 'company' && !this.d.halted();
    } catch {
      return false;
    }
  }

  /** AUTO-2: the task's tree is a company tree (never `!projectOf`: AC-C2 uses any projects row). False on any doubt; never throws. */
  async inCompany(taskId: string): Promise<boolean> {
    try {
      return this.companyOn() && (await this.d.repo.companyRoot(taskId)) !== null;
    } catch {
      return false;
    }
  }

  async decide(r: { taskId: string; tool: string; input: unknown }): Promise<AutopilotDecision> {
    try {
      // 1. gate: the switch is on (a read error is off) and the company is not halted
      if (this.d.cfg.get('autopilot.enabled') !== true || this.d.halted()) return CARD;
      // 2. an active, unpaused, not exhausted, in-time project of this task's tree; with none, a company tree when company scope is on (AUTO-2 3.2)
      const p = await this.d.repo.projectOf(r.taskId);
      let company = false;
      if (!p) {
        if (!this.companyOn() || (await this.d.repo.companyRoot(r.taskId)) === null) return CARD;
        company = true;
      }
      if (isAlwaysCard(r.tool)) return CARD; // comments keep their card (Gate 1 table)
      // 3. the hard-deny classes go to the card; the url and query heuristics refuse
      const code = precheckCall(r.tool, r.input, this.d.describe, this.d.secrets);
      if (code !== null) return code.startsWith('hard_deny:') ? CARD : code === 'url_heuristic' || code === 'query_heuristic' ? refuse(code, company) : CARD;
      // 4. a secret in the input, or a text field the card could not show whole
      const f = inputFlags(r.tool, r.input, this.d.secrets);
      if (f.masked) return refuse('masked_input', company);
      if (f.inputCut) return refuse('input_cut', company);
      // 5. the claim (one transaction: counter plus audit row)
      if (company) {
        const cc = await this.d.repo.claimCompany(r.taskId, r.tool);
        if (cc.kind === 'run') return { kind: 'run' };
        if (cc.kind === 'cap') await this.notice(cc.which); // never throws; the card is filed either way
        return CARD;
      }
      if (!p) return CARD; // unreachable: company is false only with a project
      const c = await this.d.repo.claimApproval(p.id, r.taskId, r.tool);
      if (c.kind === 'run') return { kind: 'run' };
      if (c.kind === 'budget') await this.d.exhausted(p.id); // never throws; the one notice
      return CARD;
    } catch (err) {
      this.d.log.error({ errName: errName(err) }, 'autopilot decision failed');
      return CARD;
    }
  }

  private async notice(which: 'day' | 'tree' | 'person'): Promise<void> {
    try { await this.d.capNotice?.(which); } catch (err) { this.d.log.error({ errName: errName(err) }, 'autopilot cap notice failed'); }
  }

  private deptOf(actor: ActorRef): string | null {
    return actor.kind === 'head' ? actor.dept : (this.d.org.persona(actor.personaId)?.deptId ?? null);
  }

  /** The tools granted to the actor's department in project `projectId` (offer and dispatch lists). Empty on any doubt; never throws. */
  async toolsFor(projectId: number, actor: ActorRef): Promise<string[]> {
    try {
      const dept = this.deptOf(actor);
      return dept ? dropMcp(await this.d.repo.toolsFor(projectId, dept)) : [];
    } catch {
      return [];
    }
  }

  /** Replay: the grants of the active project the task's tree belongs to, plus (company scope on) the task-tree grants. Empty on any doubt; never throws. */
  async toolsForTask(taskId: string, actor: ActorRef): Promise<string[]> {
    const proj = await this.guard(async (dept) => this.d.repo.toolsForTask(taskId, dept), actor);
    return dropMcp([...new Set([...proj, ...(await this.treeToolsFor(taskId, actor))])]);
  }

  /** AUTO-2 3.7: the task-tree grants of the actor's department while company scope is on (offer list and replay). Empty on any doubt; never throws. */
  async treeToolsFor(taskId: string, actor: ActorRef): Promise<string[]> {
    return this.companyOn() ? dropMcp(await this.guard(async (dept) => this.d.repo.treeToolsFor(taskId, dept), actor)) : [];
  }

  private async guard(fn: (dept: string) => Promise<string[]>, actor: ActorRef): Promise<string[]> {
    try {
      const dept = this.deptOf(actor);
      return dept ? await fn(dept) : [];
    } catch {
      return [];
    }
  }

  /**
   * `tool_request` inside a project (SA-1 3.8, AP-C7): the caller (ToolRequestService) has already checked the owner, the untainted run and rule G. Here: the task is in an active
   * project, the tool is not a name-level hard-deny class, then one capped insert. Anything else is `not_project` (today's card). Never throws.
   */
  async projectGrant(r: { dept: string; taskId: string; tool: string }): Promise<ProjectGrantResult> {
    try {
      if (r.tool.startsWith('mcp_')) return { kind: 'not_project' }; // R6 MC-C1: never a project or tree grant (the card path then refuses it as unknown)
      if (this.d.cfg.get('autopilot.enabled') !== true || this.d.halted()) return { kind: 'not_project' };
      const p = await this.d.repo.projectOf(r.taskId);
      if (!p) {
        // AUTO-2 3.7: no live project; in company scope a company tree grants for this tree only
        if (!this.companyOn() || (await this.d.repo.companyRoot(r.taskId)) === null) return { kind: 'not_project' };
        if (precheckCall(r.tool, {}, this.d.describe, this.d.secrets)?.startsWith('hard_deny:')) return { kind: 'not_project' };
        const t = await this.d.repo.grantTreeTool({ taskId: r.taskId, deptId: r.dept, tool: r.tool });
        if (t.ok) return { kind: 'granted_tree', rootId: t.rootId };
        if (t.code === 'exists') return { kind: 'refused', text: GRANT_TREE_TEXT.exists };
        if (t.code === 'cap') return { kind: 'refused', text: GRANT_TREE_TEXT.cap };
        return { kind: 'not_project' };
      }
      if (precheckCall(r.tool, {}, this.d.describe, this.d.secrets)?.startsWith('hard_deny:')) return { kind: 'not_project' };
      const g = await this.d.repo.grantTool({ projectId: p.id, deptId: r.dept, tool: r.tool, taskId: r.taskId });
      if (g.ok) return { kind: 'granted', projectId: p.id };
      if (g.code === 'exists') return { kind: 'refused', text: GRANT_TEXT.exists };
      if (g.code === 'cap') return { kind: 'refused', text: GRANT_TEXT.cap };
      return { kind: 'not_project' };
    } catch (err) {
      this.d.log.error({ errName: errName(err) }, 'project tool grant failed');
      return { kind: 'not_project' };
    }
  }
}
