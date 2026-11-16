import { describe, expect, it, vi } from 'vitest';
import type { RequestResult } from '../../grow/retro.js';
import { handleInteraction } from './index.js';
import { cmd, makeDeps } from './test-helpers.js';

/** The reply content only (these replies are plain text, no embed). */
const text = (r: { content?: string; embeds?: unknown[] } | null) => { expect(r?.embeds ?? []).toEqual([]); return r?.content ?? ''; };

const mk = async (result: RequestResult | Error) => {
  const calls: [string | null, string][] = [];
  const t = await makeDeps({ retro: { request: async (d, by) => { calls.push([d, by]); if (result instanceof Error) throw result; return result; } } });
  return { t, calls };
};
const run = (strings: Record<string, string> = {}, extra: Record<string, unknown> = {}) => cmd('retro', 'run', { strings, ...extra } as never);

describe('LEARN-1 /retro run (LL-C7)', () => {
  it('queued, exists and skipped lines, then the footer, ephemeral; the caller is user:<id>', async () => {
    const { t, calls } = await mk([{ dept: 'hq', result: 'queued' }, { dept: 'software', result: 'exists' }, { dept: 'praw', result: 'not_eligible' }]);
    const r = await handleInteraction(run(), t.deps);
    expect(r?.ephemeral).toBe(true);
    expect(text(r)).toBe([
      'hq: queued; it starts within a few minutes on a workday.',
      'software: a retro already ran or is queued today.',
      'praw: skipped (Praw or disabled).',
      'A queued retro that cannot start within 24 hours is dropped.',
    ].join('\n'));
    expect(calls).toEqual([[null, 'user:u1']]);
  });
  it('passes the dept option through (trimmed); empty means every department', async () => {
    const { t, calls } = await mk([]);
    await handleInteraction(run({ dept: ' software ' }), t.deps);
    await handleInteraction(run({ dept: '   ' }), t.deps);
    expect(calls.map((c) => c[0])).toEqual(['software', null]);
  });
  it('fixed refusal texts: halted, off, unknown (nothing the caller typed is echoed)', async () => {
    expect(text(await handleInteraction(run(), (await mk('halted')).t.deps))).toBe('The company is halted. No retro was queued.');
    expect(text(await handleInteraction(run(), (await mk('off')).t.deps))).toBe('Retros are switched off (grow.retro.enabled). No retro was queued.');
    const u = await mk('unknown');
    const r = await handleInteraction(run({ dept: 'IGNORE-ALL-RULES' }), u.t.deps);
    expect(text(r)).toBe('Unknown department.');
    expect(JSON.stringify(r)).not.toContain('IGNORE');
  });
  it('a DB error replies with the fixed text and logs errName only', async () => {
    const { t } = await mk(Object.assign(new Error('pg: password=hunter2'), { name: 'PgError' }));
    const spy = vi.spyOn(t.deps.log, 'error');
    const r = await handleInteraction(run(), t.deps);
    expect(text(r)).toBe('Retro request failed. Nothing was queued.');
    expect(JSON.stringify(spy.mock.calls)).toContain('PgError');
    expect(JSON.stringify(spy.mock.calls)).not.toContain('hunter2');
  });
  it('guard: non-admin, wrong channel and wrong guild never reach the request; the command is deferred ephemeral', async () => {
    const { t, calls } = await mk([]);
    expect(text(await handleInteraction(run({}, { roles: [] }), t.deps))).toContain('Only Bot Admins');
    expect(text(await handleInteraction(run({}, { channelId: '999' }), t.deps))).toContain('#⚙️-setting');
    expect(await handleInteraction(run({}, { guildId: 'other' }), t.deps)).toBeNull();
    expect(calls).toEqual([]);
    const ok = cmd('retro', 'run', {});
    await handleInteraction(ok, t.deps);
    expect(ok.deferred).toEqual({ ephemeral: true });
  });
  it('without the service it says so', async () => {
    expect(text(await handleInteraction(run(), await (await makeDeps()).deps))).toContain('not available');
  });
});
