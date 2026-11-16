import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

/** Static allowlist checks of the ws stack (Gate 1 WS-C4, global rule 25). */
type Svc = Record<string, unknown>;
const doc = parse(readFileSync(new URL('./docker-compose.ws.yml', import.meta.url), 'utf8')) as { name: string; services: Record<string, Svc>; networks: Record<string, { name?: string; internal?: boolean; ipam?: { config: { subnet: string }[] } }> };
const p = doc.services.registryproxy!;
const FORBIDDEN = ['ports', 'env_file', 'secrets', 'volumes', 'extra_hosts', 'network_mode', 'privileged', 'devices', 'cap_add', 'pid', 'ipc', 'userns_mode', 'build', 'command', 'entrypoint'];

describe('docker-compose.ws.yml', () => {
  it('project assistant-ws with exactly one service, registryproxy', () => {
    expect(doc.name).toBe('assistant-ws');
    expect(Object.keys(doc.services)).toEqual(['registryproxy']);
    expect(p.image).toBe('assistant-ws-registryproxy:local');
  });
  it('the service uses exactly these keys: none of ports, env_file, secrets, volumes, extra_hosts, network_mode, privileged', () => {
    for (const k of FORBIDDEN) expect(p[k], k).toBeUndefined();
    expect(Object.keys(p).sort()).toEqual(['cap_drop', 'cpus', 'healthcheck', 'image', 'init', 'mem_limit', 'networks', 'pids_limit', 'read_only', 'restart', 'security_opt', 'tmpfs', 'user'].sort());
  });
  it('hardening equals the devjob registryproxy', () => {
    expect(p.user).toBe('65534:65534');
    expect(p.read_only).toBe(true);
    expect(p.cap_drop).toEqual(['ALL']);
    expect(p.security_opt).toEqual(['no-new-privileges:true']);
    expect(p.pids_limit).toBe(128);
    expect(p.mem_limit).toBe('256m');
    expect(p.cpus).toBe(1);
    expect(p.tmpfs).toEqual(['/tmp:rw,noexec,nosuid,nodev,size=16m']);
    const dev = parse(readFileSync(new URL('./docker-compose.devjob.yml', import.meta.url), 'utf8')) as { services: Record<string, Svc> };
    const o = dev.services.registryproxy!;
    for (const k of ['user', 'read_only', 'cap_drop', 'security_opt', 'pids_limit', 'mem_limit', 'cpus', 'tmpfs', 'init']) expect(p[k], k).toEqual(o[k]);
  });
  it('no environment at all: UPSTREAM_URL and UPSTREAM_ALLOW_HTTP are absent', () => {
    expect(p.environment).toBeUndefined();
    expect(readFileSync(new URL('./docker-compose.ws.yml', import.meta.url), 'utf8')).not.toMatch(/UPSTREAM_/);
  });
  it('ws_prepnet is internal at 10.88.80.0/24 (no other compose file uses it); the proxy is at .2; ws_egress_registry is a normal network for the proxy only', () => {
    expect(doc.networks.prepnet).toMatchObject({ name: 'ws_prepnet', internal: true, ipam: { config: [{ subnet: '10.88.80.0/24' }] } });
    expect((p.networks as Record<string, { ipv4_address?: string }>).prepnet!.ipv4_address).toBe('10.88.80.2');
    expect(Object.keys(p.networks as object).sort()).toEqual(['egress-registry', 'prepnet']);
    expect(doc.networks['egress-registry']).toEqual({ name: 'ws_egress_registry' });
    for (const f of readdirSync(new URL('.', import.meta.url)).filter((x) => /^docker-compose.*\.yml$/.test(x) && x !== 'docker-compose.ws.yml')) {
      expect(readFileSync(new URL(`./${f}`, import.meta.url), 'utf8'), f).not.toContain('10.88.80.');
    }
  });
  it('the Dockerfiles: node digest pinned, no git, empty ENTRYPOINT, npm patched; the proxy has no npm', () => {
    const run = readFileSync(new URL('./docker/ws/runner.Dockerfile', import.meta.url), 'utf8');
    const prep = readFileSync(new URL('./docker/devjob/prep.Dockerfile', import.meta.url), 'utf8');
    const digest = /^FROM (node:24-alpine@sha256:[0-9a-f]{64})$/m;
    expect(run.match(digest)![1]).toBe(prep.match(digest)![1]);
    expect(run).not.toMatch(/\bgit\b.*(apk|add)|apk add/);
    expect(run).toMatch(/^ENTRYPOINT \[\]$/m);
    expect(run).not.toMatch(/^USER /m);
    expect(run).toContain('ARG NPM_VERSION=12.2.1');
    expect(run).toContain('ARG UNDICI_VERSION=6.29.1');
    expect(run).toMatch(/mkdir -p \/work \/home\/ws && chmod 1777 \/home\/ws/);
    const proxy = readFileSync(new URL('./docker/ws/registryproxy.Dockerfile', import.meta.url), 'utf8');
    expect(proxy).toMatch(/rm -rf \/usr\/local\/lib\/node_modules\/npm .*\/usr\/local\/bin\/npx/);
    expect(proxy).toMatch(/^USER 65534:65534$/m);
    expect(proxy.match(digest)![1]).toBe(prep.match(digest)![1]);
  });
});
