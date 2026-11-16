import type { Org } from '../company/org.js';
import type { Item, Plan } from '../discord/commands/plans.js';
import { PRIORITY_DEFAULT, PRIORITY_MAX, SKILL_ID_RE, TARGET_ID_RE } from './limits.js';
import { chunkForCard } from './card.js';
import { renderBlock, type SkillTemplate } from './render.js';
import type { OpResult, SkillOp, SkillService } from './service.js';
import { SkillRefused } from './service.js';
import type { TargetKind } from './types.js';
import { refusalText, type Draft } from './validate.js';

/** What the skill plans need: the service (absent in tests that predate skills) and the live org for target names. */
export interface SkillPlanDeps {
  skills?: Pick<SkillService, 'preview' | 'run' | 'repo'>;
  org: Pick<Org, 'dept' | 'persona'>;
}

export const parseTarget = (s: string): { kind: TargetKind; id: string } | null => {
  const m = /^(dept|persona):([a-z0-9][a-z0-9-]{0,63})$/.exec(s.trim());
  return m && TARGET_ID_RE.test(m[2]!) ? { kind: m[1] as TargetKind, id: m[2]! } : null;
};
const NO_SKILLS: Plan = { error: 'Skills are not available in this process.' };

/** The tool delta of a preview as card/reply items, grouped by identical tool sets (one line per distinct set, not per persona). */
function toolItems(pre: Extract<OpResult, { ok: true }>): Item[] {
  const groups = new Map<string, string[]>();
  for (const a of pre.added) groups.set(a.added.join(', '), [...(groups.get(a.added.join(', ')) ?? []), a.key]);
  return [...groups].map(([tools, keys]) => ({ label: 'Tools gained', old: '(none)', neu: `${tools} — for ${keys.join(', ')}` }));
}

async function build(op: SkillOp, svc: NonNullable<SkillPlanDeps['skills']>, by: string, before: unknown, items: Item[], audit: string): Promise<Plan> {
  const pre = await svc.preview(op, by);
  if (!pre.ok) return { error: refusalText(pre) };
  return {
    before, items: [...items, ...toolItems(pre)], writes: [],
    // SK9: the write is its own transaction with SQL compare-and-swap; a lost race throws SkillRefused and writes nothing (the console maps it to a refused card).
    run: async () => { await svc.run(op, by); },
    audit: { action: `skill.${audit}`, tool: op.id },
    risk: pre.added.length > 0, // SK14: the effective tool set of some actor grows
  };
}

async function load(skill: string, deps: SkillPlanDeps) {
  if (!deps.skills) return null;
  if (!SKILL_ID_RE.test(skill)) return { ok: false, error: 'Unknown skill.' } as const;
  const row = await deps.skills.repo.get(skill);
  if (!row) return { ok: false, error: 'Unknown skill.' } as const;
  const atts = (await deps.skills.repo.attachments()).filter((a) => a.skillId === skill).map((a) => `${a.targetKind}:${a.targetId}`).sort();
  return { ok: true, row, atts } as const;
}

export async function planSkillAttach(skill: string, targetText: string, priority: number | undefined, deps: SkillPlanDeps, by: string): Promise<Plan> {
  const l = await load(skill, deps);
  if (!l) return NO_SKILLS;
  if (!l.ok) return { error: l.error };
  const t = parseTarget(targetText);
  if (!t || (t.kind === 'dept' ? !deps.org.dept(t.id) : !deps.org.persona(t.id))) return { error: 'The target must be dept:<id> or persona:<id> of an existing department or member.' };
  const p = priority ?? PRIORITY_DEFAULT;
  if (!Number.isInteger(p) || p < 0 || p > PRIORITY_MAX) return { error: `Priority must be a whole number from 0 to ${PRIORITY_MAX}.` };
  return build({ op: 'attach', id: skill, base: l.row.activeVersion, kind: t.kind, target: t.id, priority: p }, deps.skills!, by,
    { skill, version: l.row.activeVersion, status: l.row.status, attached: l.atts }, [{ label: `Attach ${skill} v${l.row.activeVersion}`, old: '(not attached)', neu: `${t.kind}:${t.id}, priority ${p}` }], 'attach');
}

export async function planSkillDetach(skill: string, targetText: string, deps: SkillPlanDeps, by: string): Promise<Plan> {
  const l = await load(skill, deps);
  if (!l) return NO_SKILLS;
  if (!l.ok) return { error: l.error };
  const t = parseTarget(targetText);
  if (!t) return { error: 'The target must be dept:<id> or persona:<id>.' };
  if (!l.atts.includes(`${t.kind}:${t.id}`)) return { error: 'That skill is not attached there.' };
  return build({ op: 'detach', id: skill, kind: t.kind, target: t.id }, deps.skills!, by,
    { skill, version: l.row.activeVersion, attached: l.atts }, [{ label: `Detach ${skill}`, old: `${t.kind}:${t.id}`, neu: '(not attached)' }], 'detach');
}

export async function planSkillToggle(skill: string, enabled: boolean, deps: SkillPlanDeps, by: string): Promise<Plan> {
  const l = await load(skill, deps);
  if (!l) return NO_SKILLS;
  if (!l.ok) return { error: l.error };
  if (l.row.status === 'archived') return { error: refusalText({ code: 'archived' }) };
  const from = l.row.status;
  const to = enabled ? 'active' : 'disabled';
  if (from === to) return { error: refusalText({ code: 'nothing_to_do' }) };
  return build({ op: 'status', id: skill, base: l.row.activeVersion, from, to }, deps.skills!, by,
    { skill, version: l.row.activeVersion, status: from, attached: l.atts }, [{ label: `${enabled ? 'Enable' : 'Disable'} ${skill}`, old: from, neu: to }], enabled ? 'enable' : 'disable');
}

/** SK14: a rollback card shows the full restored text, or the card is refused (the console's render check). */
export async function planSkillRollback(skill: string, version: number, deps: SkillPlanDeps, by: string): Promise<Plan> {
  const l = await load(skill, deps);
  if (!l) return NO_SKILLS;
  if (!l.ok) return { error: l.error };
  if (!Number.isInteger(version) || version < 1) return { error: 'Unknown version.' };
  const old = await deps.skills!.repo.version(skill, version);
  if (!old) return { error: refusalText({ code: 'unknown_version' }) };
  const next = l.row.activeVersion + 1;
  const text = renderBlock({ id: skill, version: next, title: l.row.title, instructions: old.instructions, templates: old.templates });
  const parts = chunkForCard(text);
  const items: Item[] = [
    { label: `Roll back ${skill}`, old: `v${l.row.activeVersion}`, neu: `v${version} restored as v${next}` },
    ...parts.map((p, i) => ({ label: `Restored text (written earlier) ${i + 1}/${parts.length}`, old: '', neu: '', plain: p })),
  ];
  return build({ op: 'rollback', id: skill, base: l.row.activeVersion, to: version }, deps.skills!, by, { skill, version: l.row.activeVersion, to: version, sha: old.bodySha256 }, items, 'rollback');
}

// ---- slash only (Praw has no create or edit op) ----

export async function planSkillCreate(id: string, draft: Draft, attachText: string | null, deps: SkillPlanDeps, by: string): Promise<Plan> {
  if (!deps.skills) return NO_SKILLS;
  if (!SKILL_ID_RE.test(id)) return { error: refusalText({ code: 'bad_id' }) };
  let attach: { kind: TargetKind; id: string } | undefined;
  if (attachText) {
    const t = parseTarget(attachText);
    if (!t) return { error: 'The target must be dept:<id> or persona:<id>.' };
    attach = t;
  }
  return build({ op: 'create', id, draft, ...(attach ? { attach } : {}) }, deps.skills, by, { skill: id, exists: false }, [{ label: `Create ${id}`, old: '(none)', neu: `v1${attach ? `, attached to ${attach.kind}:${attach.id}` : ''}` }], 'create');
}

export async function planSkillEdit(skill: string, base: number, draft: { title: string; instructions: string; templates: SkillTemplate[] }, deps: SkillPlanDeps, by: string): Promise<Plan> {
  const l = await load(skill, deps);
  if (!l) return NO_SKILLS;
  if (!l.ok) return { error: l.error };
  if (!Number.isInteger(base) || base < 1) return { error: 'Unknown version.' };
  return build({ op: 'edit', id: skill, base, draft }, deps.skills!, by, { skill, version: l.row.activeVersion }, [{ label: `Edit ${skill}`, old: `v${base}`, neu: `v${base + 1}` }], 'edit');
}

export async function planSkillTools(skill: string, action: string, tool: string, deps: SkillPlanDeps, by: string): Promise<Plan> {
  const l = await load(skill, deps);
  if (!l) return NO_SKILLS;
  if (!l.ok) return { error: l.error };
  if (action !== 'add' && action !== 'remove') return { error: 'Action must be add or remove.' };
  return build({ op: 'tools', id: skill, base: l.row.activeVersion, action, tool }, deps.skills!, by, { skill, version: l.row.activeVersion, tools: l.row.tools }, [{ label: `Skill ${skill} tools`, old: l.row.tools.join(', ') || '(none)', neu: action === 'add' ? [...l.row.tools, tool].join(', ') : l.row.tools.filter((x) => x !== tool).join(', ') || '(none)' }], action === 'add' ? 'tools.add' : 'tools.remove');
}

export { SkillRefused };
