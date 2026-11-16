import type { SkillView } from './render.js';
import type { SkillSnapshot } from './types.js';

/**
 * SK11: the active skills of one actor, deterministic: department skills first, then persona skills; each by priority ascending, then id.
 * A head passes no persona (department skills only). A skill attached at both levels appears once, at the department level. Disabled and
 * archived skills are excluded. The Org cache and the write-time budget checks both use this, so what is checked is what is injected.
 */
export function selectSkills(snap: SkillSnapshot, who: { dept: string; personaId?: string }): SkillView[] {
  const skills = new Map(snap.skills.map((s) => [s.id, s]));
  const scopes: { kind: 'dept' | 'persona'; id: string }[] = [{ kind: 'dept', id: who.dept }, ...(who.personaId ? [{ kind: 'persona' as const, id: who.personaId }] : [])];
  const out: SkillView[] = [];
  const seen = new Set<string>();
  for (const sc of scopes) {
    const rows = snap.attachments
      .filter((a) => a.targetKind === sc.kind && a.targetId === sc.id)
      .sort((a, b) => a.priority - b.priority || (a.skillId < b.skillId ? -1 : a.skillId > b.skillId ? 1 : 0));
    for (const a of rows) {
      const s = skills.get(a.skillId);
      if (!s || s.status !== 'active' || seen.has(s.id)) continue;
      seen.add(s.id);
      out.push({ id: s.id, version: s.activeVersion, title: s.title, instructions: s.instructions, templates: s.templates, tools: s.tools, priority: a.priority, scope: sc.kind });
    }
  }
  return out;
}
