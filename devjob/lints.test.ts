import { describe, expect, it } from 'vitest';
import { addedLines, lintAll, lintFile } from './lints.js';

const f = (head: string | null, o: { base?: string | null; path?: string; isTest?: boolean } = {}) => lintFile({ path: o.path ?? 'src/a.ts', head, base: o.base ?? null, isTest: o.isTest ?? false });

describe('X13 lints', () => {
  it('refuses bidi controls and zero-width characters anywhere, even in an old line', () => {
    expect(f('const a = "x‮y";').refusals.join()).toMatch(/bidirectional/);
    expect(f('const a = "x⁦y";').refusals).toHaveLength(1);
    expect(f('const a = 1;​').refusals.join()).toMatch(/zero-width/);
    expect(f('a﻿b', { base: 'a﻿b' }).refusals.join()).toMatch(/zero-width/);
  });
  it('refuses binaries and oversize files', () => {
    expect(f('a\0b').refusals.join()).toMatch(/binary/);
    expect(f('x'.repeat(300 * 1024)).refusals.join()).toMatch(/cap/);
  });
  it('flags (not refuses) new risky constructs in ADDED lines only', () => {
    const risky = [
      ["import { exec } from 'node:child_process';", /process, network/],
      ["const v = require('vm');", /process, network/],
      ['eval(x)', /eval/],
      ['const f = new Function("a")', /eval/],
      ['const m = await import(name);', /dynamic/],
      ['const k = process.env.SECRET;', /process\.env/],
      ["const u = 'https://evil.example/x';", /URL/],
      ['await fetch(u);', /outbound/],
      ['const s = "café";', /non-ASCII/],
      [`const b = "${'A'.repeat(210)}";`, /base64/],
      [`const x = 1;${' '.repeat(310)}`, /300/],
      ['const pаss = 1;', /confusable|non-ASCII/],
    ] as const;
    for (const [line, re] of risky) {
      const r = f(`const ok = 1;\n${line}`, { base: 'const ok = 1;' });
      expect(r.refusals, line).toEqual([]);
      expect(r.flags.join(), line).toMatch(re);
    }
    expect(f(`const ok = 1;\nprocess.env.X;`, { base: 'process.env.X;\nconst ok = 1;' }).flags).toEqual([]);
    expect(f('import fs from "node:fs";', { path: 'docs/a.md' }).flags).toEqual([]);
  });
  it('X12 refuses added skip/only/todo/fails/skipIf/runIf and a top-level conditional return in a test', () => {
    for (const l of ['it.skip("a", () => {});', 'describe.only("a", () => {});', 'it.todo("x");', 'it.fails("x", () => {});', 'it.skipIf(a)("x", () => {});', 'it.runIf(a)("x", () => {});', 'xit("x", () => {});', 'if (process.platform === "linux") return;']) {
      expect(f(`it("a", () => {});\n${l}`, { isTest: true, base: 'it("a", () => {});', path: 'a.test.ts' }).refusals.join(), l).toMatch(/test integrity/);
    }
    expect(f('it.skip("a", () => {});', { isTest: false }).refusals).toEqual([]);
    expect(f('it("a", () => {});', { isTest: true, base: 'it("a", () => {});' }).refusals).toEqual([]);
  });
  it('flags an edited existing test file', () => {
    expect(f('it("a",()=>{});\nit("b",()=>{});', { isTest: true, base: 'it("a",()=>{});' }).flags.join()).toMatch(/existing test file/);
  });
  it('addedLines is a multiset difference', () => {
    expect(addedLines('a\nb\nb', 'b\nb\nb\na\nc')).toEqual(['b', 'c']);
  });
  it('lintAll sums sizes and merges results', () => {
    const big = 'y'.repeat(250 * 1024);
    const r = lintAll(Array.from({ length: 10 }, (_, i) => ({ path: `src/${i}.ts`, head: big, base: null, isTest: false })));
    expect(r.refusals.join()).toMatch(/add up/);
  });
});
