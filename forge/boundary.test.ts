import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * R7 PLUGIN-FORGE (spec 6, PF-C13, PF-C19, FG-AC21): import boundaries and holders for the BE1 code. A raw-text scan of the production sources: static, `export ... from`, dynamic `import()`, `require()`;
 * absolute paths and `file:` URLs are resolved; `createRequire` and a non-literal specifier are findings. BE2 extends this with the app.ts wiring holders.
 */
const root = fileURLToPath(new URL('../', import.meta.url));
const SKIP = new Set(['node_modules', 'dist', '.git', 'vendor', 'data', 'docs', 'workspaces-data']);
const LINKS: string[] = [];
function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isSymbolicLink()) { if (!SKIP.has(e.name)) LINKS.push(path.relative(root, p)); continue; }
    if (e.isDirectory()) { if (!SKIP.has(e.name) && !p.includes(`${path.sep}tests${path.sep}fixtures`)) walk(p, out); }
    else if (e.name.endsWith('.ts') && !/\.test\.ts$/.test(e.name) && !e.name.endsWith('test-helpers.ts')) out.push(path.relative(root, p));
  }
  return out;
}
const strip = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const files = walk(root);
const src = (f: string): string => strip(readFileSync(path.join(root, f), 'utf8'));

function specs(text: string): { list: string[]; findings: string[] } {
  const list: string[] = [];
  const findings: string[] = [];
  for (const m of text.matchAll(/(?:\bfrom\s+|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)(['"`])((?:\\.|(?!\1).)*)\1/g)) list.push(m[2]!.replace(/\\(.)/g, '$1'));
  if (/\bcreateRequire\b/.test(text)) findings.push('createRequire');
  if (/\bimport\s*\(\s*[^'"`\s)]/.test(text) || /\brequire\s*\(\s*[^'"`\s)]/.test(text)) findings.push('non-literal import');
  return { list, findings };
}
/** The repo-relative module a specifier names (without extension), or null for a package or a node: module. */
function resolve(from: string, spec: string): string | null {
  let s = spec;
  // G2-FG-02: every file: URL form Node loads (file:///abs, file:/abs, percent-encoded letters) is decoded the way Node decodes it; a URL Node would refuse is its own marker
  if (/^file:/i.test(s)) { try { s = fileURLToPath(s); } catch { return '<bad file url>'; } }
  if (!s.startsWith('.') && !s.startsWith('/')) return null;
  s = s.startsWith('/') ? path.relative(root, s) : path.relative(root, path.resolve(root, path.dirname(from), s));
  return s.replace(/\.(?:js|ts)$/, '');
}
// G2-FG-02: the regex comment strip cannot tell a '/*' inside a string from a comment, so the raw text is scanned too (it can only add references: a commented import counts)
const importsOfText = (f: string, text: string): string[] => [...new Set([...specs(strip(text)).list, ...specs(text).list])].map((s) => resolve(f, s)).filter((x): x is string => x !== null);
const importsOf = (f: string): string[] => importsOfText(f, readFileSync(path.join(root, f), 'utf8'));
const forgeFiles = files.filter((f) => f.startsWith('forge/'));

describe('BE2 (FG-AC21, PF-C13, PF-C19): who may import the forge runtime', () => {
  const importersOf = (...mods: string[]): string[] => files.filter((f) => !f.startsWith('forge/') && importsOf(f).some((m) => mods.includes(m))).sort();
  it('forge/service, forge/builder, forge/port and forge/enqueue are imported outside forge/ by app.ts only', () => {
    expect(importersOf('forge/service', 'forge/builder', 'forge/port', 'forge/enqueue')).toEqual(['app.ts']);
  });
  it('forge/notes is imported by app.ts-free consumers only through the loop (agents/loop/loop.ts); nothing else reads idea text', () => {
    expect(importersOf('forge/notes')).toEqual(['agents/loop/loop.ts']);
  });
  it('forge/texts is imported outside forge/ only by the incident modules (the closed code list)', () => {
    expect(importersOf('forge/texts')).toEqual(['db/repos/dept-incidents.ts', 'grow/incidents.ts']);
  });
  it('discord/commands/forge.ts imports only types of the forge (forge/types) and no repo, service or db module', () => {
    const imps = specs(src('discord/commands/forge.ts')).list;
    expect(imps.filter((x) => /forge/.test(x))).toEqual(['../../forge/types.js']);
    expect(src('discord/commands/forge.ts')).toMatch(/import type \{ ForgeCancelResult \} from '..\/..\/forge\/types.js';/);
    expect(importsOf('discord/commands/forge.ts').filter((m) => m.startsWith('db/') || m.startsWith('mcp/') || m.startsWith('releases/'))).toEqual([]);
  });
  it('mcp/admin.ts and db/repos/mcp.ts import only forge/types and forge/validate (the label guard); nothing of the builder or the service', () => {
    for (const f of ['mcp/admin.ts', 'db/repos/mcp.ts']) for (const m of importsOf(f)) if (m.startsWith('forge/')) expect(['forge/types', 'forge/validate'], `${f} imports ${m}`).toContain(m);
  });
  it('the forge guarantee cannot reach the admin console: nothing under admin/ mentions the forge except the settings key list (admin/keys.ts)', () => {
    for (const f of files.filter((x) => x.startsWith('admin/') && x !== 'admin/keys.ts')) expect(src(f), f).not.toMatch(/forge/i);
    expect(src('admin/keys.ts').match(/forge/gi)!.every((m) => m.length > 0)).toBe(true);
  });
  it('no production file in forge/ or releases/ calls activate, approve or stage of the MCP admin or repo (a card approve never activates; only /mcp approve does)', () => {
    for (const f of files.filter((x) => x.startsWith('forge/') || x.startsWith('releases/'))) expect(src(f), f).not.toMatch(/\.activate\(|\.approve\(|mcpAdmin|McpAdmin|McpRepo/);
  });
  it('only the closed set of files names the plugin_builds and plugin_forges tables outside migrations: the forge repo, the mcp repo read, the project repo link and the incident statement', () => {
    expect(files.filter((f) => /\bplugin_(builds|forges)\b/.test(src(f))).sort()).toEqual(['db/repos/dept-incidents.ts', 'db/repos/forge.ts', 'db/repos/mcp.ts', 'db/repos/projects.ts']);
  });
});

describe('PF-C19 / FG-AC21: forge/ and releases/ import boundaries', () => {
  it('there are forge production files to scan', () => { expect(forgeFiles.length).toBeGreaterThanOrEqual(8); });
  it('no createRequire or non-literal import in forge/, releases/, db/repos/forge.ts', () => {
    for (const f of [...forgeFiles, ...files.filter((x) => x.startsWith('releases/')), 'db/repos/forge.ts']) expect(specs(src(f)).findings, f).toEqual([]);
  });
  it('forge/ imports none of: mcp/admin, mcp/sandbox, db/repos/mcp, releases/service, providers/, agents/, governance/{ai-approver,autopilot,judge-call,skill-judge}, tools/autopilot', () => {
    const banned = [/^mcp\/admin$/, /^mcp\/sandbox$/, /^mcp\/host$/, /^mcp\/tool$/, /^db\/repos\/mcp$/, /^releases\/service$/, /^providers\//, /^agents\//, /^governance\/(ai-approver|autopilot|judge-call|skill-judge)/, /^tools\/autopilot/];
    for (const f of forgeFiles) for (const m of importsOf(f)) for (const b of banned) expect(b.test(m), `${f} imports ${m}`).toBe(false);
  });
  it('forge/ spawns nothing itself (the docker port is injected) and uses no console', () => {
    for (const f of forgeFiles) {
      const t = src(f);
      expect(t, f).not.toMatch(/node:child_process|\bspawn\s*\(|\bexecFile\s*\(|\bexecSync\s*\(|\bconsole\./);
    }
  });
  it('releases/ imports forge/ only through types, validate and unzip', () => {
    for (const f of files.filter((x) => x.startsWith('releases/'))) for (const m of importsOf(f)) if (m.startsWith('forge/')) expect(['forge/types', 'forge/validate', 'forge/unzip'], `${f} imports ${m}`).toContain(m);
  });
  it('nothing in releases/ or forge/ imports mcp/admin (mcp/boundary.test.ts stays true)', () => {
    for (const f of files.filter((x) => x.startsWith('releases/') || x.startsWith('forge/'))) expect(importsOf(f), f).not.toContain('mcp/admin');
  });
  it('db/repos/forge.ts is imported only by forge/ and app.ts', () => {
    const importers = files.filter((f) => importsOf(f).includes('db/repos/forge')).sort();
    expect(importers.every((f) => f.startsWith('forge/') || f === 'app.ts'), importers.join(',')).toBe(true);
  });
  it('db/repos/forge-test-helpers.ts is imported by tests only (it is not a production module)', () => {
    expect(files.filter((f) => importsOf(f).includes('db/repos/forge-test-helpers'))).toEqual([]);
  });
  it('ForgeService is constructed only in forge/service.ts and (BE2) app.ts', () => {
    const holders = files.filter((f) => /\bnew\s+ForgeService\b/.test(src(f)));
    expect(holders.every((f) => f === 'app.ts' || f === 'forge/service.ts'), holders.join(',')).toBe(true);
    const importers = files.filter((f) => importsOf(f).some((m) => m === 'forge/service' || m === 'forge/builder')).filter((f) => !f.startsWith('forge/'));
    expect(importers.every((f) => f === 'app.ts'), importers.join(',')).toBe(true);
  });
  it('McpAdmin.stageRelease is reached only through forge closures: no production file but mcp/admin.ts names it (the forgeStageDeps closure is BE2)', () => {
    const holders = files.filter((f) => /\bstageRelease\b/.test(src(f))).sort();
    expect(holders.every((f) => f === 'mcp/admin.ts' || f === 'app.ts' || f.startsWith('forge/')), holders.join(',')).toBe(true);
  });
  it('every logger call in forge/ carries error names and codes only', () => {
    for (const f of forgeFiles) for (const m of src(f).matchAll(/\blog\.error\(\s*\{([^}]*)\}/g)) {
      const keys = m[1]!.split(',').map((k) => k.trim().split(':')[0]!.trim()).filter(Boolean);
      expect(keys.every((k) => k === 'errName' || k === 'code'), `${f}: ${m[1]}`).toBe(true);
    }
  });
  it('the dev-time symlink and directory guards of this scan work (a sanity check on the walker)', () => {
    expect(lstatSync(path.join(root, 'forge')).isDirectory()).toBe(true);
    expect(files).toContain('forge/builder.ts');
  });
});

describe('G2-FG-02 (Gate 2): the scanner itself sees what Node would load', () => {
  const svc = path.join(root, 'forge', 'service.js');
  it('an import after a string that holds a comment opener is still seen (the raw text is scanned too)', () => {
    expect(importsOfText('agents/x.ts', "const a = '/*';\nimport { ForgeService } from '../forge/service.js';\nconst b = '*/';\n")).toContain('forge/service');
  });
  it('file: URLs resolve in every form Node accepts: file:///abs, file:/abs and percent-encoded letters', () => {
    expect(resolve('agents/x.ts', pathToFileURL(svc).href)).toBe('forge/service');
    expect(resolve('agents/x.ts', `file:${svc}`)).toBe('forge/service');
    expect(resolve('agents/x.ts', pathToFileURL(svc).href.replace('/service.js', '/%73ervice.js'))).toBe('forge/service');
  });
  it('the scanned tree has no symlink (a linked file or directory would give a guarded module a second path)', () => {
    expect(LINKS).toEqual([]);
  });
});
