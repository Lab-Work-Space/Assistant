import { execFile } from 'node:child_process';

/**
 * The one way dev-job code runs git (Gate 1 self-code X16). Hooks, protocols, fsmonitor and every config file are off; the environment holds
 * nothing from the caller's. Git never runs inside a directory a sandbox produced: only inside a bare repository this process owns.
 */
export interface GitPort {
  run(args: readonly string[], o?: { input?: Buffer; maxBytes?: number }): Promise<Buffer>;
}

export function hardenedArgs(gitDir: string): string[] {
  return ['-c', 'core.hooksPath=/dev/null', '-c', 'protocol.allow=never', '-c', 'transfer.fsckObjects=true', '-c', 'core.fsmonitor=', '-c', `safe.directory=${gitDir}`, `--git-dir=${gitDir}`];
}

/** Environment for every git child: no system or global config, no prompts, no inherited GIT_* or credentials. */
export function gitEnv(): NodeJS.ProcessEnv {
  return { PATH: process.env.PATH ?? '/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_ATTR_NOSYSTEM: '1', LC_ALL: 'C' };
}

export function realGit(gitDir: string): GitPort {
  return {
    run: (args, o = {}) => new Promise<Buffer>((resolve, reject) => {
      const p = execFile('git', [...hardenedArgs(gitDir), ...args], { env: gitEnv(), encoding: 'buffer', maxBuffer: o.maxBytes ?? 64 * 1024 * 1024, timeout: 120_000 }, (err, stdout, stderr) => {
        if (err) reject(new Error(`git ${args[0]} failed: ${stderr.toString('utf8').slice(0, 200)}`));
        else resolve(stdout);
      });
      if (o.input) p.stdin?.end(o.input);
      else p.stdin?.end();
    }),
  };
}

/** Reads many blobs with one `cat-file --batch`. A missing path maps to null. Each blob is capped; a larger one is returned as null and listed in `oversize`. */
export async function readBlobs(git: GitPort, rev: string, paths: readonly string[], capBytes = 512 * 1024): Promise<{ files: Map<string, string | null>; oversize: string[] }> {
  const files = new Map<string, string | null>();
  const oversize: string[] = [];
  if (paths.length === 0) return { files, oversize };
  const out = await git.run(['cat-file', '--batch'], { input: Buffer.from(paths.map((p) => `${rev}:${p}\n`).join('')), maxBytes: 256 * 1024 * 1024 });
  let at = 0;
  for (const p of paths) {
    const nl = out.indexOf(0x0a, at);
    if (nl < 0) throw new Error('cat-file output is truncated');
    const head = out.subarray(at, nl).toString('utf8');
    at = nl + 1;
    if (head.endsWith(' missing')) { files.set(p, null); continue; }
    const m = /^[0-9a-f]{40,64} (\w+) (\d+)$/.exec(head);
    if (!m) throw new Error('cat-file output is malformed');
    const size = Number(m[2]);
    const body = out.subarray(at, at + size);
    at += size + 1;
    if (m[1] !== 'blob') { files.set(p, null); continue; }
    if (size > capBytes) { files.set(p, null); oversize.push(p); continue; }
    files.set(p, body.toString('utf8'));
  }
  return { files, oversize };
}

export async function listTree(git: GitPort, rev: string): Promise<string[]> {
  const out = await git.run(['ls-tree', '-r', '-z', '--name-only', rev]);
  return out.toString('utf8').split('\0').filter(Boolean);
}
