import type { ForgeRepo } from '../db/repos/forge.js';
import { BUILDS_PER_DAY, BUILDS_PER_FORGE, IMAGES_KEPT_MAX } from './caps.js';
import { makeForgeEnqueue } from './enqueue.js';
import type { ForgeRequestPort } from './types.js';

/**
 * R7 PLUGIN-FORGE (spec 3.3, 5.3): what `ReleaseService` gets of the forge, built in app.ts over `ForgeRepo` and the live switches. Plain closures: no repo, no service, nothing that builds, stages or installs
 * except the `enqueue` closure, which only inserts an inert build row from bytes the caller has already pinned (PF-C13: only the release target deps hold it).
 */
export function makeForgeRequestPort(d: {
  repo: Pick<ForgeRepo, 'forgeOfProject' | 'counts' | 'slugTaken' | 'byId' | 'enqueue'>;
  enabled: () => unknown;
  mcpEnabled: () => unknown;
  baseId: string | null;
  secrets: () => readonly string[];
}): ForgeRequestPort {
  const { repo } = d;
  return {
    enabled: () => d.enabled(),
    mcpEnabled: () => d.mcpEnabled(),
    baseId: d.baseId,
    forgeOf: (projectId) => repo.forgeOfProject(projectId),
    capCode: async (forgeId, tz) => capCodeOf(await repo.counts(forgeId, tz)),
    slugTaken: (slug, forgeId) => repo.slugTaken(slug, forgeId),
    enqueue: makeForgeEnqueue({ repo, secrets: d.secrets }),
  };
}

function capCodeOf(c: { forgeBuilds: number; today: number; images: number }): 'forge_attempts' | 'forge_day_cap' | 'image_cap' | null {
  if (c.forgeBuilds >= BUILDS_PER_FORGE) return 'forge_attempts';
  if (c.today >= BUILDS_PER_DAY) return 'forge_day_cap';
  if (c.images >= IMAGES_KEPT_MAX) return 'image_cap';
  return null;
}
