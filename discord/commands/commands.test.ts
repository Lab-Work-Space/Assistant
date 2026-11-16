import { ApplicationCommandOptionType, CommandInteractionOptionResolver } from 'discord.js';
import { describe, expect, it } from 'vitest';
import { decryptSecret } from '../../config/secrets.js';
import { FakeDiscordPort } from '../../tests/fakes/discordPort.js';
import { COMMANDS, CONFIG_CHANNEL_ID, handleInteraction, postApprovalCard, toInteractionLike } from './index.js';
import { localProviderAllowed, type GuardFs } from '../../providers/claude-code-local/guard.js';
import { argvDigest } from '../../providers/claude-code-local/protocol.js';
import { ADMIN_ROLE, GUILD, cmd, interaction, makeDeps, MASTER_KEY, text } from './test-helpers.js';

const DENIED = '1565715069969502310';
const KEY = 'sk-ant-api03-SUPERSECRETKEYVALUE1234567890';

describe('guards', () => {
  it('rejects command outside #⚙️-setting', async () => {
    const t = await makeDeps();
    const i = cmd('halt', null, { channelId: '999' });
    const r = await handleInteraction(i, t.deps);
    expect(r?.ephemeral).toBe(true);
    expect(t.calls).toEqual([]);
  });
  it('rejects non-admin', async () => {
    const t = await makeDeps();
    const r = await handleInteraction(cmd('halt', null, { roles: ['1565000000000000002'] }), t.deps);
    expect(r?.ephemeral).toBe(true);
    expect(t.calls).toEqual([]);
  });
  it('interaction from other guild rejected', async () => {
    const t = await makeDeps();
    const i = cmd('halt', null, { guildId: '42' });
    expect(await handleInteraction(i, t.deps)).toBeNull();
    expect(i.replies).toEqual([]);
    expect(t.calls).toEqual([]);
  });
  it('role named Bot Admin with other id is not admin', async () => {
    const t = await makeDeps();
    const r = await handleInteraction(cmd('halt', null, { roles: ['Bot Admin'] }), t.deps);
    expect(r?.ephemeral).toBe(true);
    expect(t.calls).toEqual([]);
  });
  it('every reply uses allowedMentions parse []', async () => {
    const t = await makeDeps();
    const replies = [
      await handleInteraction(cmd('halt', null, { channelId: '1' }), t.deps),
      await handleInteraction(cmd('budget', 'set', { strings: { scope: 'daily' }, numbers: { usd: 10 } }), t.deps),
      await handleInteraction(cmd('usage', null), t.deps),
    ];
    for (const r of replies) expect(r?.allowedMentions).toEqual({ parse: [] });
  });
  it('every dept choice list includes praw', () => {
    const found: string[][] = [];
    const walk = (o: unknown): void => {
      if (Array.isArray(o)) return o.forEach(walk);
      if (o && typeof o === 'object') {
        const r = o as { name?: string; choices?: { value: string }[] };
        if (r.name === 'dept' && r.choices) found.push(r.choices.map((c) => c.value));
        Object.values(o).forEach(walk);
      }
    };
    walk(JSON.parse(JSON.stringify(COMMANDS)));
    expect(found.length).toBeGreaterThan(0);
    for (const c of found) expect(c).toContain('praw');
  });
  it('definitions cover the spec command set', () => {
    expect(COMMANDS.map((c) => c.name).sort()).toEqual(['approval', 'autoocr', 'bot', 'budget', 'channel', 'clickup', 'dashboard', 'forge', 'github', 'halt', 'holiday', 'limits', 'mcp', 'media', 'persona', 'project', 'provider', 'release', 'resume', 'retro', 'settings', 'skill', 'task', 'tool', 'usage', 'ws']);
  });
});

describe('budget / limits / approval', () => {
  it('/budget set daily 10 updates budget.companyDailyUsd and replies old 5 → new 10', async () => {
    const t = await makeDeps();
    const r = await handleInteraction(cmd('budget', 'set', { strings: { scope: 'daily' }, numbers: { usd: 10 } }), t.deps);
    expect(t.sets).toEqual([{ key: 'budget.companyDailyUsd', value: 10, by: 'u1' }]);
    expect(text(r)).toContain('5 → 10');
    expect(r?.ephemeral).toBe(false);
  });
  it.each([NaN, Infinity, -Infinity, 1e308, -1])('rejects %s without writing', async (usd) => {
    const t = await makeDeps();
    const r = await handleInteraction(cmd('budget', 'set', { strings: { scope: 'bot' }, numbers: { usd } }), t.deps);
    expect(r?.ephemeral).toBe(true);
    expect(t.sets).toEqual([]);
  });
  it('/limits set turns writes limits.turnsPerTask, rejects 0', async () => {
    const t = await makeDeps();
    const ok = await handleInteraction(cmd('limits', 'set', { strings: { limit: 'turns' }, numbers: { value: 30 } }), t.deps);
    expect(text(ok)).toContain('20 → 30');
    const bad = await handleInteraction(cmd('limits', 'set', { strings: { limit: 'turns' }, numbers: { value: 0 } }), t.deps);
    expect(bad?.ephemeral).toBe(true);
    expect(t.sets).toHaveLength(1);
  });
  it('/limits set praw-per-user-10min 1..1000 and praw-concurrency', async () => {
    const t = await makeDeps();
    const set = (limit: string, value: number) => handleInteraction(cmd('limits', 'set', { strings: { limit }, numbers: { value } }), t.deps);
    expect(text(await set('praw-per-user-10min', 1))).toContain('20 → 1');
    expect(text(await set('praw-per-user-10min', 1000))).toContain('1 → 1000');
    expect((await set('praw-per-user-10min', 0))?.ephemeral).toBe(true);
    expect((await set('praw-per-user-10min', 1001))?.ephemeral).toBe(true);
    expect(text(await set('praw-concurrency', 5))).toContain('3 → 5');
    expect((await set('praw-concurrency', 0))?.ephemeral).toBe(true);
    expect(t.sets.map((x) => x.key)).toEqual(['limits.prawPerUser10Min', 'limits.prawPerUser10Min', 'limits.prawConcurrency']);
  });
  it('/approval set updates approval.thresholdUsd', async () => {
    const t = await makeDeps();
    const r = await handleInteraction(cmd('approval', 'set', { numbers: { usd: 2 } }), t.deps);
    expect(text(r)).toContain('1 → 2');
  });
});

describe('deferral (3 s deadline) and errors', () => {
  it('slow handlers defer first and answer via editReply', async () => {
    const t = await makeDeps();
    const i = cmd('budget', 'set', { strings: { scope: 'daily' }, numbers: { usd: 10 } });
    await handleInteraction(i, t.deps);
    expect(i.deferred).not.toBeNull();
    expect(i.replies).toEqual([]);
    expect(i.edits).toHaveLength(1);
  });
  it('modal-opening commands do not defer', async () => {
    const t = await makeDeps();
    const a = cmd('provider', 'add', { strings: { id: 'openai' } });
    const b = cmd('persona', 'edit', { strings: { persona: 'system-analyst' } });
    await handleInteraction(a, t.deps);
    await handleInteraction(b, t.deps);
    expect([a.deferred, b.deferred]).toEqual([null, null]);
    expect([a.modals.length, b.modals.length]).toEqual([1, 1]);
  });
  it('provider modal submit defers privately; refusals do not defer', async () => {
    const t = await makeDeps();
    const m = interaction({ kind: 'modal', customId: 'provider-add:openai', fields: { key: KEY } });
    await handleInteraction(m, t.deps);
    expect(m.deferred).toEqual({ ephemeral: true });
    const bad = cmd('halt', null, { channelId: '1' });
    await handleInteraction(bad, t.deps);
    expect(bad.deferred).toBeNull();
    expect(bad.replies).toHaveLength(1);
  });
  it('a store error is logged masked and answered generically, not as invalid value', async () => {
    const t = await makeDeps();
    t.deps.cfg.set = async () => { throw new Error(`connection refused ${KEY}`); };
    const i = cmd('budget', 'set', { strings: { scope: 'daily' }, numbers: { usd: 10 } });
    await handleInteraction(i, t.deps);
    expect(text(i.edits[0]!)).not.toContain('Invalid value');
    expect(t.logLines.join('')).toContain('command failed');
    expect(t.logLines.join('')).not.toContain(KEY);
  });
});

describe('adapter option types', () => {
  it('/limits set value is read with getInteger on a real option resolver', async () => {
    const Resolver = CommandInteractionOptionResolver as unknown as new (c: never, o: unknown[]) => CommandInteractionOptionResolver;
    const resolver = new Resolver({} as never, [
      { name: 'set', type: ApplicationCommandOptionType.Subcommand, options: [
        { name: 'limit', type: ApplicationCommandOptionType.String, value: 'turns' },
        { name: 'value', type: ApplicationCommandOptionType.Integer, value: 30 },
      ] },
    ]);
    const raw = {
      isChatInputCommand: () => true, isButton: () => false, isModalSubmit: () => false, isStringSelectMenu: () => false, isFromMessage: () => false, isRepliable: () => true,
      guildId: '1', channelId: '2', user: { id: 'u' }, member: { roles: ['r'] }, commandName: 'limits', options: resolver,
    } as never;
    const like = toInteractionLike(raw)!;
    expect(like.options.string('limit')).toBe('turns');
    expect(like.options.integer('value')).toBe(30);
    const t = await makeDeps();
    const r = await handleInteraction({ ...like, guildId: GUILD, channelId: CONFIG_CHANNEL_ID, memberRoleIds: [ADMIN_ROLE], deferReply: async () => undefined, editReply: async () => undefined }, t.deps);
    expect(text(r)).toContain('20 → 30');
  });
  it('every integer/number option in definitions is read with a matching accessor', () => {
    const limits = COMMANDS.find((c) => c.name === 'limits')!.options!.find((o) => o.name === 'set') as { options: { name: string; type: number }[] };
    expect(limits.options.find((o) => o.name === 'value')!.type).toBe(ApplicationCommandOptionType.Integer);
  });
});

describe('/bot and /provider default (pricing, D4)', () => {
  it('/bot model rejects model without pricing entry', async () => {
    const t = await makeDeps();
    const r = await handleInteraction(cmd('bot', 'model', { strings: { dept: 'software', provider: 'claude', model: 'mystery-1' } }), t.deps);
    expect(r?.ephemeral).toBe(true);
    expect(t.mem.depts.get('software')!.model).toBeNull();
  });
  it('/bot model with priced model updates dept and reloads org', async () => {
    const t = await makeDeps();
    const r = await handleInteraction(cmd('bot', 'model', { strings: { dept: 'software', provider: 'claude', model: 'claude-haiku-5-5' } }), t.deps);
    expect(text(r)).toContain('→ claude/claude-haiku-5-5');
    expect(t.org.dept('software')!.model).toBe('claude-haiku-5-5');
  });
  it('/provider default rejects unpriced model, accepts priced', async () => {
    const t = await makeDeps();
    const bad = await handleInteraction(cmd('provider', 'default', { strings: { id: 'claude', model: 'mystery-1' } }), t.deps);
    expect(bad?.ephemeral).toBe(true);
    expect(t.sets).toEqual([]);
    const ok = await handleInteraction(cmd('provider', 'default', { strings: { id: 'claude', model: 'claude-haiku-5-5' } }), t.deps);
    expect(text(ok)).toContain('claude/claude-sonnet-5-5 → claude/claude-haiku-5-5');
  });
  it('/bot disable refuses hq, disables others; color parses hex', async () => {
    const t = await makeDeps();
    expect((await handleInteraction(cmd('bot', 'disable', { strings: { dept: 'hq' } }), t.deps))?.ephemeral).toBe(true);
    await handleInteraction(cmd('bot', 'disable', { strings: { dept: 'rnd' } }), t.deps);
    expect(t.org.dept('rnd')!.enabled).toBe(false);
    await handleInteraction(cmd('bot', 'color', { strings: { dept: 'rnd', hex: '#ff0000' } }), t.deps);
    expect(t.org.dept('rnd')!.color).toBe(0xff0000);
    expect((await handleInteraction(cmd('bot', 'color', { strings: { dept: 'rnd', hex: 'red' } }), t.deps))?.ephemeral).toBe(true);
  });
});

describe('/persona', () => {
  const create = (o: Record<string, string>) => cmd('persona', 'create', { strings: { dept: 'software', ...o } });
  it('/persona create adds persona and Org.reload sees it', async () => {
    const t = await makeDeps();
    const r = await handleInteraction(create({ name: 'Data Analyst', avatar: 'https://example.com/a.png' }), t.deps);
    expect(r?.ephemeral).toBe(false);
    expect(t.org.persona('data-analyst')?.name).toBe('Data Analyst');
    expect(t.org.personasOf('software').map((p) => p.id)).toContain('data-analyst');
    expect(t.deps.prompts.has('members/data-analyst')).toBe(true);
  });
  it('create refuses dept praw (R21)', async () => {
    const t = await makeDeps();
    const r = await handleInteraction(create({ name: 'Helper', dept: 'praw' }), t.deps);
    expect(r?.ephemeral).toBe(true);
    expect(text(r)).toMatch(/praw/i);
    expect([...t.mem.personas.keys()]).toEqual(['system-analyst']);
  });
  it.each([
    ['everyone', { name: 'Hi @everyone' }], ['here', { name: '@here bot' }], ['mention markup', { name: 'x <@123>' }],
    ['too long', { name: 'a'.repeat(81) }], ['empty', { name: '   ' }], ['bad dept', { name: 'Ok', dept: 'nope' }],
    ['http avatar', { name: 'Ok', avatar: 'http://example.com/a.png' }], ['js avatar', { name: 'Ok', avatar: 'javascript:alert(1)' }],
  ])('/persona create rejects %s', async (_n, o) => {
    const t = await makeDeps();
    const r = await handleInteraction(create(o), t.deps);
    expect(r?.ephemeral).toBe(true);
    expect([...t.mem.personas.keys()]).toEqual(['system-analyst']);
  });
  it('/persona edit opens a modal and the submit saves a new active override version', async () => {
    const t = await makeDeps();
    const i = cmd('persona', 'edit', { strings: { persona: 'system-analyst' } });
    expect(await handleInteraction(i, t.deps)).toBeNull();
    expect(i.modals[0]!.customId).toBe('persona-edit:system-analyst');
    const submit = interaction({ kind: 'modal', customId: 'persona-edit:system-analyst', fields: { body: 'You are a careful analyst.' } });
    await handleInteraction(submit, t.deps);
    await handleInteraction(interaction({ kind: 'modal', customId: 'persona-edit:system-analyst', fields: { body: 'You are even more careful.' } }), t.deps);
    expect(t.mem.overrides.map((o) => [o.version, o.active])).toEqual([[1, false], [2, true]]);
  });
  it('/persona reset deactivates override', async () => {
    const t = await makeDeps();
    await handleInteraction(interaction({ kind: 'modal', customId: 'persona-edit:system-analyst', fields: { body: 'Custom prompt text here.' } }), t.deps);
    const r = await handleInteraction(cmd('persona', 'reset', { strings: { persona: 'system-analyst' } }), t.deps);
    expect(r?.ephemeral).toBe(false);
    expect(await t.deps.repos.overrides.getActive('members/system-analyst')).toBeNull();
  });
  it('/persona delete soft-deletes: row remains, disabled; list marks it', async () => {
    const t = await makeDeps();
    expect(text(await handleInteraction(cmd('persona', 'list', {}), t.deps))).not.toContain('DISABLED');
    await handleInteraction(cmd('persona', 'delete', { strings: { persona: 'system-analyst' } }), t.deps);
    expect(t.mem.personas.get('system-analyst')?.enabled).toBe(false);
    expect(t.org.persona('system-analyst')?.enabled).toBe(false);
    expect(text(await handleInteraction(cmd('persona', 'list', {}), t.deps))).toContain('DISABLED');
  });
  it('/persona create refuses an existing prompt ref', async () => {
    const t = await makeDeps();
    t.deps.prompts.set('members/data-analyst', t.deps.prompts.get('members/system-analyst')!);
    const r = await handleInteraction(create({ name: 'Data Analyst' }), t.deps);
    expect(r?.ephemeral).toBe(true);
    expect(t.mem.personas.has('data-analyst')).toBe(false);
  });
  it('/persona create leaves no persona behind when the override write fails', async () => {
    const t = await makeDeps();
    t.deps.repos.overrides.upsert = async () => { throw new Error('db down'); };
    const r = await handleInteraction(create({ name: 'Data Analyst' }), t.deps);
    expect(r?.ephemeral).toBe(true);
    expect(t.mem.personas.has('data-analyst')).toBe(false);
    expect(t.deps.prompts.has('members/data-analyst')).toBe(false);
  });
});

describe('/channel', () => {
  it('/channel map refuses denied channel', async () => {
    const t = await makeDeps();
    const r = await handleInteraction(cmd('channel', 'map', { strings: { dept: 'software' }, channels: { channel: { id: DENIED, parentId: null } } }), t.deps);
    expect(r?.ephemeral).toBe(true);
    expect(t.mem.channels.size).toBe(0);
  });
  it.each(['1565667791938387969', '1565671253803794494', '1565671325597700157'])('/channel map refuses log/config channel %s', async (id) => {
    const t = await makeDeps();
    const r = await handleInteraction(cmd('channel', 'map', { strings: { dept: 'software' }, channels: { channel: { id, parentId: null } } }), t.deps);
    expect(r?.ephemeral).toBe(true);
    expect(t.mem.channels.size).toBe(0);
  });
  it('/channel map and unmap with work flag', async () => {
    const t = await makeDeps();
    const ch = { channel: { id: '777', parentId: null } };
    const r = await handleInteraction(cmd('channel', 'map', { strings: { dept: 'software' }, bools: { work: true }, channels: ch }), t.deps);
    expect(text(r)).toContain('software (work)');
    expect(t.org.deptOfChannel('777')).toBe('software');
    await handleInteraction(cmd('channel', 'unmap', { channels: ch }), t.deps);
    expect(t.org.deptOfChannel('777')).toBeNull();
  });
});

describe('/provider add (D12)', () => {
  it('opens a modal, then stores ciphertext and the reply contains no key', async () => {
    const t = await makeDeps();
    const i = cmd('provider', 'add', { strings: { id: 'openai' } });
    await handleInteraction(i, t.deps);
    expect(i.modals[0]!.customId).toBe('provider-add:openai');
    const r = await handleInteraction(interaction({ kind: 'modal', customId: 'provider-add:openai', fields: { key: KEY } }), t.deps);
    expect(text(r)).not.toContain(KEY);
    expect(r?.ephemeral).toBe(true);
    const stored = t.mem.keys.get('openai')!;
    expect(stored.ciphertext.toString('utf8')).not.toContain(KEY);
    expect(decryptSecret(stored, MASTER_KEY, 'openai')).toBe(KEY);
    expect(() => decryptSecret(stored, MASTER_KEY, 'other')).toThrow();
  });
  it('provider key absent from captured log output', async () => {
    const t = await makeDeps();
    t.deps.repos.providerKeys.upsert = async () => { throw new Error(`insert failed for ${KEY}`); };
    const r = await handleInteraction(interaction({ kind: 'modal', customId: 'provider-add:openai', fields: { key: KEY } }), t.deps);
    expect(r?.ephemeral).toBe(true);
    expect(text(r)).not.toContain(KEY);
    expect(t.logLines.length).toBeGreaterThan(0);
    expect(t.logLines.join('')).not.toContain(KEY);
    expect(JSON.stringify(t.audits)).not.toContain(KEY);
  });
  it('rejects a bad provider id', async () => {
    const t = await makeDeps();
    const i = cmd('provider', 'add', { strings: { id: '../x' } });
    await handleInteraction(i, t.deps);
    expect(i.modals).toEqual([]);
    expect(i.replies[0]?.ephemeral).toBe(true);
  });
});

describe('/halt /resume /usage', () => {
  it('/halt calls Halt.halt', async () => {
    const t = await makeDeps();
    const r = await handleInteraction(cmd('halt', null, { userId: 'boss' }), t.deps);
    expect(t.calls).toEqual(['halt:boss']);
    expect(text(r)).toContain('2 in-flight');
  });
  it('/resume calls Halt.resume then Approvals.resumeApproved', async () => {
    const t = await makeDeps();
    const r = await handleInteraction(cmd('resume', null, { userId: 'boss' }), t.deps);
    expect(t.calls).toEqual(['resume:boss', 'resumeApproved']);
    expect(text(r)).toContain('3 approved');
  });
  it('/usage summarises today without secrets', async () => {
    const t = await makeDeps();
    const r = await handleInteraction(cmd('usage', null), t.deps);
    expect(text(r)).toContain('$1.5000 spent');
    expect(text(r)).toContain('bot: head:hq');
  });
});

describe('approval buttons (D15)', () => {
  const btn = (id: string, roles?: string[]) => interaction({ kind: 'button', customId: id, userId: 'boss', roles });
  it('approval button by non-admin is rejected', async () => {
    const t = await makeDeps();
    const r = await handleInteraction(btn('approval:7:approve', ['1']), t.deps);
    expect(r?.ephemeral).toBe(true);
    expect(t.decisions).toEqual([]);
  });
  it('ask button by non-admin rejected', async () => {
    const t = await makeDeps();
    await handleInteraction(btn('approval:7:ask', ['1']), t.deps);
    expect(t.decisions).toEqual([]);
  });
  it('button outside #⚙️-setting or from another guild does nothing', async () => {
    const t = await makeDeps();
    await handleInteraction(interaction({ kind: 'button', customId: 'approval:7:approve', channelId: '5' }), t.deps);
    await handleInteraction(interaction({ kind: 'button', customId: 'approval:7:approve', guildId: '9' }), t.deps);
    expect(t.decisions).toEqual([]);
  });
  it('T5: an admin card button pressed outside #setting reaches the console (which checks the card\'s own channel and the presser\'s tier); nothing else leaves #setting', async () => {
    const t = await makeDeps();
    const clicks: unknown[] = [];
    (t.deps as { admin?: unknown }).admin = { click: async (c: unknown) => (clicks.push(c), { content: 'console', ephemeral: true }) };
    const room = '1565000000000000020';
    const card = 'a'.repeat(32);
    await handleInteraction(interaction({ kind: 'button', customId: `admincfg:${card}:confirm`, channelId: room, roles: ['some-tier-role'], userId: 'u9', messageId: 'm1', messageAuthorId: 'hq' }), t.deps);
    expect(clicks).toEqual([{ cardId: card, action: 'confirm', guildId: GUILD, channelId: room, userId: 'u9', memberRoleIds: ['some-tier-role'], messageId: 'm1', messageAuthorId: 'hq' }]);
    const other = interaction({ kind: 'button', customId: 'approval:7:approve', channelId: room, roles: ['some-tier-role'] });
    await handleInteraction(other, t.deps);
    await handleInteraction(cmd('halt', null, { channelId: room, roles: ['some-tier-role'] }), t.deps);
    expect(t.decisions).toEqual([]);
    expect(clicks).toHaveLength(1);
    expect(other.replies[0]).toMatchObject({ content: expect.stringContaining('#⚙️-setting') });
    // another guild is still dropped
    await handleInteraction(interaction({ kind: 'button', customId: `admincfg:${card}:confirm`, channelId: room, guildId: '9' }), t.deps);
    expect(clicks).toHaveLength(1);
  });
  it('admin approve/reject/ask route to Approvals.decide', async () => {
    const t = await makeDeps();
    await handleInteraction(btn('approval:7:approve', [ADMIN_ROLE]), t.deps);
    await handleInteraction(btn('approval:8:reject', [ADMIN_ROLE]), t.deps);
    const ask = await handleInteraction(btn('approval:9:ask', [ADMIN_ROLE]), t.deps);
    expect(t.decisions.map((d) => [d.id, d.decision, d.user.id])).toEqual([[7, 'approved', 'boss'], [8, 'rejected', 'boss'], [9, 'ask', 'boss']]);
    expect(ask?.ephemeral).toBe(true);
  });
  it('Part B: after a decision the card is closed in place (buttons removed) and the reply is private; ask leaves the card alone', async () => {
    const t = await makeDeps();
    const closed: unknown[] = [];
    (t.deps as { cards?: unknown }).cards = { close: async (c: string, m: string, n: string) => void closed.push([c, m, n]) };
    const approve = interaction({ kind: 'button', customId: 'approval:7:approve', userId: 'boss', roles: [ADMIN_ROLE], messageId: 'card-1', messageAuthorId: 'hq' });
    const r = await handleInteraction(approve, t.deps);
    expect(closed).toEqual([[CONFIG_CHANNEL_ID, 'card-1', 'Approval #7 approved by <@boss>.']]);
    expect(r?.ephemeral).toBe(true);
    await handleInteraction(interaction({ kind: 'button', customId: 'approval:9:ask', userId: 'boss', roles: [ADMIN_ROLE], messageId: 'card-2', messageAuthorId: 'hq' }), t.deps);
    expect(closed).toHaveLength(1);
    // a card that was already decided is closed too, and the refusal stays
    const dec = await makeDeps({ approvals: { decide: async () => ({ ok: false, error: 'not_pending' }), resumeApproved: async () => 0 } });
    (dec.deps as { cards?: unknown }).cards = { close: async (c: string, m: string, n: string) => void closed.push([c, m, n]) };
    const again = await handleInteraction(interaction({ kind: 'button', customId: 'approval:7:approve', userId: 'boss', roles: [ADMIN_ROLE], messageId: 'card-1', messageAuthorId: 'hq' }), dec.deps);
    expect(closed).toHaveLength(2);
    expect(again?.ephemeral).toBe(true);
  });
  it('F4: every approval button is deferred ephemeral, so the decision follow-up is never a public message (LF8: only the deciding admin sees it)', async () => {
    const t = await makeDeps();
    for (const a of ['approve', 'reject', 'ask']) {
      const i = interaction({ kind: 'button', customId: `approval:7:${a}`, userId: 'boss', roles: [ADMIN_ROLE], messageId: 'card-1', messageAuthorId: 'hq' });
      await handleInteraction(i, t.deps);
      expect(i.deferred, a).toEqual({ ephemeral: true });
      expect(i.replies, a).toEqual([]); // nothing is sent as a fresh public reply
    }
    // no card editing available: the fallback reply is private as well
    const i = interaction({ kind: 'button', customId: 'approval:7:reject', userId: 'boss', roles: [ADMIN_ROLE] });
    const r = await handleInteraction(i, t.deps);
    expect(r?.ephemeral).toBe(true);
  });
  it('expired or already decided approval gets an ephemeral refusal', async () => {
    const t = await makeDeps({ approvals: { decide: async () => ({ ok: false, error: 'expired' }), resumeApproved: async () => 0 } });
    const r = await handleInteraction(btn('approval:7:approve'), t.deps);
    expect(r?.ephemeral).toBe(true);
    expect(text(r)).toContain('expired');
  });
  it('malformed approval id is refused', async () => {
    const t = await makeDeps();
    const r = await handleInteraction(btn('approval:7;DROP:approve'), t.deps);
    expect(r?.ephemeral).toBe(true);
    expect(t.decisions).toEqual([]);
  });
  it('postApprovalCard posts via the hq head to #⚙️-setting with buttons', async () => {
    const port = new FakeDiscordPort();
    await postApprovalCard(port, { id: 12, taskId: 't1', reason: 'big', estCostUsd: 3, requestedBy: 'head:hq', status: 'pending', decidedBy: null, createdAt: new Date(), decidedAt: null });
    expect(port.posts[0]).toMatchObject({ actor: { kind: 'head', dept: 'hq' }, target: { channelId: '1565667791938387969' }, payload: { type: 'approval', origin: 'governance', buttons: { approvalId: '12' } } });
  });
});

describe('L9: provider selection refuses unregistered providers', () => {
  const registered = (...ids: string[]) => ({ has: (id: string) => ids.includes(id) });

  it('/provider default claude-code-local refused when not registered', async () => {
    const t = await makeDeps({ providers: registered('claude') });
    const r = await handleInteraction(cmd('provider', 'default', { strings: { id: 'claude-code-local', model: 'local/claude-sonnet-5-5' } }), t.deps);
    expect(r?.ephemeral).toBe(true);
    expect(text(r)).toMatch(/not available/);
    expect(t.sets).toEqual([]);
  });

  it('/provider default claude-code-local accepted with a local model id when registered (no pricing entry needed)', async () => {
    const t = await makeDeps({ providers: registered('claude', 'claude-code-local') });
    const bad = await handleInteraction(cmd('provider', 'default', { strings: { id: 'claude-code-local', model: 'claude-sonnet-5-5' } }), t.deps);
    expect(bad?.ephemeral).toBe(true);
    expect(t.sets).toEqual([]);
    const ok = await handleInteraction(cmd('provider', 'default', { strings: { id: 'claude-code-local', model: 'local/claude-sonnet-5-5' } }), t.deps);
    expect(text(ok)).toContain('→ claude-code-local/local/claude-sonnet-5-5');
  });

  it('/provider default claude refuses a local model id (no price: D4, L7)', async () => {
    const t = await makeDeps({ providers: registered('claude', 'claude-code-local') });
    const r = await handleInteraction(cmd('provider', 'default', { strings: { id: 'claude', model: 'local/claude-sonnet-5-5' } }), t.deps);
    expect(r?.ephemeral).toBe(true);
    expect(t.sets).toEqual([]);
  });

  it('/bot model refuses an unregistered provider and accepts a registered local one', async () => {
    const t = await makeDeps({ providers: registered('claude') });
    const r = await handleInteraction(cmd('bot', 'model', { strings: { dept: 'software', provider: 'claude-code-local', model: 'local/claude-haiku-5-5' } }), t.deps);
    expect(r?.ephemeral).toBe(true);
    expect(t.mem.depts.get('software')!.provider).toBeNull();
    const t2 = await makeDeps({ providers: registered('claude', 'claude-code-local') });
    await handleInteraction(cmd('bot', 'model', { strings: { dept: 'software', provider: 'claude-code-local', model: 'local/claude-haiku-5-5' } }), t2.deps);
    expect(t2.org.dept('software')).toMatchObject({ provider: 'claude-code-local', model: 'local/claude-haiku-5-5' });
  });

  const fs = (files: Record<string, string>): GuardFs => ({
    isOwnerOnlyFile: () => true,
    exists: (p) => Object.hasOwn(files, p) || p === '/usr/local/bin/claude',
    readFile: (p) => (p === '/Users/o/.config/assistant/probe-ok' ? `version=1.0 (x)\nrealpath=/usr/local/bin/claude\nsha256=abc\nargv_sha256=${argvDigest()}\n` : Object.hasOwn(files, p) ? files[p]! : null),
    isExecutable: (p) => p === '/usr/local/bin/claude',
    resolveClaude: (p) => p,
    sha256: async () => 'abc',
  });
  const ok = async () => ({ code: 0, stdout: '1.0 (x)\n' });
  const env = (over: object = {}) => ({ vars: { ALLOW_LOCAL_PROVIDERS: '1', PATH: '/usr/local/bin' }, platform: 'darwin', execArgv: [], home: '/Users/o', ...over });

  it('flag only in env file → provider absent', async () => {
    const file = '/Users/o/.config/assistant/env.local';
    // node --env-file copies the file into process.env, so the flag is visible there too; the file defining it refuses.
    expect((await localProviderAllowed(env(), fs({ [file]: 'ALLOW_LOCAL_PROVIDERS=1\n' }), ok)).ok).toBe(false);
    expect((await localProviderAllowed(env({ vars: { PATH: '/usr/local/bin' } }), fs({ [file]: 'ALLOW_LOCAL_PROVIDERS=1\n' }), ok)).ok).toBe(false);
    expect((await localProviderAllowed(env(), fs({ [file]: 'DATABASE_URL=x\n' }), ok)).ok).toBe(true);
  });

  it('linux / .dockerenv → absent', async () => {
    expect((await localProviderAllowed(env({ platform: 'linux' }), fs({}), ok)).ok).toBe(false);
    expect((await localProviderAllowed(env(), fs({ '/.dockerenv': '' }), ok)).ok).toBe(false);
  });
});

describe('SPEND-1 /usage titles and the override button guard', () => {
  it('S12: today and week keep their numbers and say (UTC) in the title', async () => {
    const t = await makeDeps();
    expect(text(await handleInteraction(cmd('usage', null, {}), t.deps))).toContain('Usage today (UTC)');
    expect(text(await handleInteraction(cmd('usage', null, { strings: { range: 'week' } }), t.deps))).toContain('Usage last 7 days (UTC)');
  });
  it('S2: a spendovr click from the wrong channel or a non-admin never reaches the service; the right one does', async () => {
    const t = await makeDeps();
    const seen: unknown[] = [];
    t.deps.spend = { report: async () => ({ body: '', fields: [] }), effectiveCap: async () => 1, supersede: async () => ({ count: 0, cards: [] }), decide: async (c) => { seen.push(c); return { ok: false, text: 'That raise expired or was already decided.' }; } };
    const id = `spendovr:${'a'.repeat(32)}:approve`;
    expect(text(await handleInteraction(interaction({ kind: 'button', customId: id, channelId: '999', messageId: 'm' }), t.deps))).toContain('#⚙️-setting');
    expect(text(await handleInteraction(interaction({ kind: 'button', customId: id, roles: [], messageId: 'm' }), t.deps))).toContain('Only Bot Admins');
    expect(seen).toEqual([]);
    const i = interaction({ kind: 'button', customId: id, messageId: 'm' });
    expect(text(await handleInteraction(i, t.deps))).toContain('expired or was already decided');
    expect(i.deferred).toEqual({ ephemeral: true });
    expect(seen).toHaveLength(1);
  });
});

describe('/usage with local calls', () => {
  it('shows the day\'s claude-code-local call count instead of a $0 cost row', async () => {
    const t = await makeDeps({
      budget: { usage: async (day) => [{ day, scope: 'local', scopeId: '', reservedUsd: 0, spentUsd: 0, calls: 7 }] },
    });
    const r = await handleInteraction(cmd('usage', null, { strings: { range: 'today' } }), t.deps);
    expect(text(r)).toContain('local calls (claude-code-local)');
    expect(text(r)).toContain('"value":"7"');
    expect(text(r)).not.toContain('local: ');
  });
});
