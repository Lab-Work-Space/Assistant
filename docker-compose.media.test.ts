import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

/** Static checks of the local media sidecar definition (Gate 1 LM1, LM5-LM7, LM9). */
type Svc = Record<string, any>;
const text = readFileSync(new URL('./docker-compose.media.yml', import.meta.url), 'utf8');
const doc = parse(text) as { name: string; services: Record<string, Svc>; networks: Record<string, { internal?: boolean }>; volumes: Record<string, unknown> };
const prod = (parse(readFileSync(new URL('./deploy/docker-compose.yml', import.meta.url), 'utf8')) as any).services.media as Svc;
const { media, mediarelay: relay } = doc.services as { media: Svc; mediarelay: Svc };

describe('docker-compose.media.yml', () => {
  it('is named assistant-media with exactly the two services', () => {
    expect(doc.name).toBe('assistant-media');
    expect(Object.keys(doc.services)).toEqual(['media', 'mediarelay']);
    expect(media.image).toBe('assistant-media:local');
    expect(relay.image).toBe('assistant-media:local');
  });

  it('LM6: publishes exactly 127.0.0.1:9225:9225 from mediarelay and nothing from media', () => {
    expect(relay.ports).toEqual(['127.0.0.1:9225:9225']);
    expect(media.ports).toBeUndefined();
    expect(text).not.toMatch(/0\.0\.0\.0/);
    expect(text).not.toMatch(/^\s*-\s*["']?\d+(:\d+)?["']?\s*$/m); // no bare port mapping
  });

  it('LM6: media and mediarelay share no network', () => {
    expect(media.networks).toEqual(['media-egress']);
    expect(relay.networks).toEqual(['media-relay']);
    expect(media.networks).not.toContain('media-relay');
    expect(doc.networks['media-relay']!.internal).not.toBe(true); // publishing needs a gateway (documented residual)
  });

  it('media: the production hardening of deploy/docker-compose.yml, copied', () => {
    for (const k of ['command', 'user', 'init', 'read_only', 'tmpfs', 'mem_limit', 'pids_limit', 'cpus', 'cap_drop', 'security_opt', 'stop_grace_period', 'healthcheck'])
      expect(media[k], k).toEqual(prod[k]);
    expect(media.environment).toEqual(prod.environment);
    expect(media.volumes).toEqual(['media-ipc:/run/media-ipc']);
  });

  it('LM7: mediarelay runs as another uid, read-only, no capabilities, media-ipc read-only, the same limits', () => {
    expect(relay.user).toBe('10002:10002');
    expect(relay.user).not.toMatch(/^10001/);
    expect(relay.read_only).toBe(true);
    expect(relay.init).toBe(true);
    expect(relay.cap_drop).toEqual(['ALL']);
    expect(relay.security_opt).toContain('no-new-privileges:true');
    expect(relay.tmpfs).toEqual(media.tmpfs);
    expect(relay.volumes).toEqual(['media-ipc:/run/media-ipc:ro']);
    expect(relay.command).toEqual(['node', 'dist/media/relay-container.js']);
    for (const k of ['mem_limit', 'pids_limit', 'cpus']) expect(relay[k], k).toEqual(media[k]);
  });

  it('LM1/LM3: env keys are exact; the token is required from the launcher, never a literal; no env file anywhere', () => {
    expect(Object.keys(media.environment).sort()).toEqual(['MEDIA_SOCKET', 'NODE_ENV']);
    expect(Object.keys(relay.environment).sort()).toEqual(['MEDIA_RELAY_TOKEN', 'MEDIA_SOCKET', 'NODE_ENV']);
    expect(relay.environment.MEDIA_RELAY_TOKEN).toMatch(/^\$\{MEDIA_RELAY_TOKEN:\?/);
    expect(relay.environment.MEDIA_SOCKET).toBe('/run/media-ipc/media.sock');
    expect(media.env_file).toBeUndefined();
    expect(relay.env_file).toBeUndefined();
    expect(text).toMatch(/not given the env file/);
    expect(text).not.toMatch(/YTDLP_COOKIES_FILE/);
  });

  it('shares only the media-ipc named volume and has no host bind mounts', () => {
    expect(Object.keys(doc.volumes)).toEqual(['media-ipc']);
    for (const s of [media, relay]) for (const v of s.volumes as string[]) expect(v.startsWith('media-ipc:')).toBe(true);
  });
});
