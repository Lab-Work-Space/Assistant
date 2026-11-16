import { execFile } from 'node:child_process';
import type { GitPort } from '../devjob/git.js';
import type { BuildPorts } from './code-release.js';

/**
 * The real build ports (Gate 1 self-code X16b). The compiler is a root-owned, pinned `tsc` outside the tree; `npm ci` never runs scripts. The
 * children get a scrubbed environment: nothing the executor holds (tokens, database url) reaches them.
 */
const run = (cmd: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, input?: Buffer, timeout = 600_000): Promise<void> =>
  new Promise((resolve, reject) => {
    const p = execFile(cmd, args, { cwd, env, timeout, maxBuffer: 16 * 1024 * 1024, encoding: 'buffer' }, (err, _o, e) => (err ? reject(new Error(`${cmd} failed: ${e.toString('utf8').slice(0, 300)}`)) : resolve()));
    if (input) p.stdin?.end(input);
    else p.stdin?.end();
  });

export function realBuildPorts(o: { tscPath: string; npmPath: string; nodePath?: string }): BuildPorts {
  const base = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: '/nonexistent', LC_ALL: 'C' };
  return {
    extract: async (git: GitPort, head: string, dir: string) => {
      const tar = await git.run(['archive', '--format=tar', head], { maxBytes: 256 * 1024 * 1024 });
      await run('tar', ['-x', '-C', dir, '-f', '-'], dir, base, tar);
    },
    install: (dir) => run(o.npmPath, ['ci', '--ignore-scripts', '--no-audit', '--no-fund', '--userconfig=/dev/null', '--globalconfig=/dev/null'], dir, { ...base, npm_config_ignore_scripts: 'true' }),
    compile: (dir) => run(o.nodePath ?? process.execPath, [o.tscPath, '-p', 'tsconfig.build.json'], dir, base),
  };
}
