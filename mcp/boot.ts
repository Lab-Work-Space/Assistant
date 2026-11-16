import type { McpRepo } from '../db/repos/mcp.js';
import type { AuditFn } from '../governance/audit.js';
import { removeVerified, type DockerCli } from '../workspaces/runner.js';
import type { LoadResult } from './host.js';
import { SANDBOX_NAME, checkImage, checkSeccomp } from './sandbox.js';

/**
 * R6 MCP-1 boot (spec 5.14, MC-C2, MC-C3, MC-C19): never throws, 20 s overall. Any failure leaves MCP off with a fixed reason and one `mcp.boot` audit row:
 *  1. Docker answers `docker version`;
 *  2. `docker info` shows seccomp and no `unconfined` (MC-C3);
 *  3. the sweep removes containers that carry label mcp=1 AND a name matching ^mcp-<slug>-<8hex>$ (labels are inherited from images, F-10), with `rm -f -v`, verified;
 *  4. every active row's image id matches and declares no volumes, else that server is not loaded (the row is unchanged) and `image_missing <slug>` is audited;
 *  5. the host loads the rest. Boot does not probe; every call does.
 */
export interface BootDeps {
  docker: Pick<DockerCli, 'exec'>;
  repo: Pick<McpRepo, 'activeRows'>;
  host: { load(exclude?: ReadonlySet<string>, cancelled?: () => boolean): Promise<LoadResult>; clear?(): void };
  audit: AuditFn;
  log: { error(o: unknown, m?: string): void };
  timeoutMs?: number;
}
export type OffReason = 'docker' | 'seccomp' | 'sweep' | 'timeout' | 'error';
export type McpBoot = { ok: true; loaded: number; missing: string[] } | { ok: false; reason: OffReason };

const errName = (e: unknown): string => (e instanceof Error ? e.name : 'unknown');

export async function bootMcp(d: BootDeps): Promise<McpBoot> {
  const audit = async (outcome: string): Promise<void> => { try { await d.audit({ actor: 'system:mcp', action: 'mcp.boot', outcome }); } catch { /* the audit never throws */ } };
  const off = async (reason: OffReason): Promise<McpBoot> => { if (!cancelled) await audit(`off:${reason}`); return { ok: false, reason }; };
  let cancelled = false; // set when the cap wins: a late check must not load the host or write a row after boot reported off
  const work = async (): Promise<McpBoot> => {
    const v = await d.docker.exec(['version', '--format', '{{.Server.Version}}']);
    if (v.missing || v.timedOut || v.code !== 0) return off('docker');
    if (!(await checkSeccomp(d.docker))) return off('seccomp');
    const ps = await d.docker.exec(['ps', '-a', '--filter', 'label=mcp=1', '--format', '{{.Names}}']);
    if (ps.code !== 0 || ps.timedOut) return off('sweep');
    for (const name of ps.stdout.split('\n').map((l) => l.trim()).filter((l) => SANDBOX_NAME.test(l))) {
      if (!(await removeVerified(d.docker, name, { volumes: true }))) return off('sweep');
    }
    if (cancelled) return { ok: false, reason: 'timeout' };
    const rows = await d.repo.activeRows();
    if (cancelled) return { ok: false, reason: 'timeout' };
    const missing: string[] = [];
    for (const r of rows) {
      if (!(await checkImage(d.docker, r.imageId))) {
        missing.push(r.slug);
        if (!cancelled) await audit(`image_missing ${r.slug}`);
      }
    }
    if (cancelled) return { ok: false, reason: 'timeout' };
    const loaded = await d.host.load(new Set(missing), () => cancelled);
    if (cancelled) { try { d.host.clear?.(); } catch { /* never throws */ } return { ok: false, reason: 'timeout' }; }
    await audit(`ok ${loaded.loaded}`);
    return { ok: true, loaded: loaded.loaded, missing };
  };
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work(),
      new Promise<McpBoot>((resolve) => { timer = setTimeout(() => { cancelled = true; try { d.host.clear?.(); } catch { /* never throws */ } resolve({ ok: false, reason: 'timeout' }); }, d.timeoutMs ?? 20_000); }),
    ]).then(async (r) => { if (!r.ok && r.reason === 'timeout') await audit('off:timeout'); return r; });
  } catch (e) {
    d.log.error({ errName: errName(e) }, 'mcp boot failed');
    return off('error');
  } finally {
    if (timer) clearTimeout(timer);
  }
}
