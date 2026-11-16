import { describe, expect, it } from 'vitest';
import { COMMANDS, handleInteraction } from './index.js';
import { cmd, interaction, makeDeps, text } from './test-helpers.js';
import { CONFIG_CHANNEL_ID, type CommandDeps } from './types.js';

const TOKEN = 'ab'.repeat(16);
const MSG = '800000000000000011';
const button = (customId: string, o: { channelId?: string | null; roles?: string[]; messageId?: string | null } = {}) =>
  interaction({ kind: 'button', customId, messageId: o.messageId === undefined ? MSG : o.messageId, ...(o.channelId !== undefined ? { channelId: o.channelId } : {}), ...(o.roles ? { roles: o.roles } : {}) });

const fake = () => {
  const calls: unknown[][] = [];
  const projects: NonNullable<CommandDeps['projects']> = {
    decideCard: async (c) => { calls.push(['card', c]); return c.action === 'approve' ? { ok: true, result: 'approved', project: { id: 4 } as never, root: { id: 'abcdef1234' } as never, adopted: 1, skipped: ['x'] } : { ok: true, result: 'rejected', project: { id: 4 } as never }; },
    decideBudget: async (c) => { calls.push(['bud', c]); return c.action === 'raise' ? { ok: true, result: 'raised', project: { id: 4 } as never, unblocked: 2 } : { ok: false, code: 'not_active', text: 'That project is not active.' }; },
    start: async (a) => { calls.push(['start', a]); return { ok: true, id: 9, text: 'Project proposal #9 was sent to the Bot Admins.', cardOk: true }; },
    list: async () => [
      { id: 5, status: 'active', paused: true, title: 'Big **one** @everyone', deadline: '2026-12-01', calls: 3, maxLocalCalls: 100, usd: '1.5', maxUsd: '5.000000', approvalsUsed: 2, maxApprovals: 500, rootTaskId: 'abcdef12-0000', pastDeadline: true, exhaustedAt: new Date(), messageId: null, expiresAt: new Date('2026-12-30') } as never,
      { id: 6, status: 'proposed', paused: false, title: 'Waiting', deadline: '2026-12-02', calls: 0, maxLocalCalls: 10, usd: 0, maxUsd: 1, approvalsUsed: 0, maxApprovals: 500, rootTaskId: null, pastDeadline: false, exhaustedAt: null, messageId: null, expiresAt: new Date('2026-10-01') } as never,
    ],
    pause: async (id, by) => { calls.push(['pause', id, by]); return { ok: true, text: `Project #${id} paused.` }; },
    resume: async (id, by) => { calls.push(['resume', id, by]); return { ok: true, text: `Project #${id} resumed.` }; },
    close: async (id, by) => { calls.push(['close', id, by]); return { ok: true, text: `Project #${id} closed.` }; },
    raise: async (id, by) => { calls.push(['raise', id, by]); return { ok: false, code: 'not_exhausted', text: "That project's budget is not used up." }; },
    extend: async (id, date, by) => { calls.push(['extend', id, date, by]); return { ok: true, text: `Project #${id} deadline is now ${date}.` }; },
  };
  return { projects, calls };
};

describe('/project definition', () => {
  it('has the seven subcommands; start has its required options first', () => {
    const p = COMMANDS.find((c) => c.name === 'project') as unknown as { options: { name: string; options?: { name: string; required?: boolean }[] }[] };
    expect(p.options.map((o) => o.name)).toEqual(['start', 'list', 'pause', 'resume', 'close', 'raise', 'extend']);
    expect(p.options[0]!.options!.map((o) => o.name)).toEqual(['title', 'goal', 'deadline', 'usd', 'calls', 'adopt', 'idea']);
    expect(p.options[0]!.options!.map((o) => !!o.required)).toEqual([true, true, true, true, true, false, false]);
  });
});

describe('projcard: button (AP-C11)', () => {
  it('an admin click in #setting reaches the service with the click channel, message and user; the reply is ephemeral', async () => {
    const t = await makeDeps();
    const f = fake();
    t.deps.projects = f.projects;
    const i = button(`projcard:${TOKEN}:approve`);
    const r = await handleInteraction(i, t.deps);
    expect(i.deferred).toEqual({ ephemeral: true });
    expect(f.calls).toEqual([['card', { token: TOKEN, action: 'approve', userId: 'u1', channelId: CONFIG_CHANNEL_ID, messageId: MSG }]]);
    expect(text(r)).toContain('Approved: project #4 started. Root task abcdef12. Adopted 1, skipped 1.');
    expect(text(await handleInteraction(button(`projcard:${TOKEN}:reject`), t.deps))).toContain('Rejected. Nothing started.');
  });
  it('refused paths show the fixed text of the service', async () => {
    const t = await makeDeps();
    t.deps.projects = { ...fake().projects, decideCard: async () => ({ ok: false, code: 'wrong_card', text: 'That button does not belong to this card.' }) };
    expect(text(await handleInteraction(button(`projcard:${TOKEN}:approve`), t.deps))).toContain('That button does not belong to this card.');
  });
  it('a non-admin, a click outside #setting, a malformed id or no service never reaches the service', async () => {
    const t = await makeDeps();
    const f = fake();
    t.deps.projects = f.projects;
    expect(text(await handleInteraction(button(`projcard:${TOKEN}:approve`, { roles: [] }), t.deps))).toContain('Only Bot Admins');
    expect(text(await handleInteraction(button(`projcard:${TOKEN}:approve`, { channelId: '999' }), t.deps))).toContain('#⚙️-setting');
    expect(text(await handleInteraction(button(`projbud:${TOKEN}:raise`, { channelId: '1570000000000000555' }), t.deps))).toContain('Use this in #⚙️-setting');
    expect(text(await handleInteraction(button(`projbud:${TOKEN}:raise`, { roles: [] }), t.deps))).toContain('Only Bot Admins');
    for (const bad of ['projcard:xyz:approve', `projcard:${TOKEN}:raise`, `projcard:${TOKEN.toUpperCase()}:approve`, `projcard:${TOKEN}`, `projcard:${TOKEN}:approve:x`, `projbud:${TOKEN}:approve`, `projbud:${TOKEN}:raise:x`])
      expect(text(await handleInteraction(button(bad), t.deps)), bad).toContain('Unknown action');
    expect(f.calls).toEqual([]);
    delete t.deps.projects;
    expect(text(await handleInteraction(button(`projcard:${TOKEN}:approve`), t.deps))).toContain('Unknown action');
  });
});

describe('projbud: button', () => {
  it('raise and close reach the service; the replies are private and fixed', async () => {
    const t = await makeDeps();
    const f = fake();
    t.deps.projects = f.projects;
    const i = button(`projbud:${TOKEN}:raise`);
    expect(text(await handleInteraction(i, t.deps))).toContain('Raised. 2 blocked tasks restarted.');
    expect(i.deferred).toEqual({ ephemeral: true });
    expect(f.calls[0]).toEqual(['bud', { token: TOKEN, action: 'raise', userId: 'u1', channelId: CONFIG_CHANNEL_ID, messageId: MSG }]);
    expect(text(await handleInteraction(button(`projbud:${TOKEN}:close`), t.deps))).toContain('That project is not active.');
  });
});

describe('/project commands', () => {
  it('start passes the options and the admin; the reply is the service text, private', async () => {
    const t = await makeDeps();
    const f = fake();
    t.deps.projects = f.projects;
    const i = cmd('project', 'start', { strings: { title: 'T', goal: 'G', deadline: '2026-12-31', adopt: 'abcdef12 12345678' }, numbers: { usd: 2.5, calls: 50 } });
    const r = await handleInteraction(i, t.deps);
    expect(i.deferred).toEqual({ ephemeral: true });
    expect(f.calls).toEqual([['start', { userId: 'u1', title: 'T', goal: 'G', deadline: '2026-12-31', usd: 2.5, calls: 50, adopt: 'abcdef12 12345678', idea: null }]]);
    expect(text(r)).toContain('Project proposal #9 was sent');
  });
  it('R7: start passes the optional idea number', async () => {
    const t = await makeDeps();
    const f = fake();
    t.deps.projects = f.projects;
    await handleInteraction(cmd('project', 'start', { strings: { title: 'T', goal: 'G', deadline: '2026-12-31' }, numbers: { usd: 2.5, calls: 50, idea: 4 } }), t.deps);
    expect(f.calls[0]![1]).toMatchObject({ idea: 4 });
  });
  it('list shows rows privately: flags, usage, escaped title; no mention gets through', async () => {
    const t = await makeDeps();
    t.deps.projects = fake().projects;
    const i = cmd('project', 'list');
    const r = await handleInteraction(i, t.deps);
    expect(r?.ephemeral).toBe(true);
    const s = text(r);
    expect(s).toContain('#5 active paused (past deadline) (budget used up)');
    expect(s).toContain('#6 proposed (expired) (no card)');
    expect(s).toContain('calls 3/100 | usd 1.50/5.00 | approvals 2/500 | root abcdef12');
    expect(s).toContain('\\\\*\\\\*one\\\\*\\\\*');
    expect(s).not.toContain('@everyone');
  });
  it('pause, resume, close, raise and extend pass the id, the date and the admin', async () => {
    const t = await makeDeps();
    const f = fake();
    t.deps.projects = f.projects;
    expect(text(await handleInteraction(cmd('project', 'pause', { numbers: { id: 5 } }), t.deps))).toContain('Project #5 paused.');
    expect(text(await handleInteraction(cmd('project', 'resume', { numbers: { id: 5 } }), t.deps))).toContain('Project #5 resumed.');
    expect(text(await handleInteraction(cmd('project', 'close', { numbers: { id: 5 } }), t.deps))).toContain('Project #5 closed.');
    expect(text(await handleInteraction(cmd('project', 'raise', { numbers: { id: 5 } }), t.deps))).toContain('not used up');
    expect(text(await handleInteraction(cmd('project', 'extend', { numbers: { id: 5 }, strings: { date: '2027-01-02' } }), t.deps))).toContain('deadline is now 2027-01-02');
    expect(f.calls).toEqual([['pause', 5, 'u1'], ['resume', 5, 'u1'], ['close', 5, 'u1'], ['raise', 5, 'u1'], ['extend', 5, '2027-01-02', 'u1']]);
  });
  it('a bad id is refused before the service; no service says so', async () => {
    const t = await makeDeps();
    const f = fake();
    t.deps.projects = f.projects;
    expect(text(await handleInteraction(cmd('project', 'close', { numbers: { id: 0 } }), t.deps))).toContain('No project with that number.');
    expect(text(await handleInteraction(cmd('project', 'extend', {}), t.deps))).toContain('No project with that number.');
    expect(f.calls).toEqual([]);
    delete t.deps.projects;
    expect(text(await handleInteraction(cmd('project', 'list'), t.deps))).toContain('not available');
  });
  it('non-admin and wrong-channel are refused for every subcommand; the service is never called', async () => {
    const t = await makeDeps();
    const f = fake();
    t.deps.projects = f.projects;
    for (const sub of ['start', 'list', 'pause', 'resume', 'close', 'raise', 'extend']) {
      expect(text(await handleInteraction(cmd('project', sub, { roles: [], numbers: { id: 1 } }), t.deps))).toContain('Only Bot Admins');
      expect(text(await handleInteraction(cmd('project', sub, { channelId: '999', numbers: { id: 1 } }), t.deps))).toContain('#⚙️-setting');
    }
    expect(f.calls).toEqual([]);
  });
});

describe('/project list scope line (AUTO-2 5.7)', () => {
  it('shows the company line, the project line, project on a read error, and the line before "No projects yet."', async () => {
    const f = fake();
    const t = await makeDeps();
    t.deps.projects = f.projects;
    expect(text(await handleInteraction(cmd('project', 'list'), t.deps))).toContain('Autopilot scope: project');
    t.deps.cfg.set('autopilot.scope', 'company', 'x');
    const co = text(await handleInteraction(cmd('project', 'list'), t.deps));
    expect(co).toContain('Autopilot scope: company (task trees outside a project run without cards, except dangerous work)');
    expect(co).toContain('2 shown, newest first.');
    t.deps.projects = { ...f.projects, list: async () => [] };
    const empty = text(await handleInteraction(cmd('project', 'list'), t.deps));
    expect(empty).toContain('Autopilot scope: company');
    expect(empty).toContain('No projects yet.');
    t.deps.cfg = { get: () => { throw new Error('read'); }, set: t.deps.cfg.set } as never;
    const err = text(await handleInteraction(cmd('project', 'list'), { ...t.deps, projects: f.projects }));
    expect(err).toContain('Autopilot scope: project');
    expect(err).not.toContain('company');
  });
});
