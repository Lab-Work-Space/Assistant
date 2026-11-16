import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { realGit } from '../devjob/git.js';
import { applyImport, planImport } from './code-import.js';

/** Run as the executor user by `executor-service.sh import --bundle FILE` (G2SC-02). Prints the incoming commits and asks for a typed confirmation. */
async function main(): Promise<void> {
  const a = process.argv;
  const root = a[a.indexOf('--root') + 1];
  const bundle = a[a.indexOf('--bundle') + 1];
  if (!root || !bundle || !root.startsWith('/') || !bundle.startsWith('/')) throw new Error('usage: --root <abs> --bundle <abs>');
  const repo = join(root, 'repo.git');
  if (!existsSync(repo)) execFileSync('git', ['init', '-q', '--bare', '-b', 'main', repo], { env: { PATH: process.env.PATH ?? '/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } });
  mkdirSync(join(root, 'bundles'), { recursive: true, mode: 0o700 });
  const own = join(root, 'bundles', 'import.bundle');
  copyFileSync(bundle, own);
  const git = realGit(repo);
  const plan = await planImport(git, own);
  if (!plan.ok) throw new Error(plan.why);
  console.log(`Incoming commits (${plan.commits.length}) ${plan.current ? plan.current.slice(0, 12) : '(new repository)'} -> ${plan.head.slice(0, 12)}:`);
  for (const c of plan.commits.slice(0, 50)) console.log(`  ${c}`);
  if (plan.commits.length > 50) console.log(`  ... +${plan.commits.length - 50} more`);
  const rl = createInterface({ input: process.stdin });
  const answer: string = await new Promise((r) => rl.question('Type "import these commits" to move the executor main: ', r));
  rl.close();
  if (answer.trim() !== 'import these commits') throw new Error('not confirmed; nothing was changed');
  await applyImport(git, plan);
  console.log('executor main moved');
}

main().catch((err: unknown) => {
  console.error(`import failed: ${err instanceof Error ? err.message : 'error'}`);
  process.exit(1);
});
