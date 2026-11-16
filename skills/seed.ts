import type { ConfigStore } from '../config/store.js';
import type { SeedSkill } from './seed-data.js';
import { SkillRefused, type SkillService } from './service.js';

/**
 * LEARN-1 R3: inserts the starter skills once. This file is the ONLY place that builds a SkillOp with `seed:` (a wiring test pins it).
 * A row in any status (active, disabled, archived) is never recreated. A refusal is audited by the service (skill.seed refused:<code>) and
 * the next seed still runs. Never throws. `tools` is always [] from code: SeedSkill has no tools field.
 */
export async function seedSkills(
  svc: SkillService, defs: readonly SeedSkill[], cfg: Pick<ConfigStore, 'get'>, log: { error(o: unknown, m?: string): void },
): Promise<{ created: number; skipped: number; refused: number }> {
  const out = { created: 0, skipped: 0, refused: 0 };
  try {
    if (cfg.get('skills.seed.enabled') !== true) return out;
  } catch { return out; } // a read error counts as off
  for (const def of defs) {
    try {
      if (await svc.repo.get(def.id)) { out.skipped++; continue; }
      await svc.run({
        op: 'create', id: def.id,
        draft: { title: def.title, instructions: def.instructions, templates: def.templates ?? [], tools: [] },
        attach: { kind: 'dept', id: def.dept },
        seed: { ownerDept: def.dept },
      }, 'system:seed');
      out.created++;
    } catch (err) {
      if (err instanceof SkillRefused) out.refused++;
      else { out.refused++; log.error({ errName: err instanceof Error ? err.name : 'error', id: def.id }, 'seed skill failed'); }
    }
  }
  return out;
}
