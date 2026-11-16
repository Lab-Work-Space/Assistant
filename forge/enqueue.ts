import { createHash } from 'node:crypto';
import type { ForgeRepo } from '../db/repos/forge.js';
import type { ForgeEnqueue } from './types.js';
import { validatePlugin } from './validate.js';

/**
 * R7 PLUGIN-FORGE (spec 3.4 step 1, PF-C11, PF-C13): the enqueue closure of the `install_plugin` release target. It re-proves the pinned bytes (the size and sha256 against the claim, then `validatePlugin`
 * with the idea of the forge row and the manifest hash against the release's), then inserts the inert build row. Held by the release target deps only (a wiring test pins the holders). It never throws:
 * invalid bytes are `plugin_invalid` (the service closes the release `failed`, never reverts it); anything else, including a conflicting build row, is `exception` (nothing was built, the release reverts to pending).
 * The build is inert until its release is `released`: the builder takes only those, and the reconcile cancels the rest.
 */
export function makeForgeEnqueue(d: { repo: Pick<ForgeRepo, 'byId' | 'enqueue'>; secrets: () => readonly string[] }): ForgeEnqueue {
  return async (b) => {
    try {
      const forge = await d.repo.byId(b.forgeId);
      if (!forge) return { ok: false, code: 'exception' };
      if (b.zip.length !== b.bytes || createHash('sha256').update(b.zip).digest('hex') !== b.sha256) return { ok: false, code: 'plugin_invalid' };
      const v = validatePlugin(b.zip, { forgeIdeaId: forge.ideaId, secrets: [...d.secrets()] });
      if (!v.ok || v.info.manifestSha256 !== b.manifestSha256 || v.info.forge.slug !== b.pluginSlug) return { ok: false, code: 'plugin_invalid' };
      const r = await d.repo.enqueue(b);
      return r.ok ? { ok: true } : { ok: false, code: 'exception' };
    } catch {
      return { ok: false, code: 'exception' };
    }
  };
}
