import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

/** WS-C4: an allowlist test of docker-compose.ws.yml (global rule 25). Any key not named here fails the test. */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (f: string) => readFileSync(join(ROOT, f), 'utf8');
type Svc = Record<string, unknown>;
const doc = parse(read('docker-compose.ws.yml')) as { name: string; services: Record<string, Svc>; networks: Record<string, Record<string, unknown>> };

describe('docker-compose.ws.yml allowlist (WS-C4)', () => {
  it('has exactly one service, registryproxy, and exactly the allowed keys', () => {
    expect(Object.keys(doc.services)).toEqual(['registryproxy']);
    const s = doc.services.registryproxy!;
    const allowed = ['image', 'init', 'user', 'read_only', 'cap_drop', 'security_opt', 'pids_limit', 'mem_limit', 'cpus', 'tmpfs', 'restart', 'healthcheck', 'networks'];
    expect(Object.keys(s).filter((k) => !allowed.includes(k))).toEqual([]);
    for (const bad of ['ports', 'env_file', 'secrets', 'volumes', 'extra_hosts', 'network_mode', 'privileged', 'environment', 'cap_add', 'devices', 'pid', 'ipc', 'expose', 'command', 'entrypoint', 'build', 'volumes_from', 'userns_mode', 'dns']) expect(s, bad).not.toHaveProperty(bad);
  });
  it('is hardened like the devjob registryproxy', () => {
    const s = doc.services.registryproxy!;
    expect(s.user).toBe('65534:65534');
    expect(s.read_only).toBe(true);
    expect(s.cap_drop).toEqual(['ALL']);
    expect(s.security_opt).toEqual(['no-new-privileges:true']);
    expect(typeof s.pids_limit).toBe('number');
    expect(s.mem_limit).toBeTruthy();
    expect(s.cpus).toBeTruthy();
    expect(s.tmpfs).toEqual([expect.stringMatching(/^\/tmp:.*noexec/)]);
    expect(s.tmpfs).toEqual([expect.stringMatching(/nosuid/)]);
  });
  it('ws_prepnet is internal on 10.88.80.0/24, which no other compose file uses; the proxy has the fixed address', () => {
    expect(doc.networks.prepnet).toMatchObject({ name: 'ws_prepnet', internal: true });
    expect(JSON.stringify(doc.networks.prepnet)).toContain('10.88.80.0/24');
    expect(doc.networks['egress-registry']).not.toHaveProperty('internal', true);
    expect(JSON.stringify(doc.services.registryproxy!.networks)).toContain('10.88.80.2');
    for (const f of ['docker-compose.devjob.yml', 'docker-compose.chrome.yml', 'docker-compose.render.yml', 'docker-compose.media.yml', 'docker-compose.test.yml', 'docker-compose.yml']) {
      let t = '';
      try { t = read(f); } catch { continue; }
      expect(t, f).not.toContain('10.88.80.');
    }
  });
  it('UPSTREAM_URL / UPSTREAM_ALLOW_HTTP are not set anywhere in the compose file or the proxy Dockerfile', () => {
    for (const f of ['docker-compose.ws.yml', 'docker/ws/registryproxy.Dockerfile']) expect(read(f), f).not.toMatch(/UPSTREAM_(URL|ALLOW_HTTP)\s*[=:]\s*\S/);
  });
});
