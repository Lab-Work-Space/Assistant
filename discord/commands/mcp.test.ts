import { describe, expect, it, vi } from 'vitest';
import type { AdminView } from '../../mcp/admin.js';
import { ADMIN_TEXT } from '../../mcp/errors.js';
import { COMMANDS, handleInteraction } from './index.js';
import { cmd, makeDeps, text } from './test-helpers.js';
import type { CommandDeps, Reply } from './types.js';

/** R6 MCP-1 BE2 (spec 5.10, MC-C7, MC-C16 title and ref, MCP-AC18 wiring part): `/mcp` in #setting for a live Bot Admin, rendered inert. */
const H12 = 'ab12cd34ef56';
const C12 = '0123456789ab';
const DESC = 'MCP tool echo from server srv (write class). Outside code: its output is untrusted. Server says: ping @everyone <@&1> [click](https://e.x/p) ```evil``` and https://phish.example/x www.phish.example';
const view = (o: Partial<AdminView> = {}): AdminView => ({
  slug: 'srv', title: 'Demo @everyone [t](https://t.x)', class: 'write', status: 'pending', depts: ['software'], toolCount: 1, hash12: H12, config12: C12,
  approveLine: `Run /mcp approve slug:srv hash:${C12} to install.`, imageId: `sha256:${'c'.repeat(64)}`, imageRef: 'ghcr.io/x/y:1 @everyone',
  tools: [{ name: 'mcp_w_srv_echo', description: DESC, schema: { type: 'object', properties: { text: { type: 'string', description: 'a <@1> `code`' } }, required: ['text'] } }], ...o,
} as AdminView);

function fake(over: Partial<NonNullable<CommandDeps['mcp']>> = {}) {
  const calls: { fn: string; args: unknown[] }[] = [];
  const rec = <T,>(fn: string, out: T) => vi.fn(async (...args: unknown[]) => { calls.push({ fn, args }); return out; });
  const mcp = {
    list: rec('list', [{ slug: 'srv', title: 'Demo @everyone [t](https://t.x)', class: 'write', status: 'active', depts: ['software'], tools: 2, hash12: H12 }]),
    show: rec('show', { ok: true, view: view() }),
    add: rec('add', { ok: true, view: view() }),
    approve: rec('approve', { ok: true, slug: 'srv', cfg12: C12 }),
    test: rec('test', { ok: true, result: 'ok' }),
    disable: rec('disable', { ok: true }),
    depts: rec('depts', { ok: true }),
    ...over,
  } as unknown as NonNullable<CommandDeps['mcp']>;
  return { mcp, calls };
}
const run = async (sub: string, o: Parameters<typeof cmd>[2], mcp?: CommandDeps['mcp']) => {
  const t = await makeDeps();
  if (mcp) t.deps.mcp = mcp;
  const i = cmd('mcp', sub, o);
  const r = await handleInteraction(i, t.deps);
  return { t, i, r: r as Reply };
};
const ADD = { strings: { slug: 'srv', image: `sha256:${'c'.repeat(64)}`, departments: 'software', title: 'Demo', class: 'write', command: '["a"]', env: 'A=b', ref: 'x:1' }, numbers: { timeout: 30, daily: 50 } };

describe('definitions', () => {
  it('COMMANDS gains mcp with the seven subcommands', () => {
    const c = COMMANDS.find((x) => x.name === 'mcp') as unknown as { options: { name: string }[] };
    expect(c.options.map((o) => o.name)).toEqual(['list', 'show', 'add', 'approve', 'test', 'disable', 'depts']);
  });
});

describe('guards: the same helper as /release (guild, #setting, live Bot Admin role)', () => {
  it('a non-admin, a wrong channel and another guild reach nothing', async () => {
    const f = fake();
    expect(text((await run('list', { roles: [] }, f.mcp)).r)).toContain('Only Bot Admins');
    expect(text((await run('list', { channelId: '999' }, f.mcp)).r)).toContain('#');
    expect((await run('list', { guildId: '1' }, f.mcp)).r).toBeNull();
    expect(f.calls).toEqual([]);
  });
  it('every subcommand defers ephemeral', async () => {
    const f = fake();
    for (const sub of ['list', 'show', 'add', 'approve', 'test', 'disable', 'depts']) {
      const x = await run(sub, { strings: { ...ADD.strings, slug: 'srv', hash: C12 }, numbers: ADD.numbers }, f.mcp);
      expect(x.i.deferred, sub).toEqual({ ephemeral: true });
      expect(x.r.ephemeral, sub).toBe(true);
      expect(x.r.allowedMentions, sub).toEqual({ parse: [] });
    }
  });
  it('without CommandDeps.mcp every subcommand says it is not available and does nothing', async () => {
    for (const sub of ['list', 'show', 'add', 'approve', 'test', 'disable', 'depts']) expect(text((await run(sub, { strings: { slug: 'srv' } })).r), sub).toContain('MCP is not available.');
  });
});

describe('/mcp list and /mcp show (MC-C7, MC-C16)', () => {
  it('list escapes the title and shows slug, class, status, departments and tool count', async () => {
    const x = await run('list', {}, fake().mcp);
    const t = text(x.r);
    expect(t).toContain('srv');
    expect(t).toContain('write');
    expect(t).not.toContain('@everyone');
    expect(t).not.toContain('](https://');
    expect(x.r.ephemeral).toBe(true);
  });
  it('an empty list says so', async () => {
    const x = await run('list', {}, fake({ list: async () => [] }).mcp);
    expect(text(x.r)).toContain('No MCP servers');
  });
  it('show renders exactly the model-visible description and schema, inert: mentions, masked links, URLs and code fences', async () => {
    const x = await run('show', { strings: { slug: 'srv' } }, fake().mcp);
    const c = x.r.content ?? '';
    expect(x.r.ephemeral).toBe(true);
    expect(x.r.suppressEmbeds).toBe(true);
    expect(x.r.allowedMentions).toEqual({ parse: [] });
    expect(x.r.embeds ?? []).toEqual([]);
    expect(c).toContain('mcp_w_srv_echo'.replace(/_/g, '\\_'));
    expect(c).not.toContain('@everyone');
    expect(c).toContain('@​everyone');
    expect(c).not.toContain('<@&1>');
    expect(c).not.toContain('<@1>');
    expect(c).not.toContain('](https://');
    expect(c).not.toContain('://');
    expect(c).not.toContain('```');
    expect(c).not.toMatch(/(?<!\\)`/);
    expect(c).not.toMatch(/www\.phish/);
    expect(c).toContain('Outside code');
    expect(c).toContain('untrusted');
    expect(c).toContain(H12);
    expect(c).toContain(C12);
    expect(c.length).toBeLessThanOrEqual(2000);
  });
  it('MC-C16: the title and the ref are escaped in every view; the ref is display only', async () => {
    const x = await run('show', { strings: { slug: 'srv' } }, fake().mcp);
    const c = x.r.content ?? '';
    expect(c).not.toContain('Demo @everyone');
    expect(c).not.toContain('](https://t.x)');
    expect(c).toContain('ghcr.io');
    expect(c).not.toContain('y:1 @everyone');
  });
  it('a long schema is paged, never cut: every page carries both hashes, the pages together hold the whole text, and a page out of range is refused', async () => {
    const props = Object.fromEntries(Array.from({ length: 16 }, (_, i) => [`p${i}`, { type: 'string', description: `desc ${i} ${'w'.repeat(100)} END${i}` }]));
    const f = fake({ show: async () => ({ ok: true, view: view({ tools: [{ name: 'mcp_w_srv_echo', description: DESC, schema: { type: 'object', properties: props } }] }) }) } as never);
    const pages: string[] = [];
    let n = 1;
    for (;;) {
      const x = await run('show', { strings: { slug: 'srv' }, numbers: { page: n } }, f.mcp);
      const c = x.r.content ?? '';
      expect(c.length, `page ${n}`).toBeLessThanOrEqual(2000);
      expect(c, `page ${n}`).toContain(H12);
      expect(c, `page ${n}`).toContain(C12);
      expect(x.r.suppressEmbeds).toBe(true);
      pages.push(c);
      const m = /page (\d+)\/(\d+)/.exec(c);
      expect(m, `page ${n}`).not.toBeNull();
      if (Number(m![1]) >= Number(m![2])) break;
      n++;
    }
    expect(pages.length).toBeGreaterThan(1);
    const all = pages.join('');
    for (let i = 0; i < 16; i++) expect(all).toContain(`END${i}`);
    const over = await run('show', { strings: { slug: 'srv' }, numbers: { page: pages.length + 1 } }, f.mcp);
    expect(text(over.r)).toContain('No such page');
    for (const bad of [0, -1]) expect(text((await run('show', { strings: { slug: 'srv' }, numbers: { page: bad } }, f.mcp)).r)).toContain('No such page');
  });
  it('a failure shows its fixed text and echoes nothing', async () => {
    const x = await run('show', { strings: { slug: 'srv' } }, fake({ show: async () => ({ ok: false, code: 'E_STATE', text: ADMIN_TEXT.E_STATE }) } as never).mcp);
    expect(text(x.r)).toContain(ADMIN_TEXT.E_STATE);
  });
});

describe('/mcp add (spec 3.2, 5.4)', () => {
  it('passes the fields and the live admin id (never a role or a name), then replies with the same inert page-1 view and the approve line', async () => {
    const f = fake();
    const x = await run('add', { ...ADD, userId: '123456789012345678' }, f.mcp);
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]!.args[0]).toEqual({ slug: 'srv', image: ADD.strings.image, class: 'write', departments: 'software', title: 'Demo', command: '["a"]', env: 'A=b', timeout: 30, daily: 50, ref: 'x:1' });
    expect(f.calls[0]!.args[1]).toEqual({ kind: 'admin', userId: '123456789012345678' });
    const c = x.r.content ?? '';
    expect(c).toContain(C12);
    expect(c).toContain('/mcp approve slug:srv hash:'.replace(/_/g, '\\_'));
    expect(c).not.toContain('@everyone');
    expect(c).not.toContain('://');
    expect(x.r.suppressEmbeds).toBe(true);
    expect(x.r.ephemeral).toBe(true);
  });
  it('omits unset optional fields', async () => {
    const f = fake();
    await run('add', { strings: { slug: 'srv', image: ADD.strings.image, departments: 'software', title: 'Demo' } }, f.mcp);
    expect(f.calls[0]!.args[0]).toEqual({ slug: 'srv', image: ADD.strings.image, departments: 'software', title: 'Demo' });
  });
  it('a refusal shows its fixed text only', async () => {
    const x = await run('add', ADD, fake({ add: async () => ({ ok: false, code: 'E_IMAGE', text: ADMIN_TEXT.E_IMAGE }) } as never).mcp);
    expect(text(x.r)).toContain(ADMIN_TEXT.E_IMAGE);
    expect(text(x.r)).not.toContain('Demo');
  });
  it('a throw from the closure is the generic failure (the interaction layer masks it)', async () => {
    const x = await run('add', ADD, fake({ add: async () => { throw new Error('secret-detail'); } } as never).mcp);
    expect(text(x.r)).not.toContain('secret-detail');
    expect(text(x.r)).toContain('That failed');
  });
});

describe('/mcp approve, test, disable, depts', () => {
  it('approve passes slug and the 12 hex token with the admin id', async () => {
    const f = fake();
    const x = await run('approve', { strings: { slug: 'srv', hash: C12 }, userId: '123456789012345678' }, f.mcp);
    expect(f.calls[0]).toEqual({ fn: 'approve', args: [{ slug: 'srv', token: C12 }, { kind: 'admin', userId: '123456789012345678' }] });
    expect(text(x.r)).toContain('srv');
    expect(text(x.r).toLowerCase()).toContain('active');
  });
  it('approve refusals show the fixed text', async () => {
    const x = await run('approve', { strings: { slug: 'srv', hash: C12 } }, fake({ approve: async () => ({ ok: false, code: 'E_CHANGED', text: ADMIN_TEXT.E_CHANGED }) } as never).mcp);
    expect(text(x.r)).toContain(ADMIN_TEXT.E_CHANGED);
  });
  it('test says ok or mismatch; disable and depts confirm', async () => {
    expect(text((await run('test', { strings: { slug: 'srv' } }, fake().mcp)).r)).toContain('matches');
    expect(text((await run('test', { strings: { slug: 'srv' } }, fake({ test: async () => ({ ok: true, result: 'mismatch' }) } as never).mcp)).r)).toContain('does not match');
    const f = fake();
    expect(text((await run('disable', { strings: { slug: 'srv' } }, f.mcp)).r)).toContain('disabled');
    expect(text((await run('depts', { strings: { slug: 'srv', departments: 'software,rnd' } }, f.mcp)).r)).toContain('software');
    expect(f.calls.map((c) => c.fn)).toEqual(['disable', 'depts']);
    expect(f.calls[1]!.args.slice(0, 2)).toEqual(['srv', 'software,rnd']);
  });
  it('a missing required option is refused before the closure', async () => {
    const f = fake();
    expect(text((await run('approve', { strings: { slug: 'srv' } }, f.mcp)).r)).toContain('hash');
    expect(text((await run('depts', { strings: { slug: 'srv' } }, f.mcp)).r)).toContain('departments');
    expect(f.calls).toEqual([]);
  });
});
