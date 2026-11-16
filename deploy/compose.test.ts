/**
 * deploy/docker-compose.yml (praw media sidecar spec 8, Gate 1 S1/S5/S13): two services from one image. `assistant` (first, the lw
 * main service) gets the platform env; `media` is labelled lw.isolated, holds no secret and is reached only through the unix socket on
 * the `media-ipc` named volume. The parent-repo overlay copy must stay byte-identical.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { ENV_ALLOW } from '../media/main.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FILE = join(ROOT, 'deploy', 'docker-compose.yml');
// The Assistant repo sits inside the Labworkspace parent repo locally; a standalone clone (CI) has no parent copy.
const INFRA_COPY = join(ROOT, '..', 'infra', 'vps', 'files', 'lw-git', 'apps', 'apps-assistant', 'docker-compose.yml');

const text = readFileSync(FILE, 'utf8');
const doc = parse(text) as any;
const assistant = doc.services.assistant;
const media = doc.services.media;
const SOCKET = '/run/media-ipc/media.sock';
const HEALTH = "require('http').get({socketPath:process.env.MEDIA_SOCKET,path:'/v1/health',timeout:4000},r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))";

/** a.b.c.d inside 172.30.0.0/16 (the lw docker pool that nft and pg_hba trust). */
const inLwPool = (cidr: string): boolean => /^172\.30\./.test(cidr);

describe('deploy/docker-compose.yml (spec 8)', () => {
  it('services order is assistant, media', () => {
    expect(Object.keys(doc.services)).toEqual(['assistant', 'media']);
  });

  it('media has labels lw.isolated "true", user 10001:10001, read_only, init, cap_drop ALL, no-new-privileges, mem_limit 384m, pids_limit 64, cpus "1.0", networks [media-egress], no env_file/ports/extra_hosts, environment keys exactly NODE_ENV and MEDIA_SOCKET', () => {
    expect(media.labels).toEqual({ 'lw.isolated': 'true' });
    expect(media.user).toBe('10001:10001');
    expect(media.read_only).toBe(true);
    expect(media.init).toBe(true);
    expect(media.cap_drop).toEqual(['ALL']);
    expect(media.security_opt).toEqual(['no-new-privileges:true']);
    expect(media.mem_limit).toBe('384m');
    expect(media.pids_limit).toBe(64);
    expect(media.cpus).toBe('1.0');
    expect(media.networks).toEqual(['media-egress']);
    for (const k of ['env_file', 'ports', 'extra_hosts', 'expose', 'secrets', 'configs', 'network_mode', 'depends_on', 'build']) {
      expect(media, k).not.toHaveProperty(k);
    }
    expect(Object.keys(media.environment).sort()).toEqual(['MEDIA_SOCKET', 'NODE_ENV']);
    expect(media.environment).toEqual({ NODE_ENV: 'production', MEDIA_SOCKET: SOCKET });
    expect(media.tmpfs).toEqual(['/tmp:size=16m,mode=1777,noexec,nosuid']);
    expect(media.volumes).toEqual(['media-ipc:/run/media-ipc']);
    expect(media.restart).toBe('unless-stopped');
    expect(media.stop_grace_period).toBe('10s');
  });

  it('media command is ["node","dist/media/main.js"] and image equals assistant\'s image', () => {
    expect(media.command).toEqual(['node', 'dist/media/main.js']);
    expect(media.image).toBe('lw-local/apps-assistant:${IMAGE_TAG}');
    expect(media.image).toBe(assistant.image);
  });

  it('media healthcheck GETs /v1/health over the socket (no TCP listener), inside lw timings', () => {
    expect(media.healthcheck.test).toEqual(['CMD', 'node', '-e', HEALTH]);
    expect(media.healthcheck).toMatchObject({ interval: '10s', timeout: '5s', retries: 3, start_period: '15s' });
    expect(media.healthcheck).not.toHaveProperty('start_interval'); // needs Docker Engine 25+; the VPS engine is not pinned
  });

  it('assistant mounts media-ipc read-only and masks /opt/ffmpeg and /opt/yt-dlp with noexec tmpfs', () => {
    expect(assistant.volumes).toContain('media-ipc:/run/media-ipc:ro');
    expect(assistant.volumes).toContain('praw-workspace:/app/data/workspace/praw');
    expect(assistant.volumes.filter((v: string) => v.startsWith('media-ipc:'))).toEqual(['media-ipc:/run/media-ipc:ro']);
    expect(assistant.tmpfs).toEqual([
      '/tmp:size=16m,mode=1777,noexec,nosuid',
      '/opt/ffmpeg:size=4k,mode=0555,noexec,nosuid',
      '/opt/yt-dlp:size=4k,mode=0555,noexec,nosuid',
    ]);
    expect(assistant.environment.MEDIA_SOCKET).toBe(SOCKET);
    expect(assistant.environment.MEDIA_SOCKET).toBe(media.environment.MEDIA_SOCKET);
  });

  it('assistant depends_on media service_healthy', () => {
    expect(assistant.depends_on).toEqual({ media: { condition: 'service_healthy' } });
  });

  it('assistant keeps its own settings (health port on host loopback, uid 1000, limits)', () => {
    expect(assistant.ports).toEqual(['127.0.0.1:${PORT}:8080']);
    expect(assistant.user).toBe('1000:1000');
    expect(assistant).toMatchObject({ init: true, read_only: true, mem_limit: '512m', pids_limit: 128, restart: 'unless-stopped' });
    expect(assistant).not.toHaveProperty('labels');
    expect(assistant).not.toHaveProperty('networks'); // implicit `default` only: never on media-egress
  });

  it('every media environment key is in ENV_ALLOW', () => {
    for (const k of Object.keys(media.environment)) expect(ENV_ALLOW, k).toContain(k);
  });

  it('media-ipc is a plain named volume (no driver_opts)', () => {
    expect(doc.volumes).toEqual({ 'praw-workspace': {}, 'media-ipc': {} });
  });

  it('S5/S13: media-egress is media-only, a bridge on a subnet outside 172.30.0.0/16 (nft and pg_hba trust only that pool)', () => {
    expect(Object.keys(doc.networks)).toEqual(['media-egress']);
    const n = doc.networks['media-egress'];
    expect(n).not.toHaveProperty('driver');
    expect(n).not.toHaveProperty('driver_opts');
    expect(n).not.toHaveProperty('external');
    expect(n).not.toHaveProperty('internal'); // yt-dlp needs outbound HTTPS
    const subnets = (n.ipam.config as { subnet: string }[]).map((c) => c.subnet);
    expect(subnets).toEqual(['10.213.0.0/24']);
    for (const s of subnets) expect(inLwPool(s), s).toBe(false);
    const on = Object.entries(doc.services).filter(([, s]) => JSON.stringify((s as { networks?: unknown }).networks ?? []).includes('media-egress'));
    expect(on.map(([k]) => k)).toEqual(['media']);
  });

  it('header comment names both services and says media holds no secrets', () => {
    const head = text.split('\nservices:')[0]!;
    expect(head).toMatch(/two services/i);
    expect(head).toContain('lw.isolated');
    expect(head).toMatch(/media.*no secrets?/i);
  });

  it('the final image stage clears the base docker-entrypoint.sh (its shell adds SHLVL/PWD, which media refuses with 78)', () => {
    // media sets only `command`, so it runs through the image ENTRYPOINT. node:22-alpine's is a /bin/sh script whose exec hands
    // SHLVL and PWD to node: keys outside ENV_ALLOW, so media would exit 78 and never turn healthy (found by Task 8 acceptance).
    expect(media.entrypoint).toBeUndefined();
    const df = readFileSync(join(ROOT, 'deploy', 'Dockerfile'), 'utf8');
    const final = df.slice(df.lastIndexOf('\nFROM '));
    const ep = final.search(/^ENTRYPOINT \[\]$/m);
    const cmd = final.search(/^CMD \["node", "dist\/main\.js"\]$/m);
    expect(ep, 'ENTRYPOINT [] in the final stage').toBeGreaterThan(0);
    expect(cmd).toBeGreaterThan(ep); // CMD restated after ENTRYPOINT (an ENTRYPOINT resets only a CMD inherited from the base image)
  });

  it.skipIf(!existsSync(INFRA_COPY))('the parent-repo overlay copy is byte-identical', () => {
    expect(readFileSync(INFRA_COPY).equals(readFileSync(FILE))).toBe(true);
  });
});
