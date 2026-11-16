import { describe, expect, it, vi } from 'vitest';
import { toPayload } from '../../agents/loop/payload.js';
import { isCardPayload, buildMessage } from '../../discord/embeds/index.js';
import { TOOL_REQUEST_ID, toolRequestRow } from '../../discord/embeds/approval.js';
import { planBotTools, isError } from '../../discord/commands/plans.js';
import { skillToolAllowed } from '../skill-grant.js';
import { builtinTools } from './index.js';
import { GROW_TOOL_NAMES, growTools } from './grow.js';

const TOKEN = 'a'.repeat(32);

describe('growTools (GW-C25)', () => {
  const request = vi.fn(async () => ({ ok: true as const, id: 7, text: 'Tool request #7 ok' }));
  const idea = vi.fn(async () => ({ ok: false as const, code: 'open_cap' as const, error: 'Your department already has 5 open tool ideas.' }));
  const plugins = growTools({ requests: { request } as never, ideas: { idea } as never }) as unknown as { name: string; kind?: string; requiresApproval(): boolean; inputSchema: { safeParse(x: unknown): { success: boolean } }; run(i: unknown, c: unknown): Promise<{ content: string; isError?: boolean }> }[];

  it('registers exactly tool_request and tool_idea, kindless, never asking for approval, and not through builtinTools()', () => {
    expect(plugins.map((p) => p.name)).toEqual([...GROW_TOOL_NAMES]);
    for (const p of plugins) {
      expect(p.kind).toBeUndefined();
      expect(p.requiresApproval()).toBe(false);
    }
    expect(builtinTools().map((t) => t.name)).not.toContain('tool_request');
    expect(builtinTools().map((t) => t.name)).not.toContain('tool_idea');
  });
  it('the input schemas are strict (no kind, no extra keys)', () => {
    expect(plugins[0]!.inputSchema.safeParse({ tool: 'web_search', reason: 'r', kind: 'read' }).success).toBe(false);
    expect(plugins[1]!.inputSchema.safeParse({ name: 'abc', problem: 'long enough one', example: 'e', tool: 'x' }).success).toBe(false);
  });
  it('run passes the actor and the run taint (run or task) to the service; a refusal becomes a tool error with the fixed text', async () => {
    const ctx = { actor: { kind: 'head', dept: 'software' }, task: { id: 't1', tainted: true, owner: { kind: 'head', dept: 'software' } }, tainted: () => false };
    expect(await plugins[0]!.run({ tool: 'web_search', reason: 'r' }, ctx)).toEqual({ content: 'Tool request #7 ok' });
    expect(request).toHaveBeenCalledWith(ctx.actor, { tainted: false, task: { id: 't1', tainted: true }, ownsTask: true }, { tool: 'web_search', reason: 'r' });
    expect(await plugins[1]!.run({ name: 'abc', problem: 'long enough one', example: 'e' }, { ...ctx, task: null })).toEqual({ content: 'Your department already has 5 open tool ideas.', isError: true });
  });
  it('no skill and no tools.byDept list can grant them: rule G refuses and planBotTools add errors, both because the names are core builtins', () => {
    const env = { registered: () => [...GROW_TOOL_NAMES], builtins: () => [...GROW_TOOL_NAMES], kindOf: () => 'write' as const };
    for (const n of GROW_TOOL_NAMES) {
      expect(skillToolAllowed(n, env)).toBe(false);
      const plan = planBotTools('software', 'add', n, { org: { dept: () => ({}) as never }, cfg: { get: (() => ({})) as never }, tools: { plugins: () => [] } });
      expect(isError(plan)).toBe(true);
    }
    // even if someone registered them with a kind and left them out of builtins, they have no kind in this codebase
    expect(plugins.every((p) => p.kind === undefined)).toBe(true);
  });
});

describe('toolRequestId card plumbing (GW-C17)', () => {
  it('toPayload drops toolRequestId (and every other system key) from a model payload', () => {
    const out = toPayload({ type: 'approval', body: 'hi', toolRequestId: TOKEN, spendOverrideId: TOKEN, adminCardId: TOKEN, origin: 'governance' });
    expect(out).toEqual({ type: 'chat', body: 'hi' });
    expect(JSON.stringify(out)).not.toContain(TOKEN);
  });
  it('the custom id regex is anchored: exactly 32 lowercase hex and approve or reject', () => {
    expect(TOOL_REQUEST_ID.exec(`toolreq:${TOKEN}:approve`)?.[1]).toBe(TOKEN);
    for (const bad of [`toolreq:${TOKEN}:approve:x`, `x toolreq:${TOKEN}:approve`, `toolreq:${TOKEN}:APPROVE`, `toolreq:${'A'.repeat(32)}:approve`, `toolreq:${'a'.repeat(31)}:approve`, `toolreq:${TOKEN}:approve\n`, `toolreq:${TOKEN}:delete`])
      expect(TOOL_REQUEST_ID.test(bad)).toBe(false);
  });
  it('the row has Approve and Reject buttons with the token', () => {
    const row = toolRequestRow(TOKEN) as unknown as { components: { custom_id: string; label: string }[] };
    expect(row.components.map((c) => c.custom_id)).toEqual([`toolreq:${TOKEN}:approve`, `toolreq:${TOKEN}:reject`]);
  });
  it('isCardPayload and buildMessage render the row on an approval payload only', () => {
    const p = { type: 'approval' as const, origin: 'governance' as const, title: 'Tool request', body: 'b', toolRequestId: TOKEN };
    expect(isCardPayload(p)).toBe(true);
    expect(isCardPayload({ type: 'chat', body: 'b', toolRequestId: TOKEN })).toBe(true); // flagged as a card so it is never posted as plain chat
    const msgs = buildMessage(p, { deptColor: 0x3498db });
    expect(JSON.stringify(msgs.at(-1)!.components)).toContain(`toolreq:${TOKEN}:approve`);
    expect(JSON.stringify(buildMessage({ type: 'approval', body: 'b' }, { deptColor: 0 }).at(-1)!.components)).not.toContain('toolreq');
  });
});
