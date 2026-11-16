import type { DeptId } from '../core/index.js';
import type { Department, Persona } from '../db/repos/index.js';
import type { PromptDoc } from '../prompts/index.js';
import type { ToolPolicy } from '../tools/policy.js';
import type { OrgRepos } from './seed.js';
import type { SkillView } from '../skills/render.js';
import { selectSkills } from '../skills/select.js';
import type { AttachmentRow, SkillRow } from '../skills/types.js';
import type { ActorRef } from './types.js';

export class Org {
  private depts = new Map<string, Department>();
  private personas = new Map<string, Persona>();
  private channels = new Map<string, string>();
  private policy: ToolPolicy | null = null;
  /** SKILLS-1: active-version cache and attachments; swapped together with departments, personas and channels (SK11). */
  private skills = new Map<string, SkillRow>();
  private attachments: AttachmentRow[] = [];
  private skillsLoaded = false;
  private skillsFault: ((err: unknown) => void) | null = null;

  private constructor(
    private readonly repos: OrgRepos,
    private readonly prompts: Map<string, PromptDoc>,
  ) {}

  static async load(repos: OrgRepos, prompts: Map<string, PromptDoc>): Promise<Org> {
    const org = new Org(repos, prompts);
    await org.reload();
    return org;
  }

  /** Called with the error when the skills query fails (the caller reports it as an incident; never carries skill text). */
  setSkillsFaultSink(fn: (err: unknown) => void): void {
    this.skillsFault = fn;
  }

  /**
   * Departments, personas, channels and skills are swapped together, only after every query succeeded. A failed skills query keeps the
   * previous cache (and the whole reload throws, so nothing is half-swapped); with no previous cache (first boot) the rest loads and
   * there are no skills and no skill tools (fail closed).
   */
  async reload(): Promise<void> {
    const skillsQuery = this.repos.skills ? this.repos.skills.loadAll().then((v) => ({ v }), (err: unknown) => ({ err })) : Promise.resolve({ v: { skills: [], attachments: [] } });
    const [depts, personas, mappings, snap] = await Promise.all([
      this.repos.departments.list(),
      this.repos.personas.list(),
      this.repos.channelMap.list(),
      skillsQuery,
    ]);
    if ('err' in snap) {
      this.skillsFault?.(snap.err);
      if (this.skillsLoaded) throw new Error('skills reload failed; the previous skill cache is kept');
    }
    this.depts = new Map(depts.map((d) => [d.id, d]));
    this.personas = new Map(personas.map((p) => [p.id, p]));
    this.channels = new Map(mappings.map((m) => [m.channelId, m.deptId]));
    if ('v' in snap) {
      this.skills = new Map(snap.v.skills.map((s) => [s.id, s]));
      this.attachments = snap.v.attachments;
      this.skillsLoaded = true;
    }
  }

  /**
   * SK11: the active skills of an actor, deterministic: department skills, then persona skills; each by priority ascending, then id.
   * A head sees department skills only; a persona sees its department's and its own (only while enabled); disabled and archived skills
   * are excluded. A skill attached at both levels appears once, at the department level. Never filtered by trigger here (loop.ts decides, SK1).
   */
  skillsFor(actor: ActorRef): SkillView[] {
    const persona = actor.kind === 'persona' ? this.persona(actor.personaId) : null;
    if (actor.kind === 'persona' && !persona?.enabled) return [];
    const dept = actor.kind === 'head' ? actor.dept : persona?.deptId;
    if (!dept) return [];
    return selectSkills({ skills: [...this.skills.values()], attachments: this.attachments }, { dept, ...(persona ? { personaId: persona.id } : {}) });
  }

  dept(id: string): Department | null {
    return this.depts.get(id) ?? null;
  }
  heads(): Department[] {
    return [...this.depts.values()];
  }
  personasOf(dept: string): Persona[] {
    return [...this.personas.values()].filter((p) => p.deptId === dept);
  }
  persona(id: string): Persona | null {
    return this.personas.get(id) ?? null;
  }

  /** Mapped channel, department work channel or persona direct channel. */
  deptOfChannel(channelId: string): DeptId | null {
    const mapped = this.channels.get(channelId);
    if (mapped) return mapped as DeptId;
    for (const d of this.depts.values()) if (d.workChannelId === channelId) return d.id as DeptId;
    return (this.personaByDirectChannel(channelId)?.deptId as DeptId | undefined) ?? null;
  }
  /** Ids of the channels (and forums) explicitly mapped to `dept` by /channel map or the sync; not its work or direct channels. */
  mappedChannelsOf(dept: string): string[] {
    return [...this.channels].filter(([, d]) => d === dept).map(([id]) => id);
  }
  personaByDirectChannel(channelId: string): Persona | null {
    for (const p of this.personas.values()) if (p.directChannelId === channelId) return p;
    return null;
  }
  personaByName(dept: string, name: string): Persona | null {
    const n = name.trim().toLowerCase();
    return this.personasOf(dept).find((p) => p.name.toLowerCase() === n) ?? null;
  }

  /** Code-side delegation guard; prompts are not a guard. */
  canDelegate(from: ActorRef, to: ActorRef): boolean {
    if (from.kind === 'persona') {
      const p = this.persona(from.personaId);
      return !!p && to.kind === 'head' && to.dept === p.deptId;
    }
    if (to.kind === 'head') return to.dept !== from.dept && this.depts.has(to.dept);
    const target = this.persona(to.personaId);
    return !!target && target.deptId === from.dept;
  }

  /** Installed once the tool registry exists (the Org is loaded before it). Without a policy only prompt meta applies. */
  setToolPolicy(p: ToolPolicy): void {
    this.policy = p;
  }

  /** Tool allowlist (Gate 1 D16): prompt meta filtered by the tool policy. Unknown actors get none. */
  toolsFor(actor: ActorRef): string[] {
    const persona = actor.kind === 'persona' ? this.persona(actor.personaId) : null;
    const ref = actor.kind === 'head' ? `heads/${actor.dept}` : persona?.promptRef;
    const dept = actor.kind === 'head' ? actor.dept : persona?.deptId;
    if (!ref || !dept) return [];
    const meta = [...(this.prompts.get(ref)?.meta.tools ?? [])];
    return this.policy ? this.policy.effective(dept, meta, [...new Set(this.skillsFor(actor).flatMap((s) => s.tools))]) : meta;
  }
}
