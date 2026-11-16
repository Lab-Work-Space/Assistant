import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { canonicalGolden, readGolden, updateRequested } from './golden.js';

let dir = '';
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = ''; });
const tmp = (): URL => { dir = mkdtempSync(join(tmpdir(), 'golden-')); return pathToFileURL(join(dir, 'g.json')); };

describe('the golden writer (spec 5.2, PM-C11)', () => {
  it('canonicalGolden sorts keys at every level, indents by 2 and ends with a newline', () => {
    expect(canonicalGolden({ b: '1', a: { d: 1, c: [{ z: 1, y: 2 }] } })).toBe('{\n  "a": {\n    "c": [\n      {\n        "y": 2,\n        "z": 1\n      }\n    ],\n    "d": 1\n  },\n  "b": "1"\n}\n');
  });
  it('without GOLDEN_UPDATE a read returns the committed text and writes nothing; a missing file is an error and is not created', () => {
    const f = tmp();
    expect(() => readGolden(f, 'x\n', {})).toThrow(/golden file missing/);
    expect(existsSync(f)).toBe(false);
    writeFileSync(f, 'old\n');
    expect(readGolden(f, 'new\n', {})).toBe('old\n');
    expect(readFileSync(f, 'utf8')).toBe('old\n');
  });
  it('GOLDEN_UPDATE=1 writes the observed text and then fails the run so the diff is reviewed', () => {
    const f = tmp();
    writeFileSync(f, 'old\n');
    expect(() => readGolden(f, 'new\n', { GOLDEN_UPDATE: '1' })).toThrow('golden updated; review the diff');
    expect(readFileSync(f, 'utf8')).toBe('new\n');
  });
  it('is refused (and writes nothing) when CI, DEVJOB or DEVJOB_SANDBOX is set', () => {
    for (const k of ['CI', 'DEVJOB', 'DEVJOB_SANDBOX']) {
      const f = tmp();
      writeFileSync(f, 'old\n');
      expect(() => readGolden(f, 'new\n', { GOLDEN_UPDATE: '1', [k]: 'true' }), k).toThrow(/GOLDEN_UPDATE is refused/);
      expect(readFileSync(f, 'utf8'), k).toBe('old\n');
      expect(() => updateRequested({ GOLDEN_UPDATE: '1', [k]: '1' }), k).toThrow(/refused/);
    }
    expect(updateRequested({})).toBe(false);
  });
});
