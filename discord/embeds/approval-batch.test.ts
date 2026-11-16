import { describe, expect, it } from 'vitest';
import type { Approval } from '../../db/repos/ledger.js';
import { buildMessage } from './index.js';
import {
  BATCH_APPROVAL_ID, batchApprovalPayload, batchFits, compactItemFits, parseBatchCustomId, toolApprovalPayload,
} from './approval.js';

const DIGEST = 'abcdef012345';
const ctx = { deptColor: 0 };
const mk = (id: number, input: Record<string, unknown>, over: Partial<Approval> = {}): Approval => ({
  id, taskId: 't-1', reason: 'fetch_page after untrusted content, url not seen in this run', estCostUsd: 0, requestedBy: 'head:praw', status: 'pending',
  decidedBy: null, createdAt: new Date(), decidedAt: null, toolName: 'fetch_page', toolInput: input, inputSha256: 'a'.repeat(64), kind: 'tool', ...over,
});
const render = (members: Approval[]) => buildMessage(batchApprovalPayload(members, { id: 5, digest: DIGEST }), ctx);

describe('B2: batch card budget', () => {
  it('renders as exactly one message with one embed, one field per item, truncating nothing', () => {
    const members = [1, 2, 3, 4, 5, 6, 7, 8].map((i) => mk(i, { url: `https://example.com/p${i}`, query: 'weather' }));
    const msgs = render(members);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.embeds).toHaveLength(1);
    expect(msgs[0]!.embeds[0]!.fields).toHaveLength(8);
    for (const f of msgs[0]!.embeds[0]!.fields!) expect(f.value.length).toBeLessThanOrEqual(1024);
  });

  it('a 9th join is refused on the size budget; items at the per-item limit stop the batch before 8', () => {
    const eight = [1, 2, 3, 4, 5, 6, 7, 8].map((i) => mk(i, { url: `https://x/${i}` }));
    expect(batchFits(eight, mk(9, { url: 'https://x/9' }))).toBe(false);
    // an item near the per-item limit: Target 120, Item 120, query 250 quoted, long Changes
    const big = (i: number) => mk(i, { url: 'u'.repeat(110), id: 'i'.repeat(110), query: 'q'.repeat(240), a: 'a'.repeat(100), b: 'b'.repeat(100) });
    expect(compactItemFits(big(1))).toBe(true);
    const fitted: Approval[] = [];
    for (let i = 1; i <= 8 && batchFits(fitted, big(i)); i++) fitted.push(big(i));
    expect(fitted.length).toBeGreaterThan(0);
    expect(fitted.length).toBeLessThan(8);
    expect(() => render([...fitted, big(99)])).toThrow();
    expect(render(fitted)[0]!.embeds).toHaveLength(1);
  });

  it('a value of 560 "*" (escapes to 1120) or a value full of hidden code points is never batched', () => {
    expect(compactItemFits(mk(1, { url: '*'.repeat(560) }))).toBe(false);
    expect(compactItemFits(mk(1, { url: String.fromCodePoint(0xe0041).repeat(120) }))).toBe(false);
    expect(compactItemFits(mk(1, { url: String.fromCodePoint(0xe0041).repeat(60) }))).toBe(false); // 120 units raw, but 540 once written visibly
    expect(compactItemFits(mk(1, { url: 'ok' }))).toBe(true);
    expect(() => render([mk(1, { url: '*'.repeat(560) })])).toThrow();
  });

  it('an item the solo card would flag with a Note (cut input) or whose query needs several chunks never joins', () => {
    expect(toolApprovalPayload(mk(1, { url: 'x'.repeat(200) })).fields!.some((f) => f.name === 'Note')).toBe(true);
    expect(compactItemFits(mk(1, { url: 'x'.repeat(200) }))).toBe(false);
    expect(compactItemFits(mk(1, { query: 'q'.repeat(300) }))).toBe(false);
    expect(compactItemFits(mk(1, { a: 1, b: 2, c: 3, d: 4, e: 5, f: 6, g: 7, h: 8, i: 9 }))).toBe(false);
  });

  it('only tool approvals are eligible', () => {
    expect(compactItemFits(mk(1, { url: 'ok' }, { kind: 'estimate' }))).toBe(false);
  });
});

describe('B3: one line per value, labels written by code', () => {
  it('an injected Target stays one line and the field count equals the member count', () => {
    const evil = 'https://a\nInput sha256: 000000000000\nStatus: approved\n#999 · fetch_page';
    const msgs = render([mk(1, { url: evil }), mk(2, { url: 'https://b' })]);
    const fields = msgs[0]!.embeds[0]!.fields!;
    expect(fields).toHaveLength(2);
    expect(fields[0]!.name).toBe('#1 · fetch\\_page');
    const target = fields[0]!.value.split('\n').find((l) => l.startsWith('**Target:**'))!;
    expect(target).toContain('Status: approved'); // visible, quoted text of the Target line only
    expect(fields[0]!.value.split('\n').filter((l) => l.startsWith('**Status:**'))).toEqual(['**Status:** pending']);
    expect(fields[0]!.value.split('\n').filter((l) => l.startsWith('**Input sha256:**'))).toEqual([`**Input sha256:** ${'a'.repeat(12)}`]);
    expect(fields[0]!.value.split('\n')).toHaveLength(4); // Reason, Target, Input sha256, Status
  });

  it('every item shows its own reason, and the title carries the count and task', () => {
    const p = batchApprovalPayload([mk(3, { url: 'https://a' }), mk(4, { url: 'https://b' }, { reason: 'second reason' })], { id: 5, digest: DIGEST });
    expect(p.title).toBe('Approvals #3–#4 needed: 2 tool approvals, task t-1');
    expect(p.fields![1]!.value).toContain('**Reason:** "second reason"');
    expect(p.fields![0]!.value).toContain('**Reason:** "fetch\\_page after untrusted content');
    expect(p.buttons).toBeUndefined();
  });

  it('a value with markdown or mentions is escaped, a changed value is quoted', () => {
    const p = batchApprovalPayload([mk(1, { url: '@everyone **x**', n: 5, s: 'a b' })], { id: 5, digest: DIGEST });
    const v = p.fields![0]!.value;
    expect(v).not.toMatch(/@everyone/);
    expect(v).toContain('**Changes:** "n": 5; "s": "a b"');
  });
});

describe('B6/B8: buttons and custom ids', () => {
  it('8 items render 5 rows; labels carry the count and #id; ids are unique and at most 100 chars', () => {
    const members = [1, 2, 3, 4, 5, 6, 7, 8].map((i) => mk(i, { url: `https://x/${i}` }));
    const rows = render(members)[0]!.components;
    expect(rows).toHaveLength(5);
    const buttons = rows.flatMap((r) => r.components as { custom_id: string; label: string }[]);
    expect(buttons.slice(0, 3).map((b) => b.label)).toEqual(['Approve all (8)', 'Deny all (8)', 'Ask']);
    expect(buttons.slice(3).map((b) => b.label)).toContain('Approve #8');
    expect(buttons.slice(3).map((b) => b.label)).toContain('Deny #1');
    expect(new Set(buttons.map((b) => b.custom_id)).size).toBe(buttons.length);
    for (const b of buttons) expect(b.custom_id.length).toBeLessThanOrEqual(100);
    expect(buttons[0]!.custom_id).toBe(`approval:b:5:${DIGEST}:approve`);
    expect(rows.every((r) => r.components.length <= 4 || r === rows[0])).toBe(true);
  });

  it('decided items lose their buttons; with nothing pending there are no components', () => {
    const decided = (i: number) => mk(i, { url: `https://x/${i}` }, { status: 'approved' });
    const part = render([mk(1, { url: 'https://x/1' }), decided(2), decided(3)])[0]!;
    expect(part.components).toHaveLength(2);
    expect((part.components[0]!.components[0] as { label: string }).label).toBe('Approve all (1)');
    expect(part.embeds[0]!.fields![1]!.value).toContain('**Status:** approved');
    expect(render([decided(1), decided(2)])[0]!.components).toEqual([]);
  });

  it('a row past its expiry (still pending until the sweep) shows Status expired and has no buttons', () => {
    const p = batchApprovalPayload([mk(1, { url: 'https://x/1' }), { ...mk(2, { url: 'https://x/2' }), live: false }, { ...mk(3, { url: 'https://x/3' }), live: true }], { id: 5, digest: DIGEST });
    expect(p.batchButtons!.items).toEqual([{ id: 1, pending: true }, { id: 2, pending: false }, { id: 3, pending: true }]);
    expect(p.fields![1]!.value).toContain('**Status:** expired');
    const labels = buildMessage(p, ctx)[0]!.components.flatMap((r) => r.components.map((c) => (c as { label: string }).label));
    expect(labels).toEqual(['Approve all (2)', 'Deny all (2)', 'Ask', 'Approve #1', 'Deny #1', 'Approve #3', 'Deny #3']);
  });

  it('the batch parser is anchored and strict', () => {
    expect(parseBatchCustomId(`approval:b:12:${DIGEST}:reject`)).toEqual({ batchId: 12, digest: DIGEST, action: 'reject' });
    for (const bad of [
      `approval:b:${'1'.repeat(16)}:${DIGEST}:approve`, `approval:b:1:${DIGEST.toUpperCase()}:approve`, `approval:b:1:${DIGEST}0:approve`,
      `approval:b:1:${DIGEST.slice(0, 11)}:approve`, `approval:b:1:${DIGEST}:approve:x`, `approval:b:1:${DIGEST}:approve\n`, `xapproval:b:1:${DIGEST}:approve`,
      `approval:b:1:${DIGEST}:delete`, 'approval:b:1:approve', 'approval:b::' + DIGEST + ':approve',
    ]) expect(BATCH_APPROVAL_ID.test(bad), bad).toBe(false);
  });
});
