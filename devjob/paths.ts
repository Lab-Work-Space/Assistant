/**
 * Dev-job path policy (Gate 1 self-code X8, X10, X11). Pure code shared by the main application and the executor: both compute the same
 * answer from the same raw diff, and only the executor's answer is authority.
 *
 * The whole `devjob/` directory is itself non-self-modifiable (X10): the matcher, the lints, the launcher, the proxies, the reviewer
 * and the limits live here.
 */
export interface RawEntry {
  /** A, M, D, T (type change) or another letter git prints; with --no-renames a rename is a D and an A. */
  status: string;
  oldMode: string;
  newMode: string;
  /** Blob ids of the two sides (all zeros = absent). */
  oldSha: string;
  newSha: string;
  path: string;
}

/** Parses `git diff --raw -z --no-renames --no-abbrev`. Anything that is not exactly that shape throws (fail closed). */
export function parseRawDiff(z: string): RawEntry[] {
  const out: RawEntry[] = [];
  if (z === '') return out;
  const parts = z.split('\0');
  if (parts[parts.length - 1] !== '') throw new Error('raw diff is not NUL terminated');
  parts.pop();
  if (parts.length % 2 !== 0) throw new Error('raw diff has an odd number of fields');
  for (let i = 0; i < parts.length; i += 2) {
    const m = /^:(\d{6}) (\d{6}) ([0-9a-f]{40,64}) ([0-9a-f]{40,64}) ([A-Z])$/.exec(parts[i]!);
    if (!m) throw new Error('raw diff entry is malformed');
    if (m[5] === 'R' || m[5] === 'C') throw new Error('rename or copy in a --no-renames diff');
    out.push({ oldMode: m[1]!, newMode: m[2]!, oldSha: m[3]!, newSha: m[4]!, status: m[5]!, path: parts[i + 1]! });
  }
  return out;
}

/** APFS is case and normalization insensitive: every comparison uses this form (X11). */
export const fold = (p: string): string => p.normalize('NFC').toLowerCase();

const PROTECTED_PROMPTS = ['prompts/protected.ts', 'prompts/system/safety.md', 'prompts/system/tool-use.md', 'prompts/fragments/approval-request.md'];

/** X10: refused outright. Lower case; matched on the folded path. A trailing `/` is a prefix, anything else an exact path or a `*` glob on one segment. */
export const NON_SELF_MODIFIABLE: readonly string[] = [
  ...PROTECTED_PROMPTS,
  // the dev-job machinery: matcher, lints, launcher, proxies, reviewer, limits, images, compose file
  'devjob/', 'docker/devjob/', 'docker-compose.devjob.yml',
  'governance/budget.ts', 'governance/limits.ts',
  // the executor and everything that applies or rolls back
  'executor/', 'scripts/executor-service.sh', 'scripts/executor-role.ts', 'health.ts',
  // G2SC-07: the taint gate's inputs, the release watcher and build record, the install-time closure report, the dev launcher and the context that computes taint
  'admin/tools.ts', 'core/release-watch.ts', 'core/build.ts', 'scripts/executor-closure.ts', 'scripts/dev.sh', 'agents/context.ts',
  // build and test configuration
  '.npmrc', 'tsconfig*.json', 'vitest.config.ts', 'vitest.setup.no-network.ts',
  // R4 PM-C11: the tool manifests and the reviewed policy files (privileged.json, the goldens) decide approval, autopilot and sensitivity; a bot may never edit them
  'tools/manifest/', 'tools/__golden__/', 'tools/plugins/*/manifest.ts', 'tools/builtin/manifest.ts', 'admin/manifest.ts',
  // R4 Gate 2: the helpers and harness the golden and catalog tests depend on (a bot diff could otherwise weaken a protected test through its helper)
  'tests/fakes/golden.ts', 'tests/fakes/tool-classes.ts', 'tools/autopilot.golden.harness.ts', 'tools/autopilot.golden.test.ts', 'tools/autopilot.company.golden.test.ts',
  // R5 RL-C6: the release guarantee (the service and targets, the repo, the tool, the command layer; the boundary tests live under releases/)
  'releases/', 'db/repos/releases.ts', 'tools/builtin/releases.ts', 'discord/commands/release.ts',
  // R6 MCP-1 (MCP-AC26): the MCP guarantee (admin, sandbox, host and boundary tests under mcp/, the repo, the command layer, the fixture server; tools/manifest/external.ts is covered above)
  'mcp/', 'db/repos/mcp.ts', 'discord/commands/mcp.ts', 'tests/fixtures/mcp/',
  // R7 PLUGIN-FORGE (PF-C13, FG-AC22): the forge guarantee (service, builder, validator and boundary tests under forge/, the repo, the command layer, the base image and its pin, the fixture plugin), plus the
  // files that hold the forge's switches and its idea link: the forbidden-key list, the settings keys and risk, the project service, and the incident log the build failures feed
  'forge/', 'db/repos/forge.ts', 'db/repos/forge.*', 'db/repos/forge-test-helpers.ts', 'discord/commands/forge.ts', 'discord/commands/forge.*', 'docker/forge/', 'tests/fixtures/forge/', 'discord/commands/types.ts', 'admin/keys.ts', 'governance/projects.ts', 'db/repos/dept-incidents.ts', 'grow/incidents.ts',
  // G2-FG-04 (Gate 2): the idea taint the forge relies on (GW-C24) is enforced at link time in db/repos/projects.ts (`tainted = false` under FOR UPDATE), computed in grow/tool-ideas.ts and stored by db/repos/grow.ts
  'db/repos/projects.ts', 'grow/tool-ideas.ts', 'db/repos/grow.ts',
  // GitHub write guards
  'tools/plugins/github/deny.ts', 'tools/plugins/github/deploy-repos.json', 'scripts/gen-deploy-denylist.ts',
  // repo machinery
  '.github/', '.gitattributes', '.gitmodules', '.claude/', '.mcp.json', 'claude.md', 'agents.md', '.githooks/', '.husky/',
  // OD-3: a forward-only migration cannot be rolled back
  'db/migrations/',
];

/** X8: the only paths that skip the security pass and the owner-only rule: plain documentation text. The allowlist is part of this file, so it is non-self-modifiable. */
export const LOW_RISK: readonly RegExp[] = [/^docs\/(?:[a-z0-9_.-]+\/)*[a-z0-9_.-]+\.(?:md|txt)$/, /^readme\.md$/];

const globToRe = (g: string): RegExp => new RegExp(`^${g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')}$`);
type Matcher = { prefix: string } | { re: RegExp };
const NON_SELF_RES: Matcher[] = NON_SELF_MODIFIABLE.map((g) => (g.endsWith('/') ? { prefix: g } : { re: globToRe(g) }));

export function isNonSelfModifiable(path: string): boolean {
  const f = fold(path);
  return NON_SELF_RES.some((m) => ('prefix' in m ? f.startsWith(m.prefix) : m.re.test(f)));
}
export const isLowRisk = (path: string): boolean => LOW_RISK.some((r) => r.test(fold(path)));
export const isTestFile = (path: string): boolean => /(?:^|\/)[^/]+\.(?:test|spec)\.[cm]?[jt]sx?$/.test(fold(path)) || /(?:^|\/)tests?\//.test(fold(path));

export interface PathFact {
  path: string;
  status: string;
  protected: boolean;
  nonSelfModifiable: boolean;
  test: boolean;
}
export interface PathVerdict {
  /** Refusals: any one ends the job; nothing (a reviewer, a click) unlocks them. */
  refusals: string[];
  files: PathFact[];
  /** True when every path is on the low-risk allowlist. False = the security pass and the owner-only rule apply. */
  lowRiskOnly: boolean;
}

export const MAX_FILES = 200;

/** X11: classification that cannot be dodged by case, normalization, rename, symlink, submodule, mode or odd segments. */
export function classify(entries: readonly RawEntry[]): PathVerdict {
  const refusals: string[] = [];
  const files: PathFact[] = [];
  const seen = new Map<string, string>();
  if (entries.length === 0) refusals.push('the diff changes nothing');
  if (entries.length > MAX_FILES) refusals.push(`the diff changes ${entries.length} files (limit ${MAX_FILES})`);
  for (const e of entries) {
    const shown = JSON.stringify(e.path).slice(0, 120);
    // eslint-disable-next-line no-control-regex
    if (/[^\x20-\x7e]/.test(e.path)) refusals.push(`non-ASCII or control bytes in a path: ${shown}`);
    const segs = e.path.split('/');
    if (e.path.startsWith('/') || segs.some((s) => s === '' || s === '.' || s === '..' || s.startsWith('-'))) refusals.push(`unsafe path segment: ${shown}`);
    if (segs.some((s) => fold(s) === '.git')) refusals.push(`a path inside .git: ${shown}`);
    if (e.status !== 'D') {
      if (e.newMode === '120000') refusals.push(`symlink: ${shown}`);
      if (e.newMode === '160000') refusals.push(`submodule or gitlink: ${shown}`);
      if (e.newMode === '100755' && e.oldMode !== '100755') refusals.push(`mode change to executable: ${shown}`);
      if (e.newMode !== '100644' && e.newMode !== '100755' && e.newMode !== '120000' && e.newMode !== '160000') refusals.push(`unexpected file mode ${e.newMode}: ${shown}`);
    }
    if (e.status === 'T') refusals.push(`type change: ${shown}`);
    const f = fold(e.path);
    // A and D of the same folded path (a rename) are fine; two different paths folding together are not.
    const prev = seen.get(f);
    if (prev !== undefined && prev !== e.path) refusals.push(`two paths differ only by case or normalization: ${shown}`);
    seen.set(f, e.path);
    const nonSelf = isNonSelfModifiable(e.path);
    if (nonSelf) refusals.push(`non-self-modifiable path: ${shown}`);
    files.push({ path: e.path, status: e.status, protected: !isLowRisk(e.path), nonSelfModifiable: nonSelf, test: isTestFile(e.path) });
  }
  return { refusals: [...new Set(refusals)], files, lowRiskOnly: files.length > 0 && files.every((x) => !x.protected) };
}
