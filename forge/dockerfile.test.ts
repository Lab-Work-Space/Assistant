import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (p: string): string => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const strip = (s: string): string => s.replace(/^\s*#.*$/gm, '');

describe('R7 docker/forge/base.Dockerfile (spec 7.2 BE1, PF-C23)', () => {
  const df = strip(read('docker/forge/base.Dockerfile'));
  it('is the same Node digest as the ws runner image, in full', () => {
    const digest = /^FROM node:24-alpine@(sha256:[0-9a-f]{64})$/m.exec(df)?.[1];
    expect(digest).toBeDefined();
    expect(strip(read('docker/ws/runner.Dockerfile'))).toContain(`FROM node:24-alpine@${digest}`);
  });
  it('patches zlib, removes npm, npx, corepack and yarn, and makes /srv/plugin', () => {
    expect(df).toContain('RUN apk upgrade --no-cache zlib');
    for (const p of ['/usr/local/lib/node_modules/npm', '/usr/local/lib/node_modules/corepack', '/usr/local/bin/npm', '/usr/local/bin/npx', '/usr/local/bin/corepack', '/usr/local/bin/yarn', '/usr/local/bin/yarnpkg']) expect(df, p).toContain(p);
    expect(df).toContain('/opt/yarn*');
    expect(df).toContain('mkdir -p /srv/plugin');
  });
  it('has no VOLUME, USER, ENTRYPOINT, CMD, EXPOSE, HEALTHCHECK, ONBUILD, LABEL, ARG or COPY/ADD (the commit sets what a plugin image needs)', () => {
    for (const k of ['VOLUME', 'USER', 'ENTRYPOINT', 'CMD', 'EXPOSE', 'HEALTHCHECK', 'ONBUILD', 'LABEL', 'ARG', 'COPY', 'ADD', 'WORKDIR', 'ENV', 'SHELL', 'STOPSIGNAL']) expect(df, k).not.toMatch(new RegExp(`^\\s*${k}\\b`, 'mi'));
  });
  it('the docker ignore file excludes the whole build context', () => {
    expect(read('docker/forge/base.Dockerfile.dockerignore').trim()).toBe('*');
  });
  it('build.sh is the only writer of images.json and checks the id shape; set -euo pipefail', () => {
    const sh = read('docker/forge/build.sh');
    expect(sh).toContain('set -euo pipefail');
    expect(sh).toContain('docker/forge/images.json');
    expect(sh).toContain('{"base":"%s"}');
    expect(sh).toContain('sha256:[0-9a-f]');
    expect(sh).not.toMatch(/docker (run|push|login)/);
  });
});
