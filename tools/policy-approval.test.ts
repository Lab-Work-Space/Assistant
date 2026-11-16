import { describe, expect, it } from 'vitest';
import { approvalFor } from './policy-approval.js';

const S = { tool: 'clickup_create', target: 'list 42', change: 'create task "Ship it"' };
const ctx = (direct: boolean, tainted = false) => ({ direct, tainted: () => tainted });

describe('approvalFor', () => {
  it('read never; write skips approval only when direct and untainted; delegated, voice, schedule, watch, reminder, poll, import always ask; destructive always', () => {
    expect(approvalFor('read', ctx(false, true), S)).toBe(false);
    expect(approvalFor('read', ctx(true), S)).toBe(false);
    expect(approvalFor('write', ctx(true, false), S)).toBe(false);
    expect(approvalFor('write', ctx(true, true), S)).toMatchObject({ reason: expect.any(String) });
    // delegated, voice, schedule, watch, reminder, poll and import runs are never direct: tools/direct.test.ts covers each, so ctx.direct=false asks
    expect(approvalFor('write', ctx(false, false), S)).toEqual({ reason: 'tool clickup_create on list 42: create task "Ship it"' });
    expect(approvalFor('destructive', ctx(true, false), S)).toMatchObject({ reason: expect.any(String) });
    expect(approvalFor('destructive', ctx(false, true), S)).toMatchObject({ reason: expect.any(String) });
  });

  it('reason redacts secrets and is capped', () => {
    const r = approvalFor('write', ctx(false), { tool: 't', target: 'postgres://u:hunter2@db/x', change: 'x'.repeat(2000) });
    const reason = (r as { reason: string }).reason;
    expect(reason).not.toContain('hunter2');
    expect(reason.length).toBeLessThanOrEqual(500);
  });
});
