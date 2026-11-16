import { describe, expect, it } from 'vitest';
import { COMMANDS, handleInteraction } from './index.js';
import { cmd, interaction, makeDeps, text } from './test-helpers.js';
import { CONFIG_CHANNEL_ID, type CommandDeps } from './types.js';

const TOKEN = 'cd'.repeat(16);
const button = (customId: string, o: { channelId?: string | null; roles?: string[]; messageId?: string | null } = {}) =>
  interaction({ kind: 'button', customId, messageId: o.messageId === undefined ? '800000000000000011' : o.messageId, ...(o.channelId !== undefined ? { channelId: o.channelId } : {}), ...(o.roles ? { roles: o.roles } : {}) });

const growFake = (over: { decide?: NonNullable<CommandDeps['grow']>['requests']['decide'] } = {}) => {
  const decided: unknown[] = [];
  const closedIdeas: unknown[] = [];
  const grow: NonNullable<CommandDeps['grow']> = {
    requests: {
      decide: over.decide ?? (async (c) => { decided.push(c); return { ok: true, result: 'approved', row: { deptId: 'software', tool: 'web_search' } as never }; }),
      listPending: async () => [
        { id: 3, deptId: 'software', tool: 'web_search', messageId: '800000000000000011', expiresAt: new Date('2026-11-17T00:00:00Z') } as never,
        { id: 4, deptId: 'rnd', tool: 'fetch_page', messageId: null, expiresAt: new Date('2026-11-18T00:00:00Z') } as never,
      ],
    },
    ideas: {
      list: async () => [
        { id: 1, deptId: 'software', name: 'pdf_reader', problem: 'We cannot read **scanned** PDFs @everyone', example: 'e', tainted: true, createdAt: new Date('2026-11-09T00:00:00Z') } as never,
        { id: 2, deptId: 'rnd', name: 'csv_diff', problem: 'Compare two CSV files', example: 'e', tainted: false, createdAt: new Date('2026-11-10T00:00:00Z') } as never,
      ],
      close: async (id, userId, reason) => { closedIdeas.push([id, userId, reason]); return id === 1 ? { ok: true } : { ok: false, text: 'That idea is not open.' }; },
    },
  };
  return { grow, decided, closedIdeas };
};

describe('toolreq: button (GW-C17)', () => {
  it('an admin click in #setting reaches decide() with the click\'s channel, message and user; the reply is ephemeral', async () => {
    const t = await makeDeps();
    const f = growFake();
    t.deps.grow = f.grow;
    const i = button(`toolreq:${TOKEN}:approve`);
    const r = await handleInteraction(i, t.deps);
    expect(i.deferred).toEqual({ ephemeral: true });
    expect(f.decided).toEqual([{ token: TOKEN, action: 'approve', userId: 'u1', channelId: CONFIG_CHANNEL_ID, messageId: '800000000000000011' }]);
    expect(text(r)).toContain('Approved: software may use web_search');
  });
  it('reject has its own reply; a refused decide shows the fixed text', async () => {
    const t = await makeDeps();
    const f = growFake();
    t.deps.grow = f.grow;
    expect(text(await handleInteraction(button(`toolreq:${TOKEN}:reject`), t.deps))).toContain('Rejected. Nothing changed.');
    const g = growFake({ decide: async () => ({ ok: false, code: 'not_pending', text: 'Already decided.' }) });
    t.deps.grow = g.grow;
    expect(text(await handleInteraction(button(`toolreq:${TOKEN}:approve`), t.deps))).toContain('Already decided.');
  });
  it('a click from another channel, from a non-admin, a malformed id or without the service never reaches decide()', async () => {
    const t = await makeDeps();
    const f = growFake();
    t.deps.grow = f.grow;
    expect(text(await handleInteraction(button(`toolreq:${TOKEN}:approve`, { channelId: '999' }), t.deps))).toContain('#⚙️-setting');
    expect(text(await handleInteraction(button(`toolreq:${TOKEN}:approve`, { channelId: '1570000000000000555' }), t.deps))).toContain('Use this in #⚙️-setting');
    expect(text(await handleInteraction(button(`toolreq:${TOKEN}:approve`, { roles: [] }), t.deps))).toContain('Only Bot Admins');
    for (const bad of ['toolreq:xyz:approve', `toolreq:${TOKEN}:delete`, `toolreq:${TOKEN.toUpperCase()}:approve`, `toolreq:${TOKEN}`, `toolreq:${TOKEN}:approve:x`])
      expect(text(await handleInteraction(button(bad), t.deps)), bad).toContain('Unknown action');
    expect(f.decided).toEqual([]);
    delete t.deps.grow;
    expect(text(await handleInteraction(button(`toolreq:${TOKEN}:approve`), t.deps))).toContain('Unknown action');
  });
});

describe('/tool', () => {
  it('is in the command set with the three flat subcommands', () => {
    const tool = COMMANDS.find((c) => c.name === 'tool') as unknown as { options: { name: string }[] };
    expect(tool.options.map((o) => o.name)).toEqual(['ideas', 'idea_close', 'requests']);
  });
  it('ideas lists open ideas privately: id, dept, name, date, UNVERIFIED for a tainted one, the problem escaped', async () => {
    const t = await makeDeps();
    t.deps.grow = growFake().grow;
    const i = cmd('tool', 'ideas');
    const r = await handleInteraction(i, t.deps);
    expect(i.deferred).toEqual({ ephemeral: true });
    expect(r?.ephemeral).toBe(true);
    const s = text(r);
    expect(s).toContain('#1 software pdf_reader (2026-11-09) UNVERIFIED');
    expect(s).toContain('#2 rnd csv_diff (2026-11-10)');
    expect(s).not.toContain('#2 rnd csv_diff (2026-11-10) UNVERIFIED');
    expect(s).toContain('\\\\*\\\\*scanned\\\\*\\\\*');
    expect(s).not.toContain('@everyone');
  });
  it('idea_close passes the id, the admin and the reason; a not-open idea is a fixed line', async () => {
    const t = await makeDeps();
    const f = growFake();
    t.deps.grow = f.grow;
    expect(text(await handleInteraction(cmd('tool', 'idea_close', { numbers: { id: 1 }, strings: { reason: 'built elsewhere' } }), t.deps))).toContain('Idea #1 closed.');
    expect(f.closedIdeas).toEqual([[1, 'u1', 'built elsewhere']]);
    expect(text(await handleInteraction(cmd('tool', 'idea_close', { numbers: { id: 2 } }), t.deps))).toContain('That idea is not open.');
    expect(f.closedIdeas.at(-1)).toEqual([2, 'u1', null]);
  });
  it('requests lists pending ones: card posted or no card, expiry; never the reason', async () => {
    const t = await makeDeps();
    t.deps.grow = growFake().grow;
    const s = text(await handleInteraction(cmd('tool', 'requests'), t.deps));
    expect(s).toContain('#3 software web_search');
    expect(s).toContain('card posted, expires <t:');
    expect(s).toContain('#4 rnd fetch_page');
    expect(s).toContain('no card, expires <t:');
  });
  it('non-admin and wrong-channel are refused for every subcommand; the service is never called', async () => {
    const t = await makeDeps();
    const f = growFake();
    t.deps.grow = f.grow;
    for (const sub of ['ideas', 'idea_close', 'requests']) {
      expect(text(await handleInteraction(cmd('tool', sub, { roles: [], numbers: { id: 1 } }), t.deps))).toContain('Only Bot Admins');
      expect(text(await handleInteraction(cmd('tool', sub, { channelId: '999', numbers: { id: 1 } }), t.deps))).toContain('#⚙️-setting');
    }
    expect(f.closedIdeas).toEqual([]);
  });
  it('without the service it says so', async () => {
    const t = await makeDeps();
    expect(text(await handleInteraction(cmd('tool', 'ideas'), t.deps))).toContain('not available');
  });
});
