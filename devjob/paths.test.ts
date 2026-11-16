import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { classify, fold, isLowRisk, isNonSelfModifiable, parseRawDiff, type RawEntry } from './paths.js';

const Z = 'a'.repeat(40);
const e = (path: string, o: Partial<RawEntry> = {}): RawEntry => ({ status: 'M', oldMode: '100644', newMode: '100644', oldSha: Z, newSha: Z, path, ...o });

describe('parseRawDiff', () => {
  it('parses a -z raw diff and rejects malformed input', () => {
    const z = `:100644 100644 ${Z} ${'b'.repeat(40)} M\0src/a.ts\0:000000 100644 ${'0'.repeat(40)} ${Z} A\0docs/x.md\0`;
    expect(parseRawDiff(z).map((x) => [x.status, x.path])).toEqual([['M', 'src/a.ts'], ['A', 'docs/x.md']]);
    expect(parseRawDiff('')).toEqual([]);
    expect(() => parseRawDiff(`:100644 100644 ${Z} ${Z} M\0a`)).toThrow();
    expect(() => parseRawDiff(`:100644 100644 ${Z} ${Z} R100\0a\0b\0`)).toThrow();
    expect(() => parseRawDiff(`junk\0a\0`)).toThrow();
  });
  it('reads real git output', () => {
    const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8' });
    const d = execFileSync('mktemp', ['-d'], { encoding: 'utf8' }).trim();
    git(d, 'init', '-q'); git(d, 'config', 'user.email', 'a@b'); git(d, 'config', 'user.name', 'n');
    execFileSync('sh', ['-c', 'echo 1 > a.txt && git add . && git commit -qm1 && git mv a.txt b.txt && git commit -qam2'], { cwd: d });
    const raw = git(d, 'diff', '--raw', '-z', '--no-renames', '--no-abbrev', 'HEAD~1', 'HEAD');
    expect(parseRawDiff(raw).map((x) => `${x.status}:${x.path}`).sort()).toEqual(['A:b.txt', 'D:a.txt']);
  });
});

describe('X11 classify', () => {
  it('folds case and normalization: Executor/Confirm.ts is the executor', () => {
    expect(isNonSelfModifiable('Executor/Confirm.ts')).toBe(true);
    expect(fold('Café')).toBe(fold('Café'));
    expect(classify([e('Executor/Confirm.ts')]).refusals.join()).toMatch(/non-self-modifiable/);
  });
  it.each([
    ['non-ASCII', e('docs/café.md')],
    ['control byte', e('docs/a\nb.md')],
    ['dot-dot', e('docs/../x.md')],
    ['leading dash', e('docs/-rf.md')],
    ['inside .git', e('docs/.Git/config')],
    ['symlink', e('docs/a.md', { status: 'A', newMode: '120000' })],
    ['gitlink', e('docs/a', { status: 'A', newMode: '160000' })],
    ['exec bit', e('docs/a.md', { newMode: '100755' })],
    ['odd mode', e('docs/a.md', { newMode: '100664' })],
    ['type change', e('docs/a.md', { status: 'T' })],
  ])('refuses %s', (_n, x) => {
    expect(classify([x]).refusals.length).toBeGreaterThan(0);
  });
  it('a deleted symlink or gitlink is fine, an unchanged exec bit is fine', () => {
    expect(classify([e('docs/a.md', { status: 'D', oldMode: '120000', newMode: '000000' })]).refusals).toEqual([]);
    expect(classify([e('docs/a.md', { oldMode: '100755', newMode: '100755' })]).refusals).toEqual([]);
  });
  it('refuses two paths that differ only by case; a rename (D + A) checks both sides', () => {
    expect(classify([e('docs/A.md', { status: 'A' }), e('docs/a.md', { status: 'A' })]).refusals.join()).toMatch(/differ only by case/);
    const v = classify([e('executor/confirm.ts', { status: 'D' }), e('src/confirm.ts', { status: 'A' })]);
    expect(v.refusals.join()).toMatch(/executor\/confirm\.ts/);
    expect(v.files).toHaveLength(2);
  });
  it('an empty diff and an oversized diff are refused', () => {
    expect(classify([]).refusals).toHaveLength(1);
    expect(classify(Array.from({ length: 201 }, (_, i) => e(`docs/${i}.md`))).refusals.join()).toMatch(/limit/);
  });
  it('protected by default: only plain docs text is low risk', () => {
    expect(classify([e('docs/guide.md')]).lowRiskOnly).toBe(true);
    expect(classify([e('docs/guide.md'), e('tools/plugins/new/index.ts', { status: 'A' })]).lowRiskOnly).toBe(false);
    expect(classify([e('docs/script.sh')]).lowRiskOnly).toBe(false);
    expect(classify([e('README.md')]).lowRiskOnly).toBe(true);
    expect(isLowRisk('DOCS/Guide.MD')).toBe(true);
    expect(isLowRisk('docs/a/b.png')).toBe(false);
  });
  it('flags test files', () => {
    expect(classify([e('tools/x.test.ts')]).files[0]!.test).toBe(true);
    expect(classify([e('tests/helper.ts')]).files[0]!.test).toBe(true);
    expect(classify([e('tools/x.ts')]).files[0]!.test).toBe(false);
  });
});

describe('X10 non-self-modifiable set', () => {
  it.each([
    'prompts/protected.ts', 'prompts/system/safety.md', 'prompts/system/tool-use.md', 'prompts/fragments/approval-request.md',
    'devjob/paths.ts', 'docker/devjob/Dockerfile', 'docker-compose.devjob.yml', 'executor/confirm.ts', 'scripts/executor-service.sh', 'health.ts',
    '.npmrc', 'tsconfig.json', 'tsconfig.build.json', 'vitest.config.ts', 'vitest.setup.no-network.ts', 'tools/plugins/github/deny.ts',
    'tools/plugins/github/deploy-repos.json', 'scripts/gen-deploy-denylist.ts', '.github/workflows/x.yml', '.gitattributes', '.gitmodules',
    '.claude/settings.json', '.mcp.json', 'CLAUDE.md', 'AGENTS.md', 'db/migrations/017_x.up.sql', 'governance/budget.ts',
    'admin/tools.ts', 'core/release-watch.ts', 'core/build.ts', 'scripts/executor-closure.ts', 'scripts/dev.sh', 'agents/context.ts',
    // R4 PM-C11: the tool manifests and the reviewed policy files
    'tools/manifest/catalog.ts', 'tools/manifest/privileged.json', 'tools/manifest/floor.ts', 'tools/__golden__/decision-matrix.json', 'tools/__golden__/autopilot-classes.json',
    'tools/plugins/web/manifest.ts', 'tools/plugins/new-plugin/manifest.ts', 'tools/builtin/manifest.ts', 'admin/manifest.ts', 'Tools/Manifest/Catalog.ts',
    // R4 Gate 2: helpers and harness of the protected golden and catalog tests
    'tests/fakes/golden.ts', 'tests/fakes/tool-classes.ts', 'tools/autopilot.golden.harness.ts', 'tools/autopilot.golden.test.ts', 'tools/autopilot.company.golden.test.ts',
    // R5 RL-C6: the release guarantee (service, targets, boundary tests, repo, tool, command layer)
    'releases/service.ts', 'releases/targets.ts', 'releases/boundary.test.ts', 'releases/service.test.ts', 'Releases/Service.ts', 'db/repos/releases.ts', 'tools/builtin/releases.ts', 'discord/commands/release.ts',
  ])('%s is refused', (p) => {
    expect(isNonSelfModifiable(p)).toBe(true);
  });
  it.each(['tools/plugins/foo/index.ts', 'tools/plugins/foo/sub/manifest.ts', 'tests/fakes/net.ts', 'tools/autopilot.ts', 'tools/builtin/index.ts', 'admin/names.ts', 'docs/a.md', 'agents/x.ts', 'prompts/heads/a.md'])('%s is not in the set', (p) => {
    expect(isNonSelfModifiable(p)).toBe(false);
  });
});

describe('R5 RL-C6: the four release paths are refused', () => {
  it.each(['releases/service.ts', 'db/repos/releases.ts', 'tools/builtin/releases.ts', 'discord/commands/release.ts'])('%s', (p) => {
    expect(isNonSelfModifiable(p)).toBe(true);
  });
  it('a sibling that is not part of the guarantee stays editable', () => {
    expect(isNonSelfModifiable('discord/commands/provider.ts')).toBe(false);
    expect(isNonSelfModifiable('db/repos/releasex.ts')).toBe(false);
  });
});

describe('NON_SELF_MODIFIABLE stays pointed at real files', () => {
  it('every exact source path in the list exists (a moved file would silently drop its protection)', async () => {
    const { existsSync } = await import('node:fs');
    const { NON_SELF_MODIFIABLE } = await import('./paths.js');
    const root = new URL('..', import.meta.url);
    const exact = NON_SELF_MODIFIABLE.filter((p) => !p.endsWith('/') && !p.includes('*') && /\.(?:ts|sh|md)$/.test(p) && p.includes('/'));
    expect(exact.length).toBeGreaterThan(10);
    expect(exact.filter((p) => !existsSync(new URL(p, root)))).toEqual([]);
  });
  it('R4 PM-C11: every manifest and policy pattern matches at least one real file, and every real manifest file matches', async () => {
    const { readdirSync, existsSync } = await import('node:fs');
    const { NON_SELF_MODIFIABLE } = await import('./paths.js');
    const root = new URL('..', import.meta.url);
    const list = (rel: string): string[] => readdirSync(new URL(rel, root), { recursive: true, withFileTypes: false }).map(String).map((f) => `${rel}${f}`);
    const patterns = ['tools/manifest/', 'tools/__golden__/', 'tools/plugins/*/manifest.ts', 'tools/builtin/manifest.ts', 'admin/manifest.ts'];
    for (const p of patterns) expect(NON_SELF_MODIFIABLE, p).toContain(p);
    for (const rel of ['tools/manifest/', 'tools/__golden__/']) expect(list(rel).length, rel).toBeGreaterThan(0);
    const manifests = [
      ...readdirSync(new URL('tools/plugins/', root), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => `tools/plugins/${d.name}/manifest.ts`),
      'tools/builtin/manifest.ts', 'admin/manifest.ts',
    ];
    expect(manifests.length).toBe(17);
    for (const m of manifests) {
      expect(existsSync(new URL(m, root)), m).toBe(true);
      expect(isNonSelfModifiable(m), m).toBe(true);
    }
    for (const f of [...list('tools/manifest/'), ...list('tools/__golden__/')]) expect(isNonSelfModifiable(f), f).toBe(true);
    expect(isNonSelfModifiable('tools/plugins/foo/index.ts')).toBe(false);
  });
});
