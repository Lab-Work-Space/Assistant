import { deflateRawSync } from 'node:zlib';
import { crc32 } from '../workspaces/zip.js';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { rm } from 'node:fs/promises';
import type { ClaimedBuild } from '../db/repos/forge.js';
import type { ExecResult } from '../workspaces/runner.js';
import { buildZip } from '../workspaces/zip.js';
import { validatePlugin } from './validate.js';

/** A zip writer for tests that can break any field (the real writer is workspaces/zip.ts `buildZip`; the reader refuses everything it does not emit). */
export interface RawEntry {
  name: string; data: Buffer;
  method?: number; flags?: number; extra?: Buffer; crc?: number; csize?: number; usize?: number; body?: Buffer;
  extAttr?: number; intAttr?: number; diskStart?: number; versionMade?: number; localName?: string; localCrc?: number; localUsize?: number; localCsize?: number; localExtra?: Buffer; comment?: Buffer;
  offset?: number;
}
export interface RawOpts { eocdComment?: Buffer; diskNo?: number; gapBefore?: Buffer; trailing?: Buffer; cdGap?: Buffer; totalEntries?: number; cdOffsetDelta?: number }

export function rawZip(entries: readonly RawEntry[], o: RawOpts = {}): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  if (o.gapBefore) { parts.push(o.gapBefore); offset += o.gapBefore.length; }
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const lname = e.localName !== undefined ? Buffer.from(e.localName, 'utf8') : name;
    let method = e.method;
    let body = e.body;
    if (method === undefined || body === undefined) {
      const d = e.data.length > 0 ? deflateRawSync(e.data, { level: 9 }) : e.data;
      if (e.data.length > 0 && d.length < e.data.length) { method ??= 8; body ??= d; } else { method ??= 0; body ??= e.data; }
    }
    const crc = e.crc ?? crc32(e.data);
    const csize = e.csize ?? body.length;
    const usize = e.usize ?? e.data.length;
    const lextra = e.localExtra ?? Buffer.alloc(0);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(e.flags ?? 0, 6); lh.writeUInt16LE(method, 8); lh.writeUInt16LE(0, 10); lh.writeUInt16LE(0x21, 12);
    lh.writeUInt32LE(e.localCrc ?? crc, 14); lh.writeUInt32LE(e.localCsize ?? csize, 18); lh.writeUInt32LE(e.localUsize ?? usize, 22); lh.writeUInt16LE(lname.length, 26); lh.writeUInt16LE(lextra.length, 28);
    const extra = e.extra ?? Buffer.alloc(0);
    const comment = e.comment ?? Buffer.alloc(0);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(e.versionMade ?? 20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(e.flags ?? 0, 8); ch.writeUInt16LE(method, 10); ch.writeUInt16LE(0, 12); ch.writeUInt16LE(0x21, 14);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(csize, 20); ch.writeUInt32LE(usize, 24); ch.writeUInt16LE(name.length, 28); ch.writeUInt16LE(extra.length, 30); ch.writeUInt16LE(comment.length, 32);
    ch.writeUInt16LE(e.diskStart ?? 0, 34); ch.writeUInt16LE(e.intAttr ?? 0, 36); ch.writeUInt32LE(e.extAttr ?? 0, 38); ch.writeUInt32LE(e.offset ?? offset, 42);
    parts.push(lh, lname, lextra, body);
    central.push(ch, name, extra, comment);
    offset += 30 + lname.length + lextra.length + body.length;
  }
  if (o.cdGap) { parts.push(o.cdGap); offset += o.cdGap.length; }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(o.diskNo ?? 0, 4);
  end.writeUInt16LE(o.totalEntries ?? entries.length, 8); end.writeUInt16LE(o.totalEntries ?? entries.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset + (o.cdOffsetDelta ?? 0), 16); end.writeUInt16LE(o.eocdComment?.length ?? 0, 20);
  return Buffer.concat([...parts, cd, end, o.eocdComment ?? Buffer.alloc(0), o.trailing ?? Buffer.alloc(0)]);
}

// ---- R7 builder test fixtures ---------------------------------------------------------------------------------------------------------------

export const BASE_ID = `sha256:${'1'.repeat(64)}`;
export const NEW_ID = `sha256:${'2'.repeat(64)}`;
const sha = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex');
const layer = (c: string): string => `sha256:${c.repeat(64)}`;
export const BASE_LAYERS = [layer('a'), layer('b'), layer('c')];
export const BASE_CONFIG = (): Record<string, unknown> => ({
  Hostname: '', Domainname: '', User: '', AttachStdin: false, AttachStdout: false, AttachStderr: false, Tty: false, OpenStdin: false, StdinOnce: false,
  Env: ['PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', 'NODE_VERSION=24.1.0'], Cmd: ['node'], Image: '', Volumes: null, WorkingDir: '/', Entrypoint: ['docker-entrypoint.sh'],
  OnBuild: null, Labels: null, Healthcheck: null, Shell: null, StopSignal: null, ExposedPorts: null,
});

const HELLO_DIR = join(new URL('..', import.meta.url).pathname, 'tests', 'fixtures', 'forge', 'hello');
export function helloFiles(): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string): void => { for (const n of readdirSync(d)) { const p = join(d, n); if (statSync(p).isDirectory()) walk(p); else out[relative(HELLO_DIR, p)] = readFileSync(p, 'utf8'); } };
  walk(HELLO_DIR);
  return out;
}
export const zipOfFiles = (f: Record<string, string>): Buffer => buildZip(Object.entries(f).map(([name, data]) => ({ name, data: Buffer.from(data) })));

/** A claimed build over the hello fixture, with a consistent hash chain. */
export function helloBuild(over: Partial<ClaimedBuild> = {}): ClaimedBuild {
  const zip = zipOfFiles(helloFiles());
  const v = validatePlugin(zip, { forgeIdeaId: 1 });
  if (!v.ok) throw new Error('fixture invalid');
  return {
    id: 7, forgeId: 3, releaseId: 11, status: 'building', pluginSlug: 'hello', sha256: sha(zip), bytes: zip.length, manifestSha256: v.info.manifestSha256, attempts: 1, decidedBy: '900000000000000001',
    baseImageId: null, imageId: null, imageBytes: null, imageRemovedAt: null, code: null, createdAt: new Date(), startedAt: new Date(), finishedAt: null,
    zip, releaseSha256: sha(zip), releaseManifestSha256: v.info.manifestSha256, releaseTaskId: '11111111-1111-4111-8111-111111111111', releaseDeptId: 'software', ideaId: 1, deptId: 'software', ...over,
  };
}

/** A scratch stage root under the OS temp dir, mode 0700, removed by the guard below (global rules 14, 23, 24: never the real `assistant-forge`). */
export function scratchRoot(): { root: string; parent: string } {
  const parent = mkdtempSync(join(tmpdir(), 'forge-test-'));
  const root = join(parent, 'assistant-forge');
  mkdirSync(root, { mode: 0o700 });
  return { root, parent };
}
export async function removeScratch(parent: string): Promise<void> {
  if (!parent.startsWith(join(tmpdir(), 'forge-test-')) || parent.includes('..')) throw new Error('refusing to delete outside the test scratch');
  await rm(parent, { recursive: true, force: true });
}

const ok = (stdout = ''): ExecResult => ({ code: 0, stdout, timedOut: false, missing: false });
const bad = (stdout = ''): ExecResult => ({ code: 1, stdout, timedOut: false, missing: false });

export interface FakeKnobs {
  baseConfig: Record<string, unknown>; baseLayers: string[]; baseSize: number; baseOs: string; baseId: string;
  createFail: boolean; createOut: string | null; cpFail: boolean; commitFail: boolean; commitOut: string | null;
  /** Mutates the committed image's inspect JSON (a hostile or buggy daemon, an extra layer ...). */
  tamper: ((img: Record<string, unknown>) => void) | null;
  /** The committed image's size above the base. */
  delta: number;
  /** `image rm` leaves the image in place. */
  imageRmFails: boolean;
  /** `rm -f` of a container leaves it in `ps -a`. */
  containerRmFails: boolean;
  /** Called with the stage dir content when `cp` runs. */
  onCp: ((argv: string[]) => void) | null;
  /** Called with the verb of every exec before it is answered; may throw to simulate a daemon failure. */
  onExec: ((argv: string[]) => void) | null;
}
/**
 * A scripted docker daemon for the builder: it keeps containers and images, answers inspect with JSON (the committed image is the base config with the `--change` flags applied), matches `ps --filter
 * name=` by SUBSTRING as docker does, and records every argv. It cannot run anything: there is no `run`, `start` or `exec` handler (an unknown verb fails the call and is recorded).
 */
export class FakeForgeDocker {
  readonly calls: string[][] = [];
  containers = new Set<string>();
  images = new Map<string, Record<string, unknown>>();
  rmCalls: string[] = [];
  k: FakeKnobs = { baseConfig: BASE_CONFIG(), baseLayers: [...BASE_LAYERS], baseSize: 50_000_000, baseOs: 'linux', baseId: BASE_ID, createFail: false, createOut: null, cpFail: false, commitFail: false, commitOut: null, tamper: null, delta: 100_000, imageRmFails: false, containerRmFails: false, onCp: null, onExec: null };
  private n = 0;

  private baseImage(): Record<string, unknown> {
    return { Id: this.k.baseId, Os: this.k.baseOs, Size: this.k.baseSize, Config: this.k.baseConfig, RootFS: { Type: 'layers', Layers: this.k.baseLayers } };
  }
  exec(args: readonly string[]): Promise<ExecResult> {
    const a = [...args];
    this.calls.push(a);
    this.k.onExec?.(a);
    const v = a[0];
    if (v === 'image' && a[1] === 'inspect') {
      const id = a[a.length - 1]!;
      if (id === BASE_ID || id === this.k.baseId) return Promise.resolve(id === this.k.baseId ? ok(JSON.stringify(this.baseImage())) : bad());
      const img = this.images.get(id);
      return Promise.resolve(img ? ok(JSON.stringify(img)) : bad());
    }
    if (v === 'create') {
      if (this.k.createFail) return Promise.resolve(bad());
      const name = a[a.indexOf('--name') + 1]!;
      this.containers.add(name);
      return Promise.resolve(ok(this.k.createOut ?? `${randomBytes(32).toString('hex')}\n`));
    }
    if (v === 'cp') { this.k.onCp?.(a); return Promise.resolve(this.k.cpFail ? bad() : ok()); }
    if (v === 'commit') {
      if (this.k.commitFail) return Promise.resolve(bad());
      const id = this.k.commitOut ?? NEW_ID;
      const cfg = { ...JSON.parse(JSON.stringify(this.k.baseConfig)) as Record<string, unknown> };
      const labels: Record<string, string> = {};
      for (let i = 1; i < a.length - 1; i += 2) {
        const ch = a[i + 1]!;
        if (ch.startsWith('USER ')) cfg.User = ch.slice(5);
        else if (ch.startsWith('WORKDIR ')) cfg.WorkingDir = ch.slice(8);
        else if (ch.startsWith('ENTRYPOINT ')) cfg.Entrypoint = JSON.parse(ch.slice(11));
        else if (ch.startsWith('CMD ')) cfg.Cmd = JSON.parse(ch.slice(4));
        else if (ch.startsWith('ENV ')) cfg.Env = [...(cfg.Env as string[]).filter((e) => !e.startsWith(`${ch.slice(4).split('=')[0]}=`)), ch.slice(4)];
        else if (ch.startsWith('LABEL ')) { const [k, ...r] = ch.slice(6).split('='); labels[k!] = r.join('='); }
      }
      cfg.Labels = labels;
      cfg.Hostname = 'abcdef012345';
      cfg.Image = this.k.baseId;
      const img: Record<string, unknown> = { Id: id, Os: 'linux', Size: this.k.baseSize + this.k.delta, Config: cfg, RootFS: { Type: 'layers', Layers: [...this.k.baseLayers, layer('d')] } };
      this.k.tamper?.(img);
      this.images.set(id, img);
      return Promise.resolve(ok(`${id}\n`));
    }
    if (v === 'rm') {
      const name = a[a.length - 1]!;
      this.rmCalls.push(name);
      if (!this.k.containerRmFails) this.containers.delete(name);
      return Promise.resolve(ok());
    }
    if (v === 'ps') {
      const f = a[a.indexOf('--filter') + 1]!.replace(/^name=/, '');
      return Promise.resolve(ok([...this.containers].filter((n) => n.includes(f)).join('\n')));
    }
    if (v === 'image' && a[1] === 'rm') {
      if (!this.k.imageRmFails) this.images.delete(a[a.length - 1]!);
      return Promise.resolve(ok());
    }
    if (v === 'image' && a[1] === 'ls') return Promise.resolve(ok([...this.images.keys()].join('\n')));
    return Promise.resolve(bad()); // run, start, exec, build, pull, push, tag ... do not exist here
  }
  verbs(): string[] { return this.calls.map((c) => c.slice(0, c[0] === 'image' ? 2 : 1).join(' ')); }
}
