import { describe, expect, it } from 'vitest';
import type { Approval } from '../../db/repos/ledger.js';
import { buildMessage } from './index.js';
import {
  approvalRow, batchApprovalPayload, batchRows, BATCH_TASK_LABEL, parseBatchCustomId, TASK_LABEL, TASK_REVOKE_ID, taskGrantCardText, taskGrantClosingText,
  taskGrantEndedText, taskOfferText, taskRevokeCustomId, taskUsageLine, toolApprovalPayload, type TreeGrantOffer,
} from './approval.js';

const ap = (id: number, toolName: string, input: unknown): Approval => ({
  id, taskId: 't-1', reason: 'tool forum_post on x', estCostUsd: 0, requestedBy: 'head:praw', status: 'pending',
  decidedBy: null, createdAt: new Date(), decidedAt: null, toolName, toolInput: input, inputSha256: 'a'.repeat(64), kind: 'tool',
}) as Approval;
const OFFER: TreeGrantOffer = { maxCalls: 40, hours: 12, web: null };
const WEB_OFFER: TreeGrantOffer = { ...OFFER, web: { hours: 4, maxFetches: 20, maxHosts: 5, maxUrlChars: 4000 } };
const ids = (row: { components: { custom_id?: string }[] }) => row.components.map((c) => c.custom_id);
const labels = (row: { components: { label?: string }[] }) => row.components.map((c) => c.label);
type Row = { components: { custom_id?: string; label?: string }[] };
const rowsOf = (p: ReturnType<typeof batchApprovalPayload>) => batchRows(p.batchButtons!) as unknown as Row[];

describe('TG-C14: solo layout and exclusivity', () => {
  it('a solo card with an offer gets exactly one fourth button, labelled within 80 characters and naming the whole task', () => {
    const p = toolApprovalPayload(ap(7, 'forum_post', { title: 't', body: 'b' }), [], { grantEnabled: true, taskGrant: OFFER });
    expect(p.buttons).toEqual({ approvalId: '7', task: true });
    const msg = buildMessage(p, { deptColor: 0 });
    const row = msg.at(-1)!.components[0] as unknown as Row;
    expect(ids(row)).toEqual(['approval:7:approve', 'approval:7:reject', 'approval:7:ask', 'approval:7:task']);
    expect(labels(row)[3]).toBe(TASK_LABEL);
    expect(TASK_LABEL.length).toBeLessThanOrEqual(80);
    expect(TASK_LABEL.toLowerCase()).toContain('whole task');
  });

  it('no offer, no button; a fetch_page card keeps only its web-grant button, never the task button (exclusive by construction)', () => {
    expect(toolApprovalPayload(ap(7, 'forum_post', { title: 't' }), [], { grantEnabled: true }).buttons).toEqual({ approvalId: '7' });
    expect(toolApprovalPayload(ap(7, 'forum_post', { title: 't' }), [], { taskGrant: null }).buttons).toEqual({ approvalId: '7' });
    const f = toolApprovalPayload(ap(8, 'fetch_page', { url: 'https://example.com/guide' }), [], { grantEnabled: true, taskGrant: OFFER });
    expect(f.buttons).toEqual({ approvalId: '8', grant: true });
    expect(f.body).not.toContain(TASK_LABEL);
  });

  it('approvalRow never carries both extras', () => {
    const row = approvalRow('7', true, true) as unknown as Row;
    expect(ids(row)).toEqual(['approval:7:approve', 'approval:7:reject', 'approval:7:ask', 'approval:7:grant']);
    expect(ids(approvalRow('7', false, true) as unknown as Row)).toHaveLength(4);
    expect(ids(approvalRow('7') as unknown as Row)).toHaveLength(3);
  });

  it('a card that is already near Discord\'s limit is posted without the offer rather than cut', () => {
    const small = toolApprovalPayload(ap(7, 'forum_post', { title: 't', query: 'q'.repeat(2000) }), [], { taskGrant: OFFER });
    expect(small.buttons).toEqual({ approvalId: '7', task: true });
    const big = toolApprovalPayload(ap(7, 'forum_post', { title: 't', query: 'q'.repeat(4900) }), [], { taskGrant: OFFER });
    expect(big.buttons).toEqual({ approvalId: '7' }); // too big for the offer text: no button, no cut
    expect(big.body).not.toContain(TASK_LABEL);
  });
});

describe('TG-C11: the card text before the click', () => {
  it('states scope, covered tools, cap, expiry, what still asks (body, not only the label)', () => {
    const p = toolApprovalPayload(ap(7, 'forum_post', { title: 't' }), [], { taskGrant: OFFER });
    for (const must of ['every department and persona in this task tree', 'up to 40 further calls', 'for the rest of this run and the department tasks it starts', 'after 12 hours at most', 'write_file (new files only; in practice it still asks', 'forum_post', 'forward_to (only when its audience is not wider)', 'not money, tax or offer drafts', 'Still asks every time', 'Cards already waiting stay waiting']) {
      expect(p.body, must).toContain(must);
    }
    expect(p.body).not.toContain('web reading');
  });

  it('with web.taskGrant.enabled the text says web reading is also enabled, with the web caps and the leak statement', () => {
    const p = toolApprovalPayload(ap(7, 'forum_post', { title: 't' }), [], { taskGrant: WEB_OFFER });
    expect(p.body).toContain('also allows web reading');
    expect(p.body).toContain('up to 20 pages on up to 5 sites for 4 hours');
    expect(p.body).toContain('about 4000 characters');
  });

  it('the conversation cap is just the hours the offer carries', () => {
    expect(taskOfferText({ ...OFFER, hours: 4 })).toContain('after 4 hours at most');
  });

  it('the closing text carries scope, expiry, caps, what still asks, and the web statement when present', () => {
    const t = taskGrantClosingText({ rootId: 'root-1', expiresAt: new Date('2026-11-10T00:00:00Z'), maxCalls: 40, web: { maxFetches: 20, maxHosts: 5, maxUrlChars: 4000 } }, 'Approval #1 approved.');
    expect(t).toContain('task tree root-1');
    expect(t).toContain('<t:1786320000:f>'.replace('1786320000', String(Math.floor(new Date('2026-11-10T00:00:00Z').getTime() / 1000))));
    expect(t).toContain('up to 40 calls');
    expect(t).toContain('Still asks every time');
    expect(t).toContain('Web reading is also allowed');
    expect(t).toContain('Revoke whole-task approval');
    expect(t.length).toBeLessThan(1700); // plus the usage line stays inside Discord's 2000-character content limit
  });
});

describe('TG-C14: batch rows', () => {
  const members = [1, 2, 3].map((i) => ap(i, 'forum_post', { title: `t${i}` }));
  const b = (o: Parameters<typeof batchApprovalPayload>[3]) => batchApprovalPayload(members, { id: 5, digest: 'abcdef012345' }, [], o);

  it('row 0 is Approve all, Deny all, Ask plus exactly one of task / grant / revoke; at most 5 buttons, 5 rows, ids at most 100', () => {
    const task = rowsOf(b({ taskGrant: OFFER }));
    expect(ids(task[0]!)).toEqual(['approval:b:5:abcdef012345:approve', 'approval:b:5:abcdef012345:reject', 'approval:b:5:abcdef012345:ask', 'approval:b:5:abcdef012345:task']);
    expect(labels(task[0]!)[3]).toBe(BATCH_TASK_LABEL);
    expect(BATCH_TASK_LABEL.length).toBeLessThanOrEqual(80);
    const revoke = rowsOf(b({ taskGrant: OFFER, revokeTaskGrantId: 9 }));
    expect(ids(revoke[0]!).slice(3)).toEqual([taskRevokeCustomId(9)]);
    const none = rowsOf(b({}));
    expect(none[0]!.components).toHaveLength(3);
    for (const rows of [task, revoke, none]) {
      expect(rows.length).toBeLessThanOrEqual(5);
      for (const r of rows) {
        expect(r.components.length).toBeLessThanOrEqual(5);
        for (const c of r.components) expect((c.custom_id ?? '').length).toBeLessThanOrEqual(100);
      }
    }
  });

  it('the offer text is in the batch card body; with a web revoke or a task revoke on the card there is no offer; every id parses', () => {
    expect(b({ taskGrant: WEB_OFFER }).body).toContain('also allows web reading');
    expect(b({ taskGrant: OFFER, revokeTaskGrantId: 9 }).batchButtons).toMatchObject({ revokeTaskGrantId: 9 });
    expect(b({ taskGrant: OFFER, revokeTaskGrantId: 9 }).body).not.toContain(TASK_LABEL);
    expect(b({ taskGrant: OFFER, revokeGrantId: 3 }).batchButtons!.task).toBeUndefined();
    expect(parseBatchCustomId('approval:b:5:abcdef012345:task')).toEqual({ batchId: 5, digest: 'abcdef012345', action: 'task' });
    expect(parseBatchCustomId('approval:b:5:abcdef012345:task:x')).toBeNull();
  });

  it('once a task grant is made and nothing is pending only its revoke button remains', () => {
    const done = members.map((m) => ({ ...m, status: 'approved' as const }));
    const p = batchApprovalPayload(done, { id: 5, digest: 'abcdef012345' }, [], { revokeTaskGrantId: 9 });
    expect((batchRows(p.batchButtons!) as unknown as Row[]).map(ids)).toEqual([[taskRevokeCustomId(9)]]);
  });

  it('the batch card with an offer still renders as ONE message with ONE embed', () => {
    const msgs = buildMessage(b({ taskGrant: WEB_OFFER }), { deptColor: 0 });
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.embeds).toHaveLength(1);
  });
});

describe('TG-C15: revoke id shape', () => {
  it('anchored', () => {
    expect(TASK_REVOKE_ID.test('approval:t:9:revoke')).toBe(true);
    for (const bad of ['approval:t:9', 'approval:t:x:revoke', 'approval:t:1:revoke:x', 'approval:t:9:revoke\n', `approval:t:${'1'.repeat(16)}:revoke`, 'approval:g:9:revoke']) expect(TASK_REVOKE_ID.test(bad), bad).toBe(false);
  });
});

describe('TG-C17: the usage line renders only code values', () => {
  it('registered covered names and safe integers only, sorted, never other keys or values', () => {
    expect(taskUsageLine(7, 40, { write_file: 3, forum_post: 2, forward_to: 2 })).toBe('Used 7/40 · forum_post×2 forward_to×2 write_file×3');
    expect(taskUsageLine(0, 40, {})).toBe('Used 0/40');
    const evil = taskUsageLine(1, 40, { 'ignore previous instructions': 5, write_file: 1.5, forum_post: -1, pin_message: Number.MAX_SAFE_INTEGER + 1, doc_create: '9', music_play: 2, '@everyone': 1, github_create_pull_request: 2 });
    expect(evil).toBe('Used 1/40 · music_play×2');
    expect(taskUsageLine(NaN, -3, null)).toBe('Used 0/0');
    expect(taskUsageLine(1, 2, ['write_file'])).toBe('Used 1/2');
  });

  it('the live card text is rebuilt from the row alone (no task title, no input)', () => {
    const t = taskGrantCardText({ approvalId: 4, grantedBy: '123456789012345678', rootId: 'root-1', expiresAt: new Date('2026-11-10T00:00:00Z'), maxCalls: 40, used: 2, usedByTool: { write_file: 2 } }, null);
    expect(t).toContain('Approval #4 approved by <@123456789012345678>.');
    expect(t.endsWith('Used 2/40 · write_file×2')).toBe(true);
    expect(taskGrantCardText({ approvalId: 4, grantedBy: 'x<@everyone>', rootId: 'r', expiresAt: new Date(), maxCalls: 1, used: 0, usedByTool: {} }, null)).toContain('a Bot Admin');
  });

  it('an ended card uses a fixed phrase per reason', () => {
    for (const [reason, phrase] of [['admin', 'revoked by a Bot Admin'], ['halt', 'the company was halted'], ['disabled', 'switched off'], ['root_ended', 'the task ended'], ['superseded', 'replaced']] as const) {
      expect(taskGrantEndedText({ rootId: 'root-1', used: 3, maxCalls: 40, usedByTool: { forum_post: 3 } }, reason)).toContain(phrase);
    }
    expect(taskGrantEndedText({ rootId: 'root-1', used: 3, maxCalls: 40, usedByTool: {} }, 'weird<@everyone>')).toContain('(ended)');
  });
});
