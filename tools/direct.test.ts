import { describe, expect, it } from 'vitest';
import type { Task } from '../db/repos/tasks.js';
import { isDirectHumanRun, type DirectInput } from './direct.js';
import type { ToolOrigin } from './types.js';

const PRAW = { kind: 'head', dept: 'praw' } as const;
const task = (over: Partial<Task> = {}): Task => ({
  id: 't', title: 't', description: '', deptId: 'praw', owner: PRAW, requester: { kind: 'human', userId: '42' }, parentId: null, rootId: 't',
  depth: 0, status: 'doing', threadId: null, turnsUsed: 0, costUsd: 0, estCostUsd: null, blockedReason: null,
  origin: 'chat', channelId: null, sourceUserId: null, tainted: false, ...over,
});
const base = (over: Partial<DirectInput> = {}): DirectInput => ({
  origin: 'chat', actor: PRAW, task: task(), trigger: { kind: 'human_message', userId: '42', origin: 'chat' }, ...over,
});

describe('isDirectHumanRun', () => {
  it('true only for chat|slash, actor praw, depth 0, human requester, human-message trigger', () => {
    expect(isDirectHumanRun(base())).toBe(true);
    expect(isDirectHumanRun(base({ origin: 'slash', task: task({ origin: 'slash' }) }))).toBe(true);
    expect(isDirectHumanRun(base({ task: null }))).toBe(true);
    expect(isDirectHumanRun(base({ origin: 'slash', task: null }))).toBe(true);
  });

  it.each(['voice', 'delegated', 'schedule', 'watch', 'reminder', 'poll', 'import'] as ToolOrigin[])('false for origin %s', (origin) => {
    expect(isDirectHumanRun(base({ origin, task: task({ origin }) }))).toBe(false);
    expect(isDirectHumanRun(base({ origin, task: null }))).toBe(false);
  });

  it('false for depth 1, a child-report trigger, an approved-result resume, a non-human requester, a non-praw actor', () => {
    expect(isDirectHumanRun(base({ task: task({ depth: 1 }) }))).toBe(false);
    expect(isDirectHumanRun(base({ trigger: { kind: 'child_report' } }))).toBe(false);
    expect(isDirectHumanRun(base({ trigger: { kind: 'approved_result' } }))).toBe(false);
    expect(isDirectHumanRun(base({ trigger: { kind: 'owner_run' } }))).toBe(false);
    expect(isDirectHumanRun(base({ task: null, trigger: { kind: 'child_report' } }))).toBe(false);
    expect(isDirectHumanRun(base({ task: task({ requester: PRAW }) }))).toBe(false);
    expect(isDirectHumanRun(base({ actor: { kind: 'head', dept: 'software' } }))).toBe(false);
    expect(isDirectHumanRun(base({ actor: { kind: 'persona', personaId: 'system-analyst' } }))).toBe(false);
  });

  it("false when the trigger is another human's message than the task requester", () => {
    expect(isDirectHumanRun(base({ trigger: { kind: 'human_message', userId: '43', origin: 'chat' } }))).toBe(false);
  });

  it('false when praw is not the task owner (praw in the thread of a CTO-owned task)', () => {
    expect(isDirectHumanRun(base({ task: task({ owner: { kind: 'head', dept: 'software' } }) }))).toBe(false);
  });

  it('false for a voice message even on a chat task; the task row beats the given origin', () => {
    expect(isDirectHumanRun(base({ trigger: { kind: 'human_message', userId: '42', origin: 'voice' } }))).toBe(false);
    expect(isDirectHumanRun(base({ task: null, trigger: { kind: 'human_message', userId: '42', origin: 'voice' } }))).toBe(false);
    expect(isDirectHumanRun(base({ origin: 'chat', task: task({ origin: 'schedule' }) }))).toBe(false);
  });
});
