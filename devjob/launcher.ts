import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';

/**
 * The fixed-argv launcher (Gate 1 self-code OD-1a, X4, X6, X7). The main application starts dev-job containers ONLY through this module. A caller
 * supplies a job id, a revision, a few validated values and stdin; it supplies no mount, image, network, flag, command or environment name. Every
 * container gets the same hardening baseline. This is damage limitation, not a boundary: any process of the owner's uid can already reach the Docker
 * socket (OD-1), and Gate 2 must not credit it as a control. The module is non-self-modifiable (X10).
 */
export interface Images { prep: string; agent: string; test: string }
export interface DockerResult { code: number; stdout: Buffer; stderr: Buffer; timedOut: boolean }
export type DockerRun = (args: readonly string[], o?: { input?: Buffer; maxBytes?: number; timeoutMs?: number }) => Promise<DockerResult>;

export const NETWORKS = { agent: 'devjob_agentnet', prep: 'devjob_prepnet' } as const;
/** The model proxy's fixed address on the agent network (docker-compose.devjob.yml). */
export const MODEL_PROXY_URL = 'http://10.88.78.2:8080';
export const REGISTRY_PROXY_URL = 'http://10.88.79.2:4873';
export const JOB_ID = /^J-[0-9a-f]{16}$/;
const SHA = /^[0-9a-f]{40}$/;
const CRED = /^dj-[0-9a-f]{48}$/;
export const MAX_BUNDLE_OUT = 20 * 1024 * 1024;
export const MAX_LOG = 256 * 1024;
export const WALL_CLOCK_MS = 30 * 60_000;

export const volumeName = (job: string): string => { assertJob(job); return `devjob-${job}`; };
export const containerName = (job: string, role: string): string => { assertJob(job); if (!/^[a-z]{3,8}$/.test(role)) throw new Error('bad role'); return `devjob-${job}-${role}`; };
function assertJob(job: string): void { if (!JOB_ID.test(job)) throw new Error('bad job id'); }

interface Limits { pids: number; memory: string; cpus: string; tmpfs: string }
const LIMITS: Record<'prep' | 'agent' | 'test' | 'export', Limits> = {
  prep: { pids: 256, memory: '1g', cpus: '2', tmpfs: '256m' },
  agent: { pids: 512, memory: '2g', cpus: '2', tmpfs: '512m' },
  test: { pids: 512, memory: '3g', cpus: '3', tmpfs: '512m' },
  export: { pids: 64, memory: '512m', cpus: '1', tmpfs: '64m' },
};

/** The hardening baseline every role uses (X4). Exported so a test can assert the exact shape. */
export function baseline(job: string, role: 'prep' | 'agent' | 'test' | 'export' | 'review', network: string, o: { volume?: string; readonly?: boolean; interactive?: boolean }): string[] {
  const l = LIMITS[role === 'review' ? 'agent' : role];
  if (o.volume !== undefined && !(o.volume.startsWith(volumeName(job)) && /^devjob-J-[0-9a-f]{16}(?:-[a-z0-9]{1,8})?$/.test(o.volume))) throw new Error('bad volume');
  const vol = o.volume === undefined ? [] : ['--mount', `type=volume,src=${o.volume},dst=/work${o.readonly ? ',readonly' : ''}`];
  return [
    'run', '--rm', '--init', '--name', containerName(job, role), '--label', 'devjob=1', '--label', `devjob.job=${job}`,
    ...(o.interactive ? ['-i'] : []),
    '--user', '65534:65534', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges',
    '--pids-limit', String(l.pids), '--memory', l.memory, '--memory-swap', l.memory, '--cpus', l.cpus,
    '--tmpfs', `/tmp:rw,noexec,nosuid,nodev,size=${l.tmpfs}`, '--tmpfs', '/home/agent:rw,noexec,nosuid,nodev,size=64m',
    '--network', network,
    ...vol,
  ];
}

export interface TestResult { ok: boolean; testsRun: number; testsFailed: number; typecheck: boolean; build: boolean; log: string }
export interface Sandbox {
  /** Creates a volume holding a checkout of `rev` from `bundle` (a full bundle) with dependencies installed (`npm ci --ignore-scripts` via the registry proxy). */
  prepare(job: string, tag: string, o: { bundle: Buffer; rev: string }): Promise<{ volume: string; ok: boolean; log: string }>;
  runAgent(job: string, o: { volume: string; base: string; credential: string; brief: string }): Promise<{ ok: boolean; log: string; timedOut: boolean }>;
  exportBundle(job: string, o: { volume: string; base: string }): Promise<Buffer | null>;
  runTests(job: string, o: { volume: string }): Promise<TestResult>;
  review(job: string, o: { kind: 'code' | 'security'; credential: string; input: string }): Promise<{ ok: boolean; stdout: string }>;
  cleanup(job: string): Promise<{ removed: boolean }>;
  kill(job: string): Promise<void>;
}

/** Fixed environment per role. No name or value comes from a caller except the validated ones below. */
const AGENT_ENV = (credential: string): string[] => {
  if (!CRED.test(credential)) throw new Error('bad credential');
  return ['-e', `ANTHROPIC_BASE_URL=${MODEL_PROXY_URL}`, '-e', `ANTHROPIC_API_KEY=${credential}`, '-e', 'DISABLE_AUTOUPDATER=1', '-e', 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1', '-e', 'HOME=/home/agent', '-e', 'GIT_CONFIG_NOSYSTEM=1', '-e', 'GIT_TERMINAL_PROMPT=0'];
};

export const realDocker: DockerRun = (args, o = {}) => new Promise((resolve) => {
  const p = execFile('docker', [...args], { env: { PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin', HOME: process.env.HOME ?? '/', ...(process.env.DOCKER_HOST ? { DOCKER_HOST: process.env.DOCKER_HOST } : {}) }, encoding: 'buffer', maxBuffer: o.maxBytes ?? MAX_LOG, timeout: o.timeoutMs ?? WALL_CLOCK_MS, killSignal: 'SIGKILL' }, (err, stdout, stderr) => {
    const e = err as (NodeJS.ErrnoException & { code?: number | string; killed?: boolean }) | null;
    resolve({ code: e ? (typeof e.code === 'number' ? e.code : 1) : 0, stdout, stderr, timedOut: !!e?.killed });
  });
  if (o.input) p.stdin?.end(o.input); else p.stdin?.end();
});

const text = (b: Buffer, max = MAX_LOG): string => b.subarray(0, max).toString('utf8');

export class DockerSandbox implements Sandbox {
  constructor(private readonly d: { docker: DockerRun; images: Images; wallClockMs?: number }) {}

  async prepare(job: string, tag: string, o: { bundle: Buffer; rev: string }) {
    const volume = `${volumeName(job)}-${tag}`;
    if (!/^[a-z0-9]{1,8}$/.test(tag) || !SHA.test(o.rev)) throw new Error('bad prepare input');
    if (o.bundle.length === 0 || o.bundle.length > MAX_BUNDLE_OUT) throw new Error('bad bundle size');
    const args = [...baseline(job, 'prep', NETWORKS.prep, { volume, interactive: true }), '-e', `REV=${o.rev}`, '-e', `NPM_REGISTRY=${REGISTRY_PROXY_URL}`, this.d.images.prep];
    const r = await this.d.docker(args, { input: o.bundle, timeoutMs: this.d.wallClockMs ?? WALL_CLOCK_MS });
    return { volume, ok: r.code === 0 && !r.timedOut, log: text(Buffer.concat([r.stdout, r.stderr])) };
  }

  async runAgent(job: string, o: { volume: string; base: string; credential: string; brief: string }) {
    if (!SHA.test(o.base) || Buffer.byteLength(o.brief) > 64 * 1024) throw new Error('bad agent input');
    const args = [...baseline(job, 'agent', NETWORKS.agent, { volume: o.volume, interactive: true }), ...AGENT_ENV(o.credential), '-e', `BASE=${o.base}`, '-e', 'ROLE=coder', this.d.images.agent, '/opt/devjob/agent.sh'];
    const r = await this.d.docker(args, { input: Buffer.from(o.brief, 'utf8'), timeoutMs: this.d.wallClockMs ?? WALL_CLOCK_MS });
    return { ok: r.code === 0 && !r.timedOut, log: text(Buffer.concat([r.stdout, r.stderr])), timedOut: r.timedOut };
  }

  /** The bundle leaves only as the stdout of a fixed command with a byte cap (X7); never through `docker cp`. */
  async exportBundle(job: string, o: { volume: string; base: string }): Promise<Buffer | null> {
    if (!SHA.test(o.base)) throw new Error('bad base');
    const args = [...baseline(job, 'export', 'none', { volume: o.volume, readonly: true }), '-e', `BASE=${o.base}`, this.d.images.agent, '/opt/devjob/export.sh'];
    const r = await this.d.docker(args, { maxBytes: MAX_BUNDLE_OUT, timeoutMs: 120_000 });
    return r.code === 0 && r.stdout.length > 0 && r.stdout.length <= MAX_BUNDLE_OUT ? r.stdout : null;
  }

  /**
   * G2SC-04: the result line carries a nonce that only the harness knows. It arrives on stdin (not in the environment or argv, so the code under test cannot read
   * it from /proc), test.sh forgets it before any test runs and prints the result line last. Only a line with this nonce counts, and exactly one must exist.
   */
  async runTests(job: string, o: { volume: string }): Promise<TestResult> {
    const nonce = randomBytes(16).toString('hex');
    const args = [...baseline(job, 'test', 'none', { volume: o.volume, interactive: true }), '-e', 'CI=1', this.d.images.test, '/opt/devjob/test.sh'];
    const r = await this.d.docker(args, { input: Buffer.from(`${nonce}\n`), timeoutMs: this.d.wallClockMs ?? WALL_CLOCK_MS });
    const out = text(r.stdout);
    const hits = [...out.matchAll(new RegExp(`^DEVJOB_RESULT ${nonce} (\\{.*\\})$`, 'gm'))];
    let parsed: { testsRun?: unknown; testsFailed?: unknown; typecheck?: unknown; build?: unknown } = {};
    try { parsed = hits.length === 1 ? (JSON.parse(hits[0]![1]!) as typeof parsed) : {}; } catch { parsed = {}; }
    const testsRun = Number.isInteger(parsed.testsRun) ? (parsed.testsRun as number) : 0;
    const testsFailed = Number.isInteger(parsed.testsFailed) ? (parsed.testsFailed as number) : 1;
    const typecheck = parsed.typecheck === true;
    const build = parsed.build === true;
    return { ok: hits.length === 1 && r.code === 0 && !r.timedOut && testsFailed === 0 && testsRun > 0 && typecheck && build, testsRun, testsFailed, typecheck, build, log: text(Buffer.concat([r.stdout, r.stderr])).replace(new RegExp(nonce, 'g'), '[nonce]') };
  }

  /** The reviewer: a fresh agent-type container, no volume at all, the model proxy only; the diff arrives on stdin as delimited data. */
  async review(job: string, o: { kind: 'code' | 'security'; credential: string; input: string }) {
    if (Buffer.byteLength(o.input) > 4 * 1024 * 1024) throw new Error('review input too large');
    const args = [...baseline(job, 'review', NETWORKS.agent, { interactive: true }), ...AGENT_ENV(o.credential), '-e', `ROLE=${o.kind === 'code' ? 'review-code' : 'review-security'}`, this.d.images.agent, '/opt/devjob/agent.sh'];
    // the reviewer container is named per kind so two passes never collide
    const named = args.map((a) => (a === containerName(job, 'review') ? `${a}-${o.kind}` : a));
    const r = await this.d.docker(named, { input: Buffer.from(o.input, 'utf8'), maxBytes: 1024 * 1024, timeoutMs: 15 * 60_000 });
    return { ok: r.code === 0 && !r.timedOut, stdout: text(r.stdout, 1024 * 1024) };
  }

  /** Removes the job's containers and volumes and VERIFIES the removal (X4). */
  async cleanup(job: string): Promise<{ removed: boolean }> {
    assertJob(job);
    await this.kill(job);
    const vols = (await this.d.docker(['volume', 'ls', '-q', '--filter', `name=^devjob-${job}`])).stdout.toString('utf8').split('\n').filter((v) => v.startsWith(`devjob-${job}`));
    for (const v of vols) await this.d.docker(['volume', 'rm', '-f', v]);
    const left = (await this.d.docker(['volume', 'ls', '-q', '--filter', `name=^devjob-${job}`])).stdout.toString('utf8').trim();
    const cs = (await this.d.docker(['ps', '-aq', '--filter', `label=devjob.job=${job}`])).stdout.toString('utf8').trim();
    return { removed: left === '' && cs === '' };
  }

  async kill(job: string): Promise<void> {
    assertJob(job);
    const ids = (await this.d.docker(['ps', '-aq', '--filter', `label=devjob.job=${job}`])).stdout.toString('utf8').split('\n').filter(Boolean);
    for (const id of ids) if (/^[0-9a-f]{12,64}$/.test(id)) await this.d.docker(['rm', '-f', id]);
  }

  /** The halt switch: every dev-job container, whatever the job. */
  async killAll(): Promise<number> {
    const ids = (await this.d.docker(['ps', '-aq', '--filter', 'label=devjob=1'])).stdout.toString('utf8').split('\n').filter((i) => /^[0-9a-f]{12,64}$/.test(i));
    for (const id of ids) await this.d.docker(['rm', '-f', id]);
    return ids.length;
  }
}
