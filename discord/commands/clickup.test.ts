import { describe, expect, it } from 'vitest';
import { COMMANDS, handleInteraction } from './index.js';
import { cmd, makeDeps, text } from './test-helpers.js';
import { allRig, teamB, TEAM_B } from '../../tools/plugins/clickup/multi-helpers.js';
import { workspaceLabelText } from '../../tools/plugins/clickup/client.js';

const CH = '1565999999999999001';
const set = (extra = {}) => cmd('clickup', 'channel', { channels: { channel: { id: CH, parentId: null } }, ...extra });

describe('/clickup channel', () => {
  it('/clickup channel › admin only, in #setting; stores a validated id through ConfigStore and audits', async () => {
    const t = await makeDeps();
    expect(text(await handleInteraction(set({ roles: [] }), t.deps))).toContain('Only Bot Admins');
    expect(text(await handleInteraction(set({ channelId: '5' }), t.deps))).toContain('#⚙️-setting');
    expect(t.sets).toHaveLength(0);
    const ok = await handleInteraction(set(), t.deps);
    expect(text(ok)).toContain(CH);
    expect(t.deps.cfg.get('clickup.notifyChannelId')).toBe(CH);
    expect(t.sets.at(-1)).toMatchObject({ key: 'clickup.notifyChannelId', value: CH, by: 'user:u1' });
    expect(t.audits.at(-1)).toMatchObject({ action: 'clickup.channel', tool: CH, outcome: 'ok' });
  });

  it('/clickup channel › no channel clears it (null)', async () => {
    const t = await makeDeps();
    await handleInteraction(set(), t.deps);
    await handleInteraction(cmd('clickup', 'channel', {}), t.deps);
    expect(t.deps.cfg.get('clickup.notifyChannelId')).toBeNull();
    expect(t.audits.at(-1)).toMatchObject({ action: 'clickup.channel', tool: 'clear' });
  });
});

/** A scope check shaped like the client's: a class that reads its own state through `this`, so an unbound method would fail loudly. */
class FakeScope {
  readonly mode: 'list' | 'workspace';
  readonly known: Set<string>;
  readonly calls: string[] = [];
  constructor(mode: 'list' | 'workspace' = 'workspace', known: string[] = ['7001', '7002', '7003']) {
    this.mode = mode;
    this.known = new Set(known);
  }
  async listInScope(id: string): Promise<never> {
    this.calls.push(id);
    if (!this.known.has(id)) throw new Error('ClickUp: that list is not in this workspace');
    return { id } as never;
  }
}
const watch = (listId: string, action: string, extra = {}) => cmd('clickup', 'watch', { strings: { list_id: listId, action }, ...extra });

describe('C11 /clickup watch (workspace mode)', () => {
  it('admin only, in #setting; add checks the list against the workspace, writes clickup.pollListIds and audits', async () => {
    const scope = new FakeScope();
    const t = await makeDeps({ clickup: scope });
    expect(text(await handleInteraction(watch('7001', 'add', { roles: [] }), t.deps))).toContain('Only Bot Admins');
    expect(text(await handleInteraction(watch('7001', 'add', { channelId: '5' }), t.deps))).toContain('#⚙️-setting');
    expect(t.sets).toHaveLength(0);
    const ok = await handleInteraction(watch('7001', 'add'), t.deps);
    expect(text(ok)).toContain('7001');
    expect(t.deps.cfg.get('clickup.pollListIds')).toEqual(['7001']);
    expect(scope.calls).toEqual(['7001']);
    expect(t.sets.at(-1)).toMatchObject({ key: 'clickup.pollListIds', by: 'user:u1' });
    expect(t.audits.at(-1)).toMatchObject({ action: 'clickup.watch', tool: 'add:7001', outcome: 'ok' });
  });

  it('refuses a list that is not in the workspace (same text for foreign, missing and a ClickUp error), writes nothing, audits the refusal', async () => {
    const t = await makeDeps({ clickup: new FakeScope() });
    const a = text(await handleInteraction(watch('7999', 'add'), t.deps));
    const b = text(await handleInteraction(watch('1234', 'add'), t.deps));
    expect(a).toContain('not in the ClickUp workspace');
    expect(a).toBe(b);
    expect(t.deps.cfg.get('clickup.pollListIds')).toEqual([]);
    expect(t.sets).toHaveLength(0);
    expect(t.audits.at(-1)).toMatchObject({ action: 'clickup.watch', tool: 'add:1234', outcome: 'refused' });
  });

  it('refuses the 11th list and a duplicate; remove works and refuses an unwatched list', async () => {
    const ids = Array.from({ length: 12 }, (_, i) => String(7000 + i));
    const t = await makeDeps({ clickup: new FakeScope('workspace', ids) });
    for (const id of ids.slice(0, 10)) expect(text(await handleInteraction(watch(id, 'add'), t.deps))).not.toMatch(/At most|already/);
    expect(t.deps.cfg.get('clickup.pollListIds')).toHaveLength(10);
    expect(text(await handleInteraction(watch(ids[10]!, 'add'), t.deps))).toContain('At most 10');
    expect(text(await handleInteraction(watch(ids[0]!, 'add'), t.deps))).toContain('watched already');
    expect(t.deps.cfg.get('clickup.pollListIds')).toHaveLength(10);
    expect(text(await handleInteraction(watch(ids[0]!, 'remove'), t.deps))).toContain(ids[0]!);
    expect(t.deps.cfg.get('clickup.pollListIds')).not.toContain(ids[0]);
    expect(text(await handleInteraction(watch(ids[11]!, 'remove'), t.deps))).toContain('not watched');
  });

  it('in list mode (or with ClickUp off) it refuses with the reason and asks ClickUp nothing', async () => {
    const scope = new FakeScope('list');
    const t = await makeDeps({ clickup: scope });
    expect(text(await handleInteraction(watch('7001', 'add'), t.deps))).toContain('workspace mode is not on');
    expect(scope.calls).toEqual([]);
    const off = await makeDeps();
    expect(text(await handleInteraction(watch('7001', 'add'), off.deps))).toContain('workspace mode is not on');
  });

  it('bad action or list id shape is refused before any ClickUp call', async () => {
    const scope = new FakeScope();
    const t = await makeDeps({ clickup: scope });
    expect(text(await handleInteraction(watch('7001', 'drop'), t.deps))).toContain('add or remove');
    expect(text(await handleInteraction(watch('../x', 'add'), t.deps))).toContain('list id');
    expect(scope.calls).toEqual([]);
  });

  it('is registered with list_id and action options', () => {
    const def = COMMANDS.find((c) => c.name === 'clickup')!;
    const sub = def.options!.find((o) => o.name === 'watch') as unknown as { options: { name: string; required?: boolean }[] };
    expect(sub.options.map((o) => o.name)).toEqual(['list_id', 'action']);
  });
});

class FakeSeen {
  readonly forgotten: string[] = [];
  async forgetBaseline(id: string): Promise<void> { this.forgotten.push(id); }
}
describe('C11 /clickup watch remove forgets the list baseline, so a later add baselines silently', () => {
  it('remove calls forgetBaseline for that list only; add does not', async () => {
    const seen = new FakeSeen();
    const t = await makeDeps({ clickup: new FakeScope(), clickupSeen: seen });
    await handleInteraction(watch('7001', 'add'), t.deps);
    await handleInteraction(watch('7002', 'add'), t.deps);
    expect(seen.forgotten).toEqual([]);
    await handleInteraction(watch('7001', 'remove'), t.deps);
    expect(seen.forgotten).toEqual(['7001']);
    expect(t.deps.cfg.get('clickup.pollListIds')).toEqual(['7002']);
    await handleInteraction(watch('7003', 'remove'), t.deps); // not watched: refused, nothing forgotten
    expect(seen.forgotten).toEqual(['7001']);
  });
});


describe('CLICKUP-MULTI-1 /clickup watch with CLICKUP_TEAM_ID=all', () => {
  it('adds a list of any workspace of the token and shows the workspace label next to EACH id (never the team id)', async () => {
    const t = await makeDeps({ clickup: allRig().client as never });
    await handleInteraction(watch('7001', 'add'), t.deps);
    const reply = text(await handleInteraction(watch('8001', 'add'), t.deps));
    expect(reply).toContain('8001 (workspace');
    expect(reply).toContain('7001 (workspace'); // the id that was already watched is labelled too
    expect(reply).toMatch(/8001 \(workspace Acme \\+\[/);
    expect(reply).not.toContain(TEAM_B);
    expect(t.deps.cfg.get('clickup.pollListIds')).toEqual(['7001', '8001']); // the stored value is the bare ids
  });
  it('a workspace name made of markdown, a mention and a role ping is escaped in the reply', async () => {
    const t = await makeDeps({ clickup: allRig({ more: [teamB({ name: '**x** <@&1> @everyone' })] }).client as never });
    const reply = text(await handleInteraction(watch('8001', 'add'), t.deps));
    expect(reply).not.toContain('**x**');
    expect(reply).not.toContain('<@&1>');
    expect(reply).not.toMatch(/@everyone/);
    expect(reply).toMatch(/\\+\*\\+\*x/); // the asterisks are backslash-escaped
    expect(reply).toMatch(/@\u200beveryone/); // the ping is broken by a zero width space
  });
  it('refuses a list of a workspace the token cannot see, with the fixed text and nothing written', async () => {
    const t = await makeDeps({ clickup: allRig().client as never });
    const foreign = text(await handleInteraction(watch('7999', 'add'), t.deps));
    expect(foreign).toContain('not in the ClickUp workspace');
    expect(text(await handleInteraction(watch('9999', 'add'), t.deps))).toBe(foreign);
    expect(t.deps.cfg.get('clickup.pollListIds')).toEqual([]);
  });
  it('the mode-off reason mentions CLICKUP_TEAM_ID=all', async () => {
    const t = await makeDeps({ clickup: new FakeScope('list') });
    expect(text(await handleInteraction(watch('7001', 'add'), t.deps))).toContain('CLICKUP_TEAM_ID=all');
  });
});
