import { createHash } from 'node:crypto';
import { classify, fold, parseRawDiff, type PathFact } from './paths.js';
import { lintAll, type LintInput } from './lints.js';
import { checkSupply, type NewPackage, type SupplyPort } from './supply.js';
import { CLOSURE_ENTRIES, closureChange } from './closure.js';
import { listTree, readBlobs, type GitPort } from './git.js';

/**
 * Everything a human is shown and every refusal, computed from the git objects by code (Gate 1 self-code X16, X20). The executor calls this on
 * its own copy of the bundle; the main application calls it too, for the early refusal and the card. Only the executor's result is authority.
 */
export const MAX_COMMITS = 20;
export const MAX_DIFF_BYTES = 2 * 1024 * 1024;
/** G2SC-06: the only identity a dev-job commit may carry (author and committer). */
export const DEVJOB_IDENTITY = 'dev-job <devjob@assistant.invalid>';

export interface FileFact extends PathFact { closure: boolean }
export interface Facts {
  base: string;
  head: string;
  commits: number;
  files: FileFact[];
  refusals: string[];
  flags: string[];
  lowRiskOnly: boolean;
  deps: NewPackage[];
  auditNote: string;
  /** sha256 of `git diff --no-ext-diff --no-textconv base head`, computed here; the dashboard shows the hash of its own copy (G2SC-09). */
  diffSha256: string;
}

const SHA = /^[0-9a-f]{40}$/;
const utf8 = (b: Buffer): string => b.toString('utf8');

export async function computeFacts(git: GitPort, base: string, head: string, supply: SupplyPort, now?: () => number): Promise<Facts> {
  if (!SHA.test(base) || !SHA.test(head)) throw new Error('base and head must be full commit ids');
  const refusals: string[] = [];
  const merges = Number(utf8(await git.run(['rev-list', '--merges', '--count', `${base}..${head}`])).trim());
  const commits = Number(utf8(await git.run(['rev-list', '--count', `${base}..${head}`])).trim());
  if (merges > 0) refusals.push('the branch contains a merge commit');
  if (commits < 1 || commits > MAX_COMMITS) refusals.push(`the branch has ${commits} commits (allowed 1 to ${MAX_COMMITS})`);
  // G2SC-06: every commit of the branch is by the fixed dev-job identity; the agent can run git with any name, so this is checked, not assumed.
  const idents = (await git.run(['log', '--format=%an <%ae>%n%cn <%ce>', `${base}..${head}`])).toString('utf8').split('\n').filter(Boolean);
  if (idents.some((i) => i !== DEVJOB_IDENTITY)) refusals.push('a commit has an author or committer other than the dev-job identity');
  const diffText = await git.run(['diff', '--no-ext-diff', '--no-textconv', base, head], { maxBytes: 8 * 1024 * 1024 }).catch(() => Buffer.alloc(0));
  const diffSha256 = createHash('sha256').update(diffText.subarray(0, 2 * 1024 * 1024)).digest('hex');
  const raw = await git.run(['diff', '--raw', '-z', '--no-renames', '--no-abbrev', '--no-ext-diff', '--no-textconv', base, head]);
  const verdict = classify(parseRawDiff(utf8(raw)));
  refusals.push(...verdict.refusals);

  // Contents of the changed files on both sides, for the lints, the manifest checks and the closure.
  const changed = verdict.files.map((f) => f.path);
  const [b, h] = await Promise.all([readBlobs(git, base, changed), readBlobs(git, head, changed)]);
  for (const p of [...b.oversize, ...h.oversize]) refusals.push(`file above the size cap: ${JSON.stringify(p).slice(0, 100)}`);
  const inputs: LintInput[] = verdict.files.map((f) => ({ path: f.path, base: b.files.get(f.path) ?? null, head: f.status === 'D' ? null : (h.files.get(f.path) ?? null), isTest: f.test }));
  const lint = lintAll(inputs.filter((i) => !(i.head === null && h.oversize.includes(i.path))));
  refusals.push(...lint.refusals);

  // The closure of the executor and the dev-job service, at both ends (X9).
  const [bTree, hTree] = await Promise.all([listTree(git, base), listTree(git, head)]);
  // G2SC-10: the WHOLE head tree, not only the diff. A new path that folds equal to an unchanged one overwrites it on a case-insensitive disk.
  const seenFold = new Map<string, string>();
  let collision: string | null = null;
  for (const p of hTree) {
    const segs = p.split('/');
    // every prefix (directories too): `DB/x.ts` beside `db/y.ts` merges two directories on a case-insensitive disk
    for (let i = 1; i <= segs.length && !collision; i++) {
      const pre = segs.slice(0, i).join('/');
      const f = fold(pre);
      const prev = seenFold.get(f);
      if (prev !== undefined && prev !== pre) collision = `${JSON.stringify(prev).slice(0, 80)} and ${JSON.stringify(pre).slice(0, 80)}`;
      else seenFold.set(f, pre);
    }
    if (collision) break;
  }
  if (collision) refusals.push(`two paths in the tree differ only by case or normalization: ${collision}`);
  const code = (t: string[]) => t.filter((p) => p.endsWith('.ts') && !p.endsWith('.test.ts'));
  const [bAll, hAll] = await Promise.all([readBlobs(git, base, code(bTree), 1024 * 1024), readBlobs(git, head, code(hTree), 1024 * 1024)]);
  const [bPk, hPk] = await Promise.all([readBlobs(git, base, ['package.json', 'package-lock.json'], 8 * 1024 * 1024), readBlobs(git, head, ['package.json', 'package-lock.json'], 8 * 1024 * 1024)]);
  const parse = (s: string | null | undefined): Record<string, unknown> => { try { return s ? (JSON.parse(s) as Record<string, unknown>) : {}; } catch { refusals.push('package.json or the lockfile is not valid JSON'); return {}; } };
  const baseLock = parse(bPk.files.get('package-lock.json'));
  const headLock = parse(hPk.files.get('package-lock.json'));
  const entries = CLOSURE_ENTRIES.filter((e) => bAll.files.get(e) != null || hAll.files.get(e) != null);
  const cc = closureChange(entries, { read: (p) => bAll.files.get(p) ?? null, lock: baseLock }, { read: (p) => hAll.files.get(p) ?? null, lock: headLock });
  refusals.push(...cc.refusals);
  const inClosure = new Set(cc.files);

  const sup = await checkSupply({ baseManifest: parse(bPk.files.get('package.json')), headManifest: parse(hPk.files.get('package.json')), baseLock, headLock }, supply, now);
  refusals.push(...sup.refusals);

  const diffBytes = [...h.files.values()].reduce((n, s) => n + (s ? Buffer.byteLength(s) : 0), 0);
  if (diffBytes > MAX_DIFF_BYTES) refusals.push(`the changed files add up to more than ${MAX_DIFF_BYTES} bytes`);
  const files: FileFact[] = verdict.files.map((f) => ({ ...f, closure: inClosure.has(f.path) }));
  const flags = [...lint.flags];
  for (const f of files) if (f.test && f.status !== 'A') flags.push(`test file ${f.status === 'D' ? 'deleted' : 'modified'}: ${JSON.stringify(f.path).slice(0, 100)}`);
  return { base, head, commits, files, refusals: [...new Set(refusals)], flags: [...new Set(flags)], lowRiskOnly: verdict.lowRiskOnly, deps: sup.newPackages, auditNote: sup.auditNote, diffSha256 };
}
