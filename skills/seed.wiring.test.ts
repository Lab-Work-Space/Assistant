import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const walk = (d: string): string[] => readdirSync(d).flatMap((n) => {
  if (n === 'node_modules' || n === 'dist' || n === 'vendor' || n.startsWith('.')) return [];
  const p = join(d, n);
  return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') && !/\.test\.ts$/.test(p) ? [p] : [];
});

describe('LL-C10: the SkillOp seed field is built only by the seeder', () => {
  it('`seed:` appears in no non-test source file except skills/seed.ts (and the type in service.ts)', () => {
    const hits = walk(ROOT).filter((f) => /\bseed\??\s*:\s*\{/.test(readFileSync(f, 'utf8'))).map((f) => relative(ROOT, f)).sort();
    expect(hits).toEqual(['skills/seed.ts', 'skills/service.ts']);
    expect(readFileSync(join(ROOT, 'skills/service.ts'), 'utf8').match(/\bseed\??\s*:\s*\{/g)).toHaveLength(1); // the type member only
  });
  it('no /skill schema or modal accepts a seed key, and plans.ts builds explicit literals', () => {
    for (const f of ['skills/plans.ts', 'skills/card.ts', 'skills/types.ts']) expect(readFileSync(join(ROOT, f), 'utf8')).not.toMatch(/\bseed\b/);
    const app = readFileSync(join(ROOT, 'app.ts'), 'utf8');
    expect(app).toContain('await seedSkills(skillService, SEED_SKILLS, cfg, log)');
  });
});
