import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { FONT_PINS, readPinnedFont, sha256, FontError } from './tools/plugins/docs/fonts.js';

/** Static checks of the document renderer's container definition (Gate 1 RF15, RF16). */
type Svc = Record<string, unknown> & { command?: string[]; environment?: Record<string, string>; networks?: Record<string, unknown> };
const doc = parse(readFileSync(new URL('./docker-compose.render.yml', import.meta.url), 'utf8')) as { name: string; services: Record<string, Svc>; networks: Record<string, { internal?: boolean; ipam?: { config: { subnet: string }[] } }> };
const chromeDoc = parse(readFileSync(new URL('./docker-compose.chrome.yml', import.meta.url), 'utf8')) as { services: Record<string, Svc>; networks: Record<string, { ipam?: { config: { subnet: string }[] } }> };
const renderer = doc.services.renderer!;
const fwd = doc.services.renderfwd!;
const argv = (renderer.command ?? []).join(' ');
const text = readFileSync(new URL('./docker-compose.render.yml', import.meta.url), 'utf8');

describe('RF15 docker-compose.render.yml', () => {
  it('RF15: it is a separate project from the web Chrome (its own name, subnet, networks, ports and container names)', () => {
    expect(doc.name).toBe('assistant-render');
    expect(doc.name).not.toBe('assistant-chrome');
    expect(doc.networks.internal!.ipam!.config[0]!.subnet).not.toBe(chromeDoc.networks.internal!.ipam!.config[0]!.subnet);
    expect(Object.keys(doc.services).sort()).toEqual(['renderer', 'renderfwd']);
    expect(fwd.ports).toEqual(['127.0.0.1:9224:9224']);
    expect(JSON.stringify(chromeDoc.services.guardproxy!.ports)).not.toContain('9224');
  });

  it('RF15: the renderer has ONLY the internal (no gateway) network, no proxy container, nothing published, no env file, no mounts, only HOME in its env', () => {
    expect(Object.keys(renderer.networks ?? {})).toEqual(['internal']);
    expect(doc.networks.internal!.internal).toBe(true);
    expect(renderer.ports).toBeUndefined();
    expect(renderer.volumes).toBeUndefined();
    expect(renderer.env_file).toBeUndefined();
    expect(Object.keys(renderer.environment ?? {})).toEqual(['HOME']);
    expect(text).not.toMatch(/guardproxy|egress|CHROME_ACCESS_TOKEN|proxy\.Dockerfile/);
  });

  it('RF15: hardened like the web Chrome: same pinned image digest, nobody, read-only, cap_drop ALL, seccomp, no-new-privileges, tmpfs, limits', () => {
    const web = chromeDoc.services.chrome!;
    expect(renderer.image).toMatch(/@sha256:[0-9a-f]{64}$/);
    expect(renderer.image).toBe(web.image); // bumped together
    expect(renderer.user).toBe('65534:65534');
    expect(renderer.read_only).toBe(true);
    expect(renderer.cap_drop).toEqual(['ALL']);
    expect(renderer.security_opt).toEqual(web.security_opt);
    expect(renderer.pids_limit).toBeGreaterThan(0);
    expect(renderer.mem_limit).toBeDefined();
    expect(renderer.tmpfs).toBeDefined();
    for (const f of ['--no-sandbox', '--disable-setuid-sandbox', '--single-process', '--no-zygote', '--disable-web-security', '--remote-debugging-address', '--host-resolver-rules']) expect(argv, f).not.toContain(f);
    for (const f of ['--disable-quic', '--disable-extensions', '--disable-background-networking', '--no-first-run', '--use-mock-keychain', '--user-data-dir=/tmp/profile']) expect(argv, f).toContain(f);
  });

  it('RF15: even a request that found a route would fail: the proxy flags point at a dead loopback port and loopback is not bypassed', () => {
    expect(argv).toContain('--proxy-server=http://127.0.0.1:1');
    expect(argv).toContain("'--proxy-bypass-list=<-loopback>'");
    expect(argv).not.toMatch(/10\.88\.77\./);
  });

  it('RF15: the forwarder runs no proxy: only the forwarder entry is built, it needs the per-boot token, refuses the renderer\'s network, and is the only service with a second network (for publishing)', () => {
    expect(fwd.environment!.ACCESS_TOKEN).toMatch(/RENDER_ACCESS_TOKEN/);
    expect(fwd.environment!.INTERNAL_CIDR).toBe(doc.networks.internal!.ipam!.config[0]!.subnet);
    expect(Object.keys(fwd.networks ?? {}).sort()).toEqual(['hostside', 'internal']);
    expect(doc.networks.hostside!.internal).not.toBe(true);
    expect(fwd.read_only).toBe(true);
    expect(fwd.cap_drop).toEqual(['ALL']);
    const df = readFileSync(new URL('./docker/render/forwarder.Dockerfile', import.meta.url), 'utf8');
    expect(df).toMatch(/^FROM \S+@sha256:[0-9a-f]{64}$/m);
    expect(df).toContain('forwarder-main.js');
    expect(df).not.toMatch(/proxy-main|fetch\.js|address\.js/);
    const main = readFileSync(new URL('./net/forwarder-main.ts', import.meta.url), 'utf8');
    expect(main).toContain('createForwarder');
    expect(main).not.toMatch(/createGuardProxy|createControlServer|createCheckTarget/);
    expect(main).toMatch(/ACCESS_TOKEN/);
  });

  it('RF15: scripts/dev.sh starts it (render up|down), mints the per-boot token in memory and passes only RENDER_* to the app child', () => {
    const sh = readFileSync(new URL('./scripts/dev.sh', import.meta.url), 'utf8');
    expect(sh).toContain('docker-compose.render.yml');
    expect(sh).toMatch(/RENDER_ACCESS_TOKEN=\$\(od -An -tx1 -N24 \/dev\/urandom/);
    expect(sh).toContain('RENDER_CDP_URL=http://127.0.0.1:9224');
    expect(sh).toContain('assistant-render-renderfwd-1');
    const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { scripts: Record<string, string> };
    expect(pkg.scripts['local:render']).toBe('bash scripts/dev.sh render up');
    expect(pkg.scripts['local:render:down']).toBe('bash scripts/dev.sh render down');
    expect(pkg.scripts.build).toContain('cp -R vendor dist/'); // the fonts reach dist/
  });
});

describe('RF16 vendored fonts', () => {
  it('RF16: each vendored font file matches its sha256 pin (and the SHA256SUMS file); a changed file fails closed', () => {
    const sums = readFileSync(new URL('./vendor/fonts/SHA256SUMS', import.meta.url), 'utf8');
    for (const [name, pin] of Object.entries(FONT_PINS)) {
      expect(sha256(readPinnedFont(name))).toBe(pin);
      expect(sums).toContain(`${pin}  ${name}`);
    }
    expect(() => readPinnedFont('Sarabun-Regular.ttf', new URL('./tools/plugins/docs/', import.meta.url))).toThrow(FontError); // wrong folder: missing
    expect(() => readPinnedFont('Other.ttf')).toThrow(FontError);
    const tmp = mkdtempSync(join(tmpdir(), 'fonts-'));
    cpSync(new URL('./vendor/fonts/', import.meta.url), tmp, { recursive: true });
    writeFileSync(join(tmp, 'Sarabun-Regular.ttf'), Buffer.concat([readFileSync(join(tmp, 'Sarabun-Regular.ttf')), Buffer.from('x')]));
    expect(() => readPinnedFont('Sarabun-Regular.ttf', new URL(`file://${tmp}/`))).toThrow(/sha256 pin/);
    expect(readPinnedFont('Sarabun-Bold.ttf', new URL(`file://${tmp}/`)).length).toBeGreaterThan(1000);
    expect(readFileSync(new URL('./vendor/fonts/OFL.txt', import.meta.url), 'utf8')).toMatch(/SIL Open Font License/);
  });
});
