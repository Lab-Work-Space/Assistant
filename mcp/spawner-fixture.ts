import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { McpProc, McpSpawner } from './rpc.js';

export const FIXTURE = fileURLToPath(new URL('../tests/fixtures/mcp/echo-server.mjs', import.meta.url));

/** Runs the fixture server with node (process.execPath) in place of `docker run`; the docker argv is recorded and ignored. `stdinLog` collects every byte the client wrote. */
export function fixtureSpawner(env: Record<string, string> = {}, log: { argv: string[][]; stdin: string[]; spawned: number; killed: number; ended: number; env: Record<string, string>[] } = { argv: [], stdin: [], spawned: 0, killed: 0, ended: 0, env: [] }): McpSpawner & { log: typeof log } {
  const fn = ((argv: readonly string[]): McpProc => {
    log.argv.push([...argv]);
    log.spawned++;
    log.env.push({ ...env });
    const p = spawn(process.execPath, [FIXTURE], { env: { PATH: process.env.PATH ?? '', ...env }, stdio: ['pipe', 'pipe', 'pipe'], shell: false });
    const origWrite = p.stdin.write.bind(p.stdin) as (...a: unknown[]) => boolean;
    (p.stdin as unknown as { write: (...a: unknown[]) => boolean }).write = (...a: unknown[]) => { log.stdin.push(String(a[0])); return origWrite(...a); };
    const exited = new Promise<{ code: number | null; spawnFailed: boolean }>((resolve) => {
      p.on('error', () => resolve({ code: 127, spawnFailed: true }));
      p.on('close', (code) => resolve({ code, spawnFailed: false }));
    });
    const origEnd = p.stdin.end.bind(p.stdin) as (...a: unknown[]) => unknown;
    (p.stdin as unknown as { end: (...a: unknown[]) => unknown }).end = (...a: unknown[]) => { log.ended++; return origEnd(...a); };
    return { stdin: p.stdin, stdout: p.stdout, stderr: p.stderr, exited, kill: () => { log.killed++; p.kill('SIGKILL'); } };
  }) as McpSpawner & { log: typeof log };
  fn.log = log;
  return fn;
}

