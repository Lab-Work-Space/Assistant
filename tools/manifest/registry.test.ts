import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ADMIN_TOOL_NAMES } from '../../admin/names.js';
import { realRegistry } from '../autopilot.golden.harness.js';
import { GROW_TOOL_NAMES, KNOWLEDGE_TOOL_NAMES, PROJECT_TOOL_NAMES, RELEASE_TOOL_NAMES, SKILL_TOOL_NAMES, builtinTools } from '../builtin/index.js';
import { pluginGroups } from '../plugins/index.js';
import { CATALOG_NAMES, classOf } from './catalog.js';
import { NOT_IN_REAL } from './decision-matrix.harness.js';

const root = new URL('../../', import.meta.url);
const read = (rel: string): string => readFileSync(new URL(rel, root), 'utf8');
const dirs = (rel: string): string[] => readdirSync(new URL(rel, root)).filter((f) => statSync(new URL(`${rel}/${f}`, root)).isDirectory()).sort();

/** Runs the real harness while recording which group id each tool came from (wraps the factories in place for the run, then restores them). */
async function realWithGroups(): Promise<{ reg: Awaited<ReturnType<typeof realRegistry>>; groupOf: Map<string, string> }> {
  const groupOf = new Map<string, string>();
  const orig = [...pluginGroups];
  try {
    for (let i = 0; i < orig.length; i++) {
      const f = orig[i]!;
      pluginGroups[i] = (d) => {
        const g = f(d);
        if (!('disabled' in g)) for (const t of g.tools) groupOf.set(t.name, g.id);
        return g;
      };
    }
    return { reg: await realRegistry(), groupOf };
  } finally {
    pluginGroups.splice(0, pluginGroups.length, ...orig);
  }
}

describe('kind and group equality against the real registry', () => {
  it('every registered name is declared with the group it came from and the kind the registry holds', async () => {
    const { reg, groupOf } = await realWithGroups();
    const builtin = new Set([...builtinTools().map((t) => t.name), ...KNOWLEDGE_TOOL_NAMES, ...SKILL_TOOL_NAMES, ...PROJECT_TOOL_NAMES, ...RELEASE_TOOL_NAMES, ...GROW_TOOL_NAMES]);
    expect(reg.names().length).toBeGreaterThan(80);
    for (const n of reg.names()) {
      const group = groupOf.get(n) ?? (builtin.has(n) ? 'builtin' : 'UNKNOWN');
      expect(group, `${n} came from no known group`).not.toBe('UNKNOWN');
      expect(CATALOG_NAMES, `${n} is not declared in a manifest`).toContain(n);
      expect(classOf(n).group, `${n} group`).toBe(group);
      expect(classOf(n).kind, `${n} kind`).toBe(reg.kindOf(n) ?? null);
    }
  });

  it('every catalog name is either in the real registry or in NOT_IN_REAL; a name in neither fails', async () => {
    const { reg } = await realWithGroups();
    const real = new Set(reg.names());
    const orphans = CATALOG_NAMES.filter((n) => !real.has(n) && !(n in NOT_IN_REAL));
    expect(orphans, 'declared in a manifest but built nowhere (add it to NOT_IN_REAL with its code anchor, or delete it)').toEqual([]);
    for (const n of Object.keys(NOT_IN_REAL)) {
      expect(CATALOG_NAMES, n).toContain(n);
      expect(real.has(n), `${n} is in the real registry: remove it from NOT_IN_REAL`).toBe(false);
    }
    expect(Object.keys(NOT_IN_REAL).filter((n) => !(ADMIN_TOOL_NAMES as readonly string[]).includes(n)).sort()).toEqual(['clickup_delete_task', 'diagram_create', 'sheets_append_receipt', 'video_generate']);
  });

  it('NOT_IN_REAL names, groups and kinds match their code anchors', () => {
    const kindRe = /\bkind: '(read|write|destructive)'/g;
    for (const [n, a] of Object.entries(NOT_IN_REAL)) {
      const src = read(a.file);
      const at = src.indexOf(`name: '${n}'`);
      expect(at, `${n} not found in ${a.file}`).toBeGreaterThanOrEqual(0);
      const kinds = [...src.matchAll(kindRe)].filter((m) => m.index! >= at - 40).map((m) => m[1]);
      expect(a.kind === undefined ? undefined : kinds[0], `${n} kind at ${a.file}`).toBe(a.kind);
      if (a.file === 'admin/tools.ts') expect(src.match(kindRe), 'an admin tool declares no kind').toBeNull();
      const group = a.file.startsWith('admin/') ? 'admin' : a.file.split('/')[2];
      expect(classOf(n).group, n).toBe(group);
      expect(classOf(n).kind, n).toBe(a.kind ?? null);
    }
  });
});

describe('completeness (spec 3.5)', () => {
  const folders = dirs('tools/plugins');
  it('every plugin folder has a manifest.ts', () => {
    for (const f of folders) expect(existsSync(new URL(`tools/plugins/${f}/manifest.ts`, root)), `tools/plugins/${f}/manifest.ts is missing: add it`).toBe(true);
    expect(existsSync(new URL('tools/builtin/manifest.ts', root))).toBe(true);
    expect(existsSync(new URL('admin/manifest.ts', root))).toBe(true);
  });
  it('every manifest is wired into catalog.ts, with its own group, and every entry is what the catalog answers', async () => {
    const cat = read('tools/manifest/catalog.ts');
    const files = [...folders.map((f) => ({ f: `tools/plugins/${f}/manifest.ts`, group: f })), { f: 'tools/builtin/manifest.ts', group: 'builtin' }, { f: 'admin/manifest.ts', group: 'admin' }];
    expect(files).toHaveLength(17);
    let total = 0;
    for (const { f, group } of files) {
      const rel = `../../${f.replace(/\.ts$/, '.js')}`.replace('../../tools/', '../');
      expect(cat, `catalog.ts has no import of ${f}: add the line`).toContain(`from '${rel}'`);
      const mod = (await import(/* @vite-ignore */ fileURLToPath(new URL(f, root)))) as { manifest: Record<string, unknown> };
      for (const [n, e] of Object.entries(mod.manifest)) {
        total++;
        expect(classOf(n), `${n} (${f}) is not in the catalog`).toEqual(e);
        expect(classOf(n).group).toBe(group);
      }
    }
    expect(total).toBe(CATALOG_NAMES.length);
  });
  it('the number of pluginGroups entries equals the number of plugin folders, and each group id is a folder name', async () => {
    expect(pluginGroups.length, 'pluginGroups and tools/plugins/* differ: one new folder needs one pluginGroups line').toBe(folders.length);
    const { groupOf } = await realWithGroups();
    for (const g of new Set(groupOf.values())) expect(folders).toContain(g);
  });
});
