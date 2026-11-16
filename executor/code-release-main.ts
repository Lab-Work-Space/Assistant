import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { realGit } from '../devjob/git.js';
import { CodeApplier, type HealthBody } from './code-apply.js';
import { realBuildPorts } from './code-run.js';
import { trustProblem } from './code-trust.js';

/**
 * Run as the executor user by `executor-service.sh release` (human step, after `import`): builds a release from the executor's `main` with the same
 * build path as dev-job releases (git archive, npm ci --ignore-scripts, the pinned tsc), switches `current` under the apply lock after a typed
 * confirmation, waits for health and rolls back if the new build is not healthy. Environment: LW_CODE_ROOT, LW_CODE_TSC, LW_CODE_NPM, LW_APP_HEALTH_URL.
 */
async function main(): Promise<void> {
  const root = process.env.LW_CODE_ROOT, tsc = process.env.LW_CODE_TSC, npm = process.env.LW_CODE_NPM, url = process.env.LW_APP_HEALTH_URL;
  if (!root || !tsc || !npm || !url) throw new Error('LW_CODE_ROOT, LW_CODE_TSC, LW_CODE_NPM and LW_APP_HEALTH_URL are required');
  const bad = trustProblem({ root, tsc, npm });
  if (bad) throw new Error(`the code root is not trusted: ${bad}`);
  const git = realGit(join(root, 'repo.git'));
  const head = (await git.run(['rev-parse', '--verify', 'refs/heads/main'])).toString().trim();
  console.log(`Build a release from the executor main ${head} and make it current.`);
  const rl = createInterface({ input: process.stdin });
  const answer: string = await new Promise((r) => rl.question('Type "release main" to continue: ', r));
  rl.close();
  if (answer.trim() !== 'release main') throw new Error('not confirmed; nothing was changed');
  const health = async (): Promise<HealthBody | null> => { try { return (await (await fetch(url, { signal: AbortSignal.timeout(5000) })).json()) as HealthBody; } catch { return null; } };
  const applier = new CodeApplier({ git, root, build: realBuildPorts({ tscPath: tsc, npmPath: npm }), restart: async () => undefined, health, audit: async (e) => void console.log(`audit ${e.action} ${e.outcome ?? ''}`) });
  const r = await applier.releaseMain('operator');
  for (const l of r.lines) console.log(l);
  if (!r.ok) process.exit(2);
}

main().catch((err: unknown) => {
  console.error(`release failed: ${err instanceof Error ? err.message : 'error'}`);
  process.exit(1);
});
