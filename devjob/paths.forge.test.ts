import { describe, expect, it } from 'vitest';
import { NON_SELF_MODIFIABLE, isNonSelfModifiable } from './paths.js';

/** R7 PLUGIN-FORGE BE2 (spec 6, PF-C13, FG-AC22): the forge guarantee, the forbidden-key list, the settings keys and the idea link cannot be edited by a dev job. */
describe('FG-AC22: NON_SELF_MODIFIABLE holds the forge paths', () => {
  it('the named entries are in the list', () => {
    for (const p of ['forge/', 'docker/forge/', 'db/repos/forge.ts', 'tests/fixtures/forge/', 'discord/commands/forge.ts', 'discord/commands/types.ts', 'admin/keys.ts', 'governance/projects.ts', 'db/repos/dept-incidents.ts', 'grow/incidents.ts']) expect(NON_SELF_MODIFIABLE, p).toContain(p);
  });
  it.each([
    'forge/service.ts', 'forge/builder.ts', 'forge/boundary.test.ts', 'FORGE/Validate.ts', 'docker/forge/base.Dockerfile', 'docker/forge/images.json', 'db/repos/forge.ts', 'db/repos/forge.int.test.ts',
    'tests/fixtures/forge/hello/server.mjs', 'discord/commands/forge.ts', 'discord/commands/types.ts', 'admin/keys.ts', 'governance/projects.ts', 'db/repos/dept-incidents.ts', 'grow/incidents.ts',
  ])('%s is refused', (p) => {
    expect(isNonSelfModifiable(p)).toBe(true);
  });
  it('G2-FG-04: the files that enforce and store the idea taint the forge relies on (GW-C24) are refused too: the link check, the idea service and the idea insert', () => {
    for (const p of ['db/repos/projects.ts', 'grow/tool-ideas.ts', 'db/repos/grow.ts']) {
      expect(NON_SELF_MODIFIABLE, p).toContain(p);
      expect(isNonSelfModifiable(p), p).toBe(true);
    }
  });
  it('a sibling that is not part of the guarantee stays editable', () => {
    expect(isNonSelfModifiable('discord/commands/provider.ts')).toBe(false);
    expect(isNonSelfModifiable('db/repos/forgex.ts')).toBe(false);
    expect(isNonSelfModifiable('forgery/x.ts')).toBe(false);
  });
});
