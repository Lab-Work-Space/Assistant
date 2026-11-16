import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildSha } from './build.js';

describe('buildSha', () => {
  it('reads the head from release.json, and is null for a plain checkout or a bad record', () => {
    const d = mkdtempSync(join(tmpdir(), 'b-'));
    try {
      expect(buildSha(d)).toBeNull();
      writeFileSync(join(d, 'release.json'), JSON.stringify({ head: 'b'.repeat(40) }));
      expect(buildSha(d)).toBe('b'.repeat(40));
      writeFileSync(join(d, 'release.json'), JSON.stringify({ head: 'nope' }));
      expect(buildSha(d)).toBeNull();
      writeFileSync(join(d, 'release.json'), '{');
      expect(buildSha(d)).toBeNull();
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
});
