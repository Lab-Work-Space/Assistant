import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { LOW_RISK, NON_SELF_MODIFIABLE, classify, isLowRisk, isNonSelfModifiable } from './paths.js';

/** Gate 1 self-code X8 (rule 5): a classification list that matches nothing is a typo or dead code. Every tracked file is classified. */
const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: import.meta.dirname + '/..', encoding: 'utf8' }).split('\n').filter(Boolean);
/** Patterns for files this repo does not have today but that must stay refused if they ever appear. */
const FUTURE = new Set(['.github/', '.gitattributes', '.gitmodules', '.claude/', '.mcp.json', 'claude.md', 'agents.md', '.githooks/', '.husky/', 'docker-compose.devjob.yml']);

describe('path policy coverage', () => {
  it('every tracked file can be classified', () => {
    expect(files.length).toBeGreaterThan(300);
    for (const f of files) expect(() => classify([{ status: 'M', oldMode: '100644', newMode: '100644', oldSha: 'a'.repeat(40), newSha: 'b'.repeat(40), path: f }]), f).not.toThrow();
  });
  it('every non-self-modifiable pattern matches a tracked file, unless it is a known future path', () => {
    const lower = files.map((f) => f.toLowerCase());
    const dead = NON_SELF_MODIFIABLE.filter((g) => !FUTURE.has(g)).filter((g) => !lower.some((f) => isNonSelfModifiable(f) && (g.endsWith('/') ? f.startsWith(g) : new RegExp(`^${g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')}$`).test(f))));
    expect(dead).toEqual([]);
  });
  it('every low-risk pattern matches a tracked file', () => {
    for (const r of LOW_RISK) expect(files.some((f) => r.test(f.toLowerCase())), String(r)).toBe(true);
  });
  it('the dev-job machinery and the executor are all non-self-modifiable', () => {
    for (const f of files.filter((x) => /^(?:devjob|executor|docker\/devjob)\//.test(x))) expect(isNonSelfModifiable(f), f).toBe(true);
  });
  it('no source file under the main program is low risk', () => {
    for (const f of files.filter((x) => /\.(?:ts|sh|json|yml|sql)$/.test(x))) expect(isLowRisk(f), f).toBe(false);
  });
});
