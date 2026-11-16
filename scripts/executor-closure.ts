import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { closureReport } from '../devjob/closure-report.js';
import { hardenedArgs, realGit } from '../devjob/git.js';

/**
 * Called by `executor-service.sh install` (Gate 1 self-code X9): prints what changed in the executor's import closure since the installed commit and
 * which commits were made by dev jobs. Exit 0 = nothing changed, 3 = something changed (the installer then asks for a typed confirmation).
 *   node dist/scripts/executor-closure.js --repo <dir> --from <commit>      (the head is the repo's HEAD)
 */
async function main(): Promise<void> {
  const a = process.argv;
  const repo = a[a.indexOf('--repo') + 1];
  const from = a[a.indexOf('--from') + 1];
  if (!repo || !from || !/^[0-9a-f]{40}$/.test(from)) throw new Error('usage: --repo <dir> --from <40 hex>');
  const to = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { env: { PATH: process.env.PATH ?? '' } }).toString().trim();
  const gitDir = execFileSync('git', ['-C', repo, 'rev-parse', '--absolute-git-dir'], { env: { PATH: process.env.PATH ?? '' } }).toString().trim();
  void hardenedArgs;
  const r = await closureReport(realGit(gitDir), from, to);
  if (r.nothing && r.devJobCommits.length === 0) { console.log('executor closure: unchanged'); return; }
  console.log(`executor closure changed between ${from.slice(0, 12)} and ${to.slice(0, 12)}:`);
  for (const c of r.changed.slice(0, 40)) console.log(`  ${c}`);
  if (r.changed.length > 40) console.log(`  ... +${r.changed.length - 40} more`);
  for (const c of r.devJobCommits) console.log(`  made by a dev job: ${c}`);
  process.exit(3);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: unknown) => {
    console.error(`executor-closure failed: ${err instanceof Error ? err.message : 'error'}`);
    process.exit(1);
  });
}
