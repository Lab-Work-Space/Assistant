import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const app = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'app.ts'), 'utf8');

describe('GROW-1: skill judge wiring in app.ts', () => {
  it('builds the judge, hands it to the SkillService, feeds the digest, and recovers at boot next to recoverAiReviews', () => {
    expect(app).toContain('skillService.setJudge(skillJudge)');
    expect(app).toMatch(/new AiDigest\(\{ repo: aiApproverRepo, skills: skillAiRepo/);
    const i = app.indexOf('void scheduler.recoverAiReviews()');
    expect(i).toBeGreaterThan(0);
    expect(app.slice(i, i + 400)).toContain('void skillJudge.recover(bootTime)');
  });
});
