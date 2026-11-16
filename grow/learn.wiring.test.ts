import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SKIP = new Set(['node_modules', 'dist', '.git', 'docs', 'vendor', 'data']);
function sources(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    if (SKIP.has(e)) continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) sources(p, out);
    else if (e.endsWith('.ts') && !e.endsWith('.test.ts')) out.push(p);
  }
  return out;
}
/** Non-comment lines of production code matching `re`, as `file:line`. */
function hits(re: RegExp): string[] {
  const out: string[] = [];
  for (const f of sources(ROOT)) {
    readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
      const t = line.trim();
      if (re.test(line) && !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*')) out.push(`${relative(ROOT, f)}:${i + 1}`);
    });
  }
  return out;
}
const files = (h: string[]) => [...new Set(h.map((x) => x.split(':')[0]))].sort();

describe('LL-C3: the taint filters have one place to live', () => {
  it('deptNotesFor, roomEntriesFor and assembleContext are each called from loop.ts only', () => {
    for (const fn of ['deptNotesFor', 'roomEntriesFor', 'assembleContext']) {
      const callers = hits(new RegExp(`(?<!function )\\b${fn}\\(`)); // a call, not the definition
      expect(files(callers), fn).toEqual(['agents/loop/loop.ts']);
      expect(callers.length, fn).toBe(1);
    }
  });
  it('the notes and room filters apply to every non-admin run (no retro-only condition)', () => {
    const src = readFileSync(join(ROOT, 'agents/loop/loop.ts'), 'utf8');
    expect(src).toContain(".filter((n) => typeof n === 'string' || n.tainted !== true)");
    expect(src).toContain('.filter((e) => !e.tainted)');
    expect(src).not.toMatch(/!trigger\.retro \|\| (typeof n|!e\.tainted)/);
    // the lessons filter and the UNVERIFIED backstop are as before
    expect(src).toContain(".filter((l) => !trigger.retro || !l.startsWith('UNVERIFIED: '))");
    expect(src).toContain("if (context.includes('UNVERIFIED: ') || roomReport.roomTainted) run.markTainted();");
  });
});

describe('LL-C7: WeeklyRetro.request has one road in', () => {
  it('only the /retro command handler (through the app closure) calls request; no AdminOp, tool, panel or config path', () => {
    expect(files(hits(/\bweeklyRetro\.request\(/))).toEqual(['app.ts']);
    expect(files(hits(/\bdeps\.retro\b/))).toEqual(['discord/commands/retro.ts']);
    expect(hits(/\.retro\?*\.request\(/)).toHaveLength(1);
    expect(files(hits(/['"]retro:run['"]/))).toEqual(['discord/commands/index.ts']);
    expect(hits(/\bretroRun\b/).filter((h) => !h.startsWith('agents/scheduler/scheduler.ts') && !h.startsWith('discord/commands/'))).toEqual([]);
    // the model-facing and panel code never names the retro service
    for (const f of sources(ROOT)) {
      const rel = relative(ROOT, f);
      if (/^(tools|admin|dashboard)\//.test(rel)) expect(readFileSync(f, 'utf8'), rel).not.toMatch(/WeeklyRetro|retro\.request|grow\.retro\.request/);
    }
  });
});

describe('LL-C6: the incident block has one producer and one consumer', () => {
  it('incidentBlock is called from loop.ts only; assembleContext takes it as plain text', () => {
    expect(files(hits(/\bincidentBlock\(/)).filter((f) => f !== 'grow/incidents.ts')).toEqual(['agents/loop/loop.ts']);
    expect(files(hits(/\bdeptIncidents\b/))).toEqual(['agents/loop/loop.ts', 'app.ts']);
  });
});
