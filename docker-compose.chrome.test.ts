import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

/** Static checks of the Chrome container definition (Gate 1 Part C: C24, C25, C28, C29, C31, C32; owner decision N4). */
type Svc = Record<string, unknown> & { command?: string[]; environment?: Record<string, string>; networks?: Record<string, unknown> };
const doc = parse(readFileSync(new URL('./docker-compose.chrome.yml', import.meta.url), 'utf8')) as { services: Record<string, Svc>; networks: Record<string, { internal?: boolean }> };
const chrome = doc.services.chrome!;
const proxy = doc.services.guardproxy!;
const argv = (chrome.command ?? []).join(' ');

describe('docker-compose.chrome.yml', () => {
  it('pins both images by digest (global rule 21)', () => {
    expect(chrome.image).toMatch(/@sha256:[0-9a-f]{64}$/);
    expect(readFileSync(new URL('./docker/chrome/proxy.Dockerfile', import.meta.url), 'utf8')).toMatch(/^FROM \S+@sha256:[0-9a-f]{64}$/m);
  });

  it('chrome: secret-free, read-only, non-root, no capabilities, no host mounts, nothing published', () => {
    expect(chrome.read_only).toBe(true);
    expect(chrome.cap_drop).toEqual(['ALL']);
    expect(chrome.user).toMatch(/^[1-9]\d*:[1-9]\d*$/);
    expect(chrome.volumes).toBeUndefined();
    expect(chrome.ports).toBeUndefined();
    expect(chrome.env_file).toBeUndefined();
    expect(Object.keys(chrome.environment ?? {})).toEqual(['HOME']);
    expect(chrome.security_opt).toContain('no-new-privileges:true');
    expect(chrome.pids_limit).toBeGreaterThan(0);
    expect(chrome.mem_limit).toBeDefined();
  });

  it('chrome has only the internal network, which has no gateway; only the proxy is on the egress network', () => {
    expect(Object.keys(chrome.networks ?? {})).toEqual(['internal']);
    expect(doc.networks.internal!.internal).toBe(true);
    expect(Object.keys(proxy.networks ?? {}).sort()).toEqual(['egress', 'internal']);
    expect(doc.networks.egress!.internal).not.toBe(true);
  });

  it('the DevTools and control ports are published on 127.0.0.1 only, by the proxy container', () => {
    expect(proxy.ports).toEqual(['127.0.0.1:9222:9222', '127.0.0.1:9223:9223']);
  });

  it('argv: proxy-only egress, loopback not bypassed, QUIC off, WebRTC UDP off, keychain off, sandbox on', () => {
    expect(argv).toContain('--proxy-server=http://10.88.77.2:3128');
    expect(argv).toContain("'--proxy-bypass-list=<-loopback>'");
    for (const f of ['--disable-quic', '--webrtc-ip-handling-policy=disable_non_proxied_udp', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp', '--dns-prefetch-disable', '--disable-background-networking', '--disable-component-update', '--disable-sync', '--disable-default-apps', '--disable-extensions', '--no-first-run', '--no-pings', '--disable-breakpad', '--use-mock-keychain', '--password-store=basic', '--user-data-dir=/tmp/profile']) {
      expect(argv, f).toContain(f);
    }
    for (const f of ['--no-sandbox', '--disable-setuid-sandbox', '--single-process', '--no-zygote', '--disable-web-security', '--remote-debugging-address', '--host-resolver-rules']) {
      expect(argv, f).not.toContain(f);
    }
  });

  it('the proxy container is read-only, capability-free, and refuses the internal network on its control ports', () => {
    expect(proxy.read_only).toBe(true);
    expect(proxy.cap_drop).toEqual(['ALL']);
    expect(proxy.environment!.INTERNAL_CIDR).toBe('10.88.77.0/24');
    expect(proxy.environment).not.toHaveProperty('DATABASE_URL');
    expect(proxy.environment!.ACCESS_TOKEN).toMatch(/CHROME_ACCESS_TOKEN/); // per-boot, from the launcher, never a literal
    expect(readFileSync(new URL('./docker/chrome/proxy.Dockerfile', import.meta.url), 'utf8')).toMatch(/rm -rf \/usr\/local\/lib\/node_modules\/npm .*\/usr\/local\/bin\/npx/);
  });
});
