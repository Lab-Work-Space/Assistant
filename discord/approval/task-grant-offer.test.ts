import { describe, expect, it } from 'vitest';
import type { Approval } from '../../db/repos/ledger.js';
import type { Task } from '../../db/repos/tasks.js';
import { canonicalJson, inputDigest } from '../../governance/canonical.js';
import { FakeConfig } from '../../governance/test-helpers.js';
import { DOC_KINDS, isDraftKind } from '../../tools/plugins/docs/kinds.js';
import type { ToolKind } from '../../tools/policy-approval.js';
import { makeTaskGrantOffer } from './task-grant-offer.js';

const KINDS: Record<string, ToolKind> = { write_file: 'write', forum_post: 'write', doc_create: 'write', save_lesson: 'write', fetch_page: 'read' };
const row = (toolName: string, toolInput: unknown, over: Record<string, unknown> = {}): Approval => ({
  id: 1, taskId: 't-child', reason: 'r', estCostUsd: 0, requestedBy: 'head:praw', status: 'pending', decidedBy: null, createdAt: new Date(), decidedAt: null,
  toolName, toolInput, inputSha256: inputDigest(canonicalJson(toolInput)), kind: 'tool', ...over,
}) as Approval;

/** Fakes as classes using `this`. */
class FakeTasks {
  rows = new Map<string, Partial<Task>>([['t-root', { id: 't-root', rootId: 't-root', status: 'doing' }], ['t-child', { id: 't-child', rootId: 't-root', status: 'doing' }]]);
  async get(id: string) { return (this.rows.get(id) as Task | undefined) ?? null; }
}
class FakeGrants { liveRow: object | null = null; asked: string[] = []; async live(root: string) { this.asked.push(root); return this.liveRow; } }
class Halt { halted = false; isHalted() { return this.halted; } }

const mk = (cfgInit: ConstructorParameters<typeof FakeConfig>[0] = {}, o: { conversation?: boolean } = {}) => {
  const cfg = new FakeConfig(cfgInit);
  const tasks = new FakeTasks();
  const grants = new FakeGrants();
  const halt = new Halt();
  const offer = makeTaskGrantOffer({ cfg, halt, tasks: tasks as never, grants, kindOf: (n) => KINDS[n], isConversation: () => o.conversation === true });
  return { cfg, tasks, grants, halt, offer };
};
const GOOD = () => row('forum_post', { title: 't', body: 'b' });

describe('TG-C3 / TG-C11: the offer is built from the same rows decideTaskGrant accepts', () => {
  it('an eligible row of an open tree with no live grant gets the offer with the config numbers; the web block follows web.taskGrant.enabled', async () => {
    const a = mk({ 'taskGrant.maxCalls': 25, 'taskGrant.hours': 6, 'web.taskGrant.maxFetches': 12, 'web.taskGrant.maxHosts': 30, 'web.taskGrant.maxUrlChars': 900, 'web.taskGrant.hours': 2 });
    expect(await a.offer(GOOD())).toEqual({ maxCalls: 25, hours: 6, web: { hours: 2, maxFetches: 12, maxHosts: 12, maxUrlChars: 900 } }); // maxHosts clamped like the grant
    expect(a.grants.asked).toEqual(['t-root']);
    const off = mk({ 'web.taskGrant.enabled': false });
    expect((await off.offer(GOOD()))!.web).toBeNull();
  });

  it('no offer for a tampered sha, a tampered input, an uncovered tool, a DRAFT doc, an overwrite or a fetch_page row', async () => {
    const { offer } = mk();
    const draft = DOC_KINDS.find((k) => isDraftKind(k))!;
    const tamperedInput = { ...GOOD(), toolInput: { title: 'changed', body: 'b' } } as Approval;
    for (const a of [
      row('forum_post', { title: 't' }, { inputSha256: 'f'.repeat(64) }), tamperedInput, row('save_lesson', { text: 'x' }),
      row('doc_create', { kind: draft, fields: {} }), row('write_file', { path: 'a', content: 'x', overwrite: true }), row('fetch_page', { url: 'https://example.com/a' }),
      row('forum_post', { title: 't' }, { kind: 'estimate' }), row('forum_post', { title: 't' }, { inputSha256: null }),
    ]) expect(await offer(a), `${a.toolName}`).toBeNull();
    expect(await offer(row('doc_create', { kind: DOC_KINDS.find((k) => !isDraftKind(k))!, fields: {} }))).not.toBeNull();
    expect(await offer(row('write_file', { path: 'a', content: 'x', overwrite: false }))).not.toBeNull();
  });

  it('no offer while halted, with the switch off, for an ended root, or when the tree already has a live grant', async () => {
    const h = mk(); h.halt.halted = true;
    expect(await h.offer(GOOD())).toBeNull();
    expect(await mk({ 'taskGrant.enabled': false }).offer(GOOD())).toBeNull();
    for (const status of ['done', 'cancelled'] as const) {
      const e = mk(); e.tasks.rows.set('t-root', { id: 't-root', rootId: 't-root', status });
      expect(await e.offer(GOOD()), status).toBeNull();
    }
    const live = mk(); live.grants.liveRow = { id: 3 };
    expect(await live.offer(GOOD())).toBeNull();
  });

  it('a missing task or root is no offer; a task of the root itself works', async () => {
    const m = mk();
    expect(await m.offer(row('forum_post', { title: 't' }, { taskId: 'gone' }))).toBeNull();
    m.tasks.rows.set('t-orphan', { id: 't-orphan', rootId: 't-missing', status: 'doing' });
    expect(await m.offer(row('forum_post', { title: 't' }, { taskId: 't-orphan' }))).toBeNull();
    expect(await m.offer(row('forum_post', { title: 't' }, { taskId: 't-root' }))).not.toBeNull();
  });

  it('a conversation root gets min(hours, conversationHours); a plain root gets hours', async () => {
    expect((await mk({ 'taskGrant.hours': 12, 'taskGrant.conversationHours': 4 }, { conversation: true }).offer(GOOD()))!.hours).toBe(4);
    expect((await mk({ 'taskGrant.hours': 12, 'taskGrant.conversationHours': 4 }).offer(GOOD()))!.hours).toBe(12);
    expect((await mk({ 'taskGrant.hours': 2, 'taskGrant.conversationHours': 4 }, { conversation: true }).offer(GOOD()))!.hours).toBe(2);
  });
});
