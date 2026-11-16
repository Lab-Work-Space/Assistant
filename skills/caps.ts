import type { PersonaFact } from '../db/repos/skills.js';
import type { Refusal } from './validate.js';
import { SKILLS_PER_DEPT_TARGET, SKILLS_PER_PERSONA_TARGET, SKILL_ACTOR_BUDGET_BYTES } from './limits.js';
import { sectionBytes } from './render.js';
import { selectSkills } from './select.js';
import type { AttachmentRow, SkillRow, SkillSnapshot, SkillTarget } from './types.js';

/** One actor as the prompt sees it: a head (dept only) or a persona (its department's skills plus its own). */
export interface ActorSpec { key: string; dept: string; personaId?: string }

/** Every actor that a change to these targets can reach: a department target reaches its head and all its personas. */
export function affectedActors(personas: readonly PersonaFact[], targets: readonly SkillTarget[]): ActorSpec[] {
  const out = new Map<string, ActorSpec>();
  for (const t of targets) {
    if (t.kind === 'dept') {
      out.set(`head:${t.id}`, { key: `head:${t.id}`, dept: t.id });
      for (const p of personas) if (p.deptId === t.id) out.set(`persona:${p.id}`, { key: `persona:${p.id}`, dept: p.deptId, personaId: p.id });
    } else {
      const p = personas.find((x) => x.id === t.id);
      if (p) out.set(`persona:${p.id}`, { key: `persona:${p.id}`, dept: p.deptId, personaId: p.id });
    }
  }
  return [...out.values()];
}

/** The snapshot as it would be after a change (pure; the caller applies the writes only if the check passes). */
export function applyChange(snap: SkillSnapshot, c: { skill?: SkillRow; addAttachment?: AttachmentRow & {}; removeAttachment?: { skillId: string; targetKind: string; targetId: string } }): SkillSnapshot {
  let skills = snap.skills;
  if (c.skill) skills = [...skills.filter((s) => s.id !== c.skill!.id), c.skill];
  let attachments = snap.attachments;
  if (c.removeAttachment) {
    const r = c.removeAttachment;
    attachments = attachments.filter((a) => !(a.skillId === r.skillId && a.targetKind === r.targetKind && a.targetId === r.targetId));
  }
  if (c.addAttachment) attachments = [...attachments, c.addAttachment];
  return { skills, attachments };
}

/**
 * Per-target caps (6 skills on a department target, 3 on a persona target) and the per-actor byte budget, evaluated on the snapshot AFTER the change
 * for every actor the change reaches. `budget_exceeded` names the actor with a validated key (department or persona id from the database).
 */
export function checkCaps(after: SkillSnapshot, personas: readonly PersonaFact[], targets: readonly SkillTarget[]): Refusal | null {
  for (const t of targets) {
    const n = after.attachments.filter((a) => a.targetKind === t.kind && a.targetId === t.id).length;
    if (n > (t.kind === 'dept' ? SKILLS_PER_DEPT_TARGET : SKILLS_PER_PERSONA_TARGET)) return { ok: false, code: 'per_target_cap', detail: `${t.kind}:${t.id}` };
  }
  for (const a of affectedActors(personas, targets)) {
    if (sectionBytes(selectSkills(after, { dept: a.dept, ...(a.personaId ? { personaId: a.personaId } : {}) })) > SKILL_ACTOR_BUDGET_BYTES) return { ok: false, code: 'budget_exceeded', detail: a.key };
  }
  return null;
}

/** Tools each reached actor gains from the change (union of its skills' tools, after minus before). */
export function toolDelta(before: SkillSnapshot, after: SkillSnapshot, personas: readonly PersonaFact[], targets: readonly SkillTarget[]): { key: string; dept: string; added: string[] }[] {
  const out: { key: string; dept: string; added: string[] }[] = [];
  const tools = (s: SkillSnapshot, a: ActorSpec) => new Set(selectSkills(s, { dept: a.dept, ...(a.personaId ? { personaId: a.personaId } : {}) }).flatMap((x) => x.tools));
  for (const a of affectedActors(personas, targets)) {
    const b = tools(before, a);
    const added = [...tools(after, a)].filter((t) => !b.has(t)).sort();
    if (added.length) out.push({ key: a.key, dept: a.dept, added });
  }
  return out;
}

export const targetsOf = (atts: readonly AttachmentRow[]): SkillTarget[] => atts.map((a) => ({ kind: a.targetKind, id: a.targetId }));
