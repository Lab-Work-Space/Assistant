import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/** R6 BE3: the fixture images stay local, pinned and minimal (no third-party image, no network step, no VOLUME in the good one). Static; Docker is not needed. */
const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'docker', 'mcp');
const read = (f: string): string => readFileSync(join(dir, f), 'utf8');
const code = (f: string): string => read(f).split('\n').filter((l) => !l.startsWith('#')).join('\n');

describe('docker/mcp fixture Dockerfiles', () => {
  it.each(['fixture.Dockerfile', 'fixture-volume.Dockerfile'])('%s: one digest-pinned local base, one COPY of the repo fixture, no network or package step', (f) => {
    const c = code(f);
    expect([...c.matchAll(/^FROM (\S+)/gm)].map((m) => m[1])).toEqual(['node:22-alpine@sha256:fe4f6d74e20370acb04ad889077d14d0f64a9c8ea6a42bc60cddf1e844699914']);
    expect(c).toContain('COPY echo-server.mjs /srv/echo-server.mjs');
    expect(c).not.toMatch(/\b(?:RUN|ADD|curl|wget|apk|npm|http)\b/);
    expect(c).toContain('ENTRYPOINT ["node", "/srv/echo-server.mjs"]');
  });
  it('only the negative-case image declares a VOLUME; the build context is the one fixture file', () => {
    expect(code('fixture.Dockerfile')).not.toMatch(/VOLUME/);
    expect(code('fixture-volume.Dockerfile')).toMatch(/^VOLUME \/data$/m);
    for (const f of ['fixture.Dockerfile.dockerignore', 'fixture-volume.Dockerfile.dockerignore']) expect(read(f)).toBe('*\n!echo-server.mjs\n');
  });
});
