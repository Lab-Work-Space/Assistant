import { describe, expect, it } from 'vitest';
import type { Approval } from '../../db/repos/ledger.js';
import { buildMessage } from './index.js';
import {
  approvalRow, batchApprovalPayload, batchCustomId, batchGrantEligible, batchRows, GRANT_LABEL, grantClosingText, parseBatchCustomId, revokeRow, soloGrantEligible,
  soloShowsWhole, toolApprovalPayload,
} from './approval.js';

const ap = (id: number, toolName: string, input: unknown): Approval => ({
  id, taskId: 't-1', reason: 'fetch_page after untrusted content, url not seen in this run', estCostUsd: 0, requestedBy: 'head:praw', status: 'pending',
  decidedBy: null, createdAt: new Date(), decidedAt: null, toolName, toolInput: input, inputSha256: 'a'.repeat(64), kind: 'tool',
}) as Approval;
const fetchAp = (id: number, url: string) => ap(id, 'fetch_page', { url });
const ids = (row: { components: { custom_id?: string }[] }) => row.components.map((c) => c.custom_id);
const labels = (row: { components: { label?: string }[] }) => row.components.map((c) => c.label);

describe('WEBGRANT-1 card rendering', () => {
  it('a qualifying solo fetch_page card gets the fourth button, labelled with the task-tree scope (D5, W-C9)', () => {
    const a = fetchAp(7, 'https://example.com/guide');
    expect(soloGrantEligible(a)).toBe(true);
    const p = toolApprovalPayload(a, [], { grantEnabled: true });
    expect(p.buttons).toEqual({ approvalId: '7', grant: true });
    const msg = buildMessage(p, { deptColor: 0 });
    const row = msg.at(-1)!.components[0] as unknown as { components: { custom_id?: string; label?: string }[] };
    expect(ids(row)).toEqual(['approval:7:approve', 'approval:7:reject', 'approval:7:ask', 'approval:7:grant']);
    expect(labels(row)[3]).toBe('Allow web reading for this task tree');
    expect(GRANT_LABEL).toBe('Allow web reading for this task tree');
  });

  it('no button when the feature is off, for another tool, for a url that fails the heuristics, or without a url', () => {
    expect(toolApprovalPayload(fetchAp(7, 'https://example.com/a'), [], { grantEnabled: false }).buttons).toEqual({ approvalId: '7' });
    expect(toolApprovalPayload(fetchAp(7, 'https://example.com/a')).buttons).toEqual({ approvalId: '7' });
    expect(toolApprovalPayload(ap(7, 'web_search', { query: 'x' }), [], { grantEnabled: true }).buttons).toEqual({ approvalId: '7' });
    expect(toolApprovalPayload(ap(7, 'watch_add', { url: 'https://example.com/a' }), [], { grantEnabled: true }).buttons).toEqual({ approvalId: '7' });
    expect(toolApprovalPayload(fetchAp(7, 'http://example.com/a'), [], { grantEnabled: true }).buttons).toEqual({ approvalId: '7' });
    expect(toolApprovalPayload(fetchAp(7, 'https://example.com/u/1234567890'), [], { grantEnabled: true }).buttons).toEqual({ approvalId: '7' });
    expect(toolApprovalPayload(ap(7, 'fetch_page', { nope: 1 }), [], { grantEnabled: true }).buttons).toEqual({ approvalId: '7' });
  });

  it('121-char eligible url: the card shows it cut, so no grant button (W-C4)', () => {
    const words = (n: number) => Array.from({ length: n }, () => 'abc').join('-');
    const long = `https://example.com/${words(40)}`.slice(0, 121).replace(/-$/, 'x');
    expect(long.length).toBeGreaterThanOrEqual(120);
    const a = fetchAp(8, long.length > 120 ? long : `${long}abcd`);
    expect(a.toolInput && (a.toolInput as { url: string }).url.length).toBeGreaterThan(120);
    expect(soloShowsWhole(a)).toBe(false);
    expect(soloGrantEligible(a)).toBe(false);
    expect(toolApprovalPayload(a, [], { grantEnabled: true }).buttons).toEqual({ approvalId: '8' });
    // 120 chars exactly is shown whole
    const ok = fetchAp(9, `https://example.com/${'abc-'.repeat(25)}`.slice(0, 119) + 'x');
    expect((ok.toolInput as { url: string }).url.length).toBe(120);
    expect(soloShowsWhole(ok)).toBe(true);
  });

  it('the row still fits Discord: five components at most, labels at most 80 characters', () => {
    const row = approvalRow('123456789012345', true) as unknown as { components: { label?: string; custom_id?: string }[] };
    expect(row.components.length).toBeLessThanOrEqual(5);
    for (const c of row.components) { expect((c.label ?? '').length).toBeLessThanOrEqual(80); expect((c.custom_id ?? '').length).toBeLessThanOrEqual(100); }
  });

  it('batch: the grant button only when every member qualifies; custom id parses and stays short', () => {
    const good = [fetchAp(1, 'https://example.com/a'), fetchAp(2, 'https://example.org/b')];
    const mixed = [fetchAp(1, 'https://example.com/a'), ap(2, 'web_search', { query: 'x' })];
    const bad = [fetchAp(1, 'https://example.com/a'), fetchAp(2, 'https://example.com/u/1234567890')];
    expect(batchGrantEligible(good)).toBe(true);
    expect(batchGrantEligible(mixed)).toBe(false);
    expect(batchGrantEligible(bad)).toBe(false);
    expect(batchApprovalPayload(good, { id: 5, digest: 'abcdef012345' }, [], { grant: true }).batchButtons?.grant).toBe(true);
    expect(batchApprovalPayload(good, { id: 5, digest: 'abcdef012345' }, []).batchButtons?.grant).toBeUndefined();
    expect(batchApprovalPayload(mixed, { id: 5, digest: 'abcdef012345' }, [], { grant: true }).batchButtons?.grant).toBeUndefined();
    expect(batchApprovalPayload(bad, { id: 5, digest: 'abcdef012345' }, [], { grant: true }).batchButtons?.grant).toBeUndefined();
    const id = batchCustomId(999999999999999, 'abcdef012345', 'grant');
    expect(id.length).toBeLessThanOrEqual(45);
    expect(parseBatchCustomId(id)).toEqual({ batchId: 999999999999999, digest: 'abcdef012345', action: 'grant' });
    const rows = batchRows({ batchId: 5, digest: 'abcdef012345', grant: true, items: [{ id: 1, pending: true }] }) as unknown as { components: { custom_id?: string; label?: string }[] }[];
    expect(ids(rows[0]!)).toContain('approval:b:5:abcdef012345:grant');
    expect(labels(rows[0]!)).toContain('Approve all + allow web reading');
  });

  it('batch with a made grant: the revoke button replaces the grant button, also when nothing is pending', () => {
    const rows = batchRows({ batchId: 5, digest: 'abcdef012345', grant: true, revokeGrantId: 9, items: [{ id: 1, pending: true }] }) as unknown as { components: { custom_id?: string }[] }[];
    expect(ids(rows[0]!)).toContain('approval:g:9:revoke');
    expect(ids(rows[0]!).some((i) => i?.endsWith(':grant'))).toBe(false);
    const done = batchRows({ batchId: 5, digest: 'abcdef012345', revokeGrantId: 9, items: [{ id: 1, pending: false }] }) as unknown as { components: { custom_id?: string; label?: string }[] }[];
    expect(done).toHaveLength(1);
    expect(ids(done[0]!)).toEqual(['approval:g:9:revoke']);
    expect(batchRows({ batchId: 5, digest: 'abcdef012345', items: [{ id: 1, pending: false }] })).toEqual([]);
    expect(ids(revokeRow(3) as never)).toEqual(['approval:g:3:revoke']);
  });

  it('a batch card with a made grant renders the closing text as the message content, within one embed', () => {
    const members = [fetchAp(1, 'https://example.com/a'), fetchAp(2, 'https://example.org/b')].map((m) => ({ ...m, status: 'approved' as const }));
    const note = grantClosingText({ rootId: 'task-abc', expiresAt: new Date('2026-11-08T16:00:00Z'), maxFetches: 20, maxHosts: 5, maxUrlChars: 4000 }, 'Web reading was allowed from this card.');
    const msgs = buildMessage(batchApprovalPayload(members, { id: 5, digest: 'abcdef012345' }, [], { grant: true, revokeGrantId: 9, grantNote: note }), { deptColor: 0 });
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.embeds).toHaveLength(1);
    expect(msgs[0]!.content).toBe(note);
    const row = msgs[0]!.components[0] as unknown as { components: { custom_id?: string }[] };
    expect(row.components.map((c) => c.custom_id)).toEqual(['approval:g:9:revoke']);
  });

  it('closing text snapshot: names the root, the departments, the caps, the leak bound and the revoke button (W-C9, W-C10)', () => {
    const text = grantClosingText({ rootId: 'task-abc', expiresAt: new Date('2026-11-08T16:00:00Z'), maxFetches: 20, maxHosts: 5, maxUrlChars: 4000 }, 'Approval #7 approved by <@1>.');
    expect(text).toMatchInlineSnapshot(`
      "Approval #7 approved by <@1>.
      Web reading allowed for task tree task-abc until <t:1794153600:f>: every department working on this task tree may read up to 20 pages on up to 5 sites without asking again.
      If a page tricks the bot, it can send up to about 4000 characters of what it has read in this task tree to sites it picks, without asking you.
      Writing, sending and deploying still ask every time. Use Revoke web reading to stop it."
    `);
    expect(text).not.toMatch(/low-bandwidth/i);
  });
});
