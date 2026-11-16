import { describe, expect, it } from 'vitest';
import type { Approval } from '../../db/repos/ledger.js';
import { buildMessage } from './index.js';
import { batchApprovalPayload, toolApprovalPayload } from './approval.js';

const mk = (id: number, aiReview?: string | null, input: Record<string, unknown> = { query: 'cats' }): Approval => ({
  id, taskId: 'x'.repeat(64), reason: 'Tool call: every change needs approval', estCostUsd: 0, requestedBy: 'head:software', status: 'pending', decidedBy: null,
  createdAt: new Date(), decidedAt: null, toolName: 'web_search', toolInput: input, inputSha256: 'a'.repeat(64), kind: 'tool', ...(aiReview !== undefined ? { aiReview } : {}),
});

describe('AI-APPROVE-1: the AI review line on the cards (AA-C19)', () => {
  it('solo: no field without aiReview; the field follows Requested by when set', () => {
    expect((toolApprovalPayload(mk(1)).fields ?? []).some((f) => f.name === 'AI review')).toBe(false);
    expect((toolApprovalPayload(mk(1, null)).fields ?? []).some((f) => f.name === 'AI review')).toBe(false);
    const f = toolApprovalPayload(mk(1, 'Not reviewed: sensitive tool')).fields ?? [];
    expect(f.at(-1)).toEqual({ name: 'AI review', value: 'Not reviewed: sensitive tool' });
    expect(f.at(-2)?.name).toBe('Requested by');
  });
  it('solo: the text is escaped (mentions, markdown, hidden characters) and cut to 200', () => {
    const v = toolApprovalPayload(mk(1, '@everyone **x** <@1> ​' + 'a'.repeat(300))).fields!.at(-1)!.value;
    expect(v).not.toContain('@everyone');
    expect(v).not.toMatch(/(^|[^\\])<@/); // every < is escaped
    expect(v).toContain('u{200B}'); // a hidden character is made visible
    expect(v.replace(/\\/g, '').length).toBeLessThanOrEqual(215);
  });
  it('solo: omitted (never cut) when the card would pass 25 fields or the embed limit', () => {
    const big = mk(1, 'Escalated: too long', { query: 'q'.repeat(3900) });
    const withAi = toolApprovalPayload(big).fields ?? [];
    const without = toolApprovalPayload(mk(1, undefined, { query: 'q'.repeat(3900) })).fields ?? [];
    const total = (fs: { name: string; value: string }[]) => fs.reduce((n, x) => n + x.name.length + x.value.length, 0);
    expect(total(withAi) + 64 + big.reason.length).toBeLessThanOrEqual(6000);
    expect(withAi.length === without.length || withAi.at(-1)?.name === 'AI review').toBe(true);
    const huge = toolApprovalPayload(mk(1, 'Escalated: x', { query: 'q'.repeat(60_000) })); // such a call never gets a card (the precheck refuses it); the line must not be added to it
    expect((huge.fields ?? []).some((f) => f.name === 'AI review')).toBe(false);
  });
  it('batch: the item shows the line before Status, cut to 80; no line without aiReview', () => {
    const msgs = buildMessage(batchApprovalPayload([mk(1, 'Escalated: ' + 'z'.repeat(300)), mk(2)], { id: 5, digest: 'abcdef012345' }), { deptColor: 0 });
    const fields = (msgs[0]!.embeds?.[0]?.fields ?? []) as { name: string; value: string }[];
    const one = fields.find((f) => f.name.startsWith('#1'))!.value;
    const line = one.split('\n').find((l) => l.startsWith('**AI review:**'))!;
    expect(line).toBeDefined();
    expect(line.slice('**AI review:** '.length).length).toBeLessThanOrEqual(80);
    expect(one.indexOf('**AI review:**')).toBeLessThan(one.indexOf('**Status:**'));
    expect(fields.find((f) => f.name.startsWith('#2'))!.value).not.toContain('AI review');
    expect(one.length).toBeLessThanOrEqual(1024);
  });
});
