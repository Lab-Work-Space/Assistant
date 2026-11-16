import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SKILL_ID_RE } from './limits.js';
import { renderSkillsSection, sectionBytes, type SkillBody } from './render.js';
import { SEED_SKILLS } from './seed-data.js';
import { validateDraft } from './validate.js';

const DEPTS = ['hq', 'software', 'rnd', 'it', 'ops', 'sales', 'hr', 'finance', 'marketing'];
const toBody = (s: (typeof SEED_SKILLS)[number]): SkillBody => ({ id: s.id, version: 1, title: s.title, instructions: s.instructions, templates: s.templates ?? [] });
const text = (s: (typeof SEED_SKILLS)[number]): string => [s.title, s.instructions, ...(s.templates ?? []).flatMap((t) => [t.name, t.body])].join('\n');
function frontmatterTools(dept: string): string[] {
  const src = readFileSync(new URL(`../prompts/heads/${dept}.md`, import.meta.url), 'utf8');
  const m = /^tools:\s*\[([^\]]*)\]/m.exec(src);
  return (m?.[1] ?? '').split(',').map((x) => x.trim()).filter(Boolean);
}

describe('seed skills', () => {
  it('covers exactly the nine departments, at most two each, with unique ids', () => {
    expect([...new Set(SEED_SKILLS.map((s) => s.dept))].sort()).toEqual([...DEPTS].sort());
    for (const d of DEPTS) expect(SEED_SKILLS.filter((s) => s.dept === d).length).toBeGreaterThanOrEqual(1);
    for (const d of DEPTS) expect(SEED_SKILLS.filter((s) => s.dept === d).length).toBeLessThanOrEqual(2);
    expect(new Set(SEED_SKILLS.map((s) => s.id)).size).toBe(SEED_SKILLS.length);
  });

  it.each(SEED_SKILLS.map((s) => [s.id, s] as const))('%s: id, limits and draft validation', (_id, s) => {
    expect(SKILL_ID_RE.test(s.id)).toBe(true);
    expect(s.id.startsWith(`${s.dept}-`)).toBe(true);
    expect(s.title.length).toBeLessThanOrEqual(80);
    expect(s.instructions.length).toBeGreaterThanOrEqual(200);
    expect(s.instructions.length).toBeLessThanOrEqual(1200);
    expect((s.templates ?? []).length).toBeLessThanOrEqual(1);
    for (const t of s.templates ?? []) expect(t.body.length).toBeLessThanOrEqual(600);
    const v = validateDraft({ title: s.title, instructions: s.instructions, templates: s.templates ?? [], tools: [] }, { id: s.id, version: 1 });
    expect(v, JSON.stringify(v)).toMatchObject({ ok: true });
  });

  it.each(SEED_SKILLS.map((s) => [s.id, s] as const))('%s: no URL, no at sign, only own-department tool names', (_id, s) => {
    const t = text(s);
    expect(t).not.toMatch(/https?:|www\.|\.(com|org|net|io)\b|@/i);
    const tools = new Set(frontmatterTools(s.dept));
    expect(tools.size).toBeGreaterThan(0);
    for (const w of t.match(/\b[a-z]+(?:_[a-z]+)+\b/g) ?? []) expect(tools.has(w), `${s.id} mentions ${w}`).toBe(true);
  });

  it.each(DEPTS)('%s: rendered bytes stay within 3000', (d) => {
    const bodies = SEED_SKILLS.filter((s) => s.dept === d).map(toBody);
    expect(sectionBytes(bodies)).toBeLessThanOrEqual(3000);
    expect(renderSkillsSection(bodies).length).toBeGreaterThan(0);
  });

  it('snapshot: any edit changes the hash on purpose', () => {
    const sha = createHash('sha256').update(JSON.stringify(SEED_SKILLS), 'utf8').digest('hex');
    expect(sha).toBe('c8e413252ca65a51baff2f6a73d5a3fb82e4c0cd06b053d0fd3f22b66c713e11');
  });
});
