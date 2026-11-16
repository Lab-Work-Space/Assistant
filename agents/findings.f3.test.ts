import { describe, expect, it } from 'vitest';
import { AI_WARROOM_CHANNEL_ID } from '../company/channels.js';
import { runAgent } from './loop/loop.js';
import { FakeProvider, ProviderRegistry, type FakeTurn } from '../providers/index.js';
import { respond, route, setup } from './loop/loop-fixture.js';
import { CTO, SA, humanMsg } from './test-helpers.js';

const CHAN = '1565682159375749161';
const HINT = '@CFO cannot see this channel, so the mention is plain text and it will not answer here; use warroom_say to ask it in #ai-warroom.';

async function rig(turns: FakeTurn[], view: (dept: string, ch: string) => boolean = (d) => d !== 'finance') {
  const s = await setup();
  const p = new FakeProvider(turns, 'claude');
  const reg = new ProviderRegistry();
  reg.register(p);
  s.deps.providers = reg;
  const asked: [string, string][] = [];
  s.deps.canBotView = async (dept, ch) => (asked.push([dept, ch]), view(dept, ch));
  return { s, p, asked };
}
const msg = (over = {}) => humanMsg('ask finance', { channelId: CHAN, ...over });

describe('F3 a mention of a bot that cannot see the channel produces the hint (once per run)', () => {
  it('respond is held back once with the fixed hint; the second respond is posted as it is', async () => {
    const { s, p, asked } = await rig([{ toolUses: [respond('@CFO what is the budget? also @CTO')] }, { toolUses: [respond('@CFO what is the budget? also @CTO')] }]);
    const out = await runAgent({ route: route(CTO), msg: msg(), task: null, history: [] }, s.deps);
    expect(p.calls).toHaveLength(2);
    const last = p.calls[1]!.messages.at(-1)!.content[0] as { type: string; content: string };
    expect(last).toMatchObject({ type: 'tool_result', content: `not sent yet: ${HINT}` });
    expect(out.payload.body).toBe('@CFO what is the budget? also @CTO');
    expect(asked).toEqual([['finance', CHAN]]); // the caller's own handle is not checked
  });

  it('a plain text answer gets the same hint as a user turn', async () => {
    const { s, p } = await rig([{ text: 'asking @CFO' }, { toolUses: [respond('ok, will use warroom_say')] }]);
    const out = await runAgent({ route: route(CTO), msg: msg(), task: null, history: [] }, s.deps);
    expect(p.calls[1]!.messages.at(-1)).toEqual({ role: 'user', content: [{ type: 'text', text: HINT }] });
    expect(out.payload.body).toBe('ok, will use warroom_say');
  });

  it('no hint when the bot can see the channel, in the warroom itself, or for a run without warroom_say', async () => {
    const seen = await rig([{ toolUses: [respond('@CFO hi')] }], () => true);
    await runAgent({ route: route(CTO), msg: msg(), task: null, history: [] }, seen.s.deps);
    expect(seen.p.calls).toHaveLength(1);
    const wr = await rig([{ toolUses: [respond('@CFO hi')] }]);
    await runAgent({ route: route(CTO), msg: msg({ channelId: AI_WARROOM_CHANNEL_ID }), task: null, history: [] }, wr.s.deps);
    expect(wr.p.calls).toHaveLength(1);
    const persona = await rig([{ toolUses: [respond('@CFO hi')] }]);
    await runAgent({ route: route(SA), msg: msg(), task: null, history: [] }, persona.s.deps);
    expect(persona.p.calls).toHaveLength(1);
  });

  it('LF8: a failing permission read counts as "cannot see"', async () => {
    const { s, p } = await rig([{ toolUses: [respond('@CFO hi')] }, { toolUses: [respond('@CFO hi')] }]);
    s.deps.canBotView = async () => { throw new Error('boom'); };
    await runAgent({ route: route(CTO), msg: msg(), task: null, history: [] }, s.deps);
    expect(p.calls).toHaveLength(2);
  });
});

describe('G2LF-02 warroom_say is not offered in the warroom or on the stall turn', () => {
  it('a run whose message is in the warroom is not offered the tool; one elsewhere is', async () => {
    const a = await rig([{ toolUses: [respond('x')] }]);
    await runAgent({ route: route(CTO), msg: msg({ channelId: AI_WARROOM_CHANNEL_ID }), task: null, history: [] }, a.s.deps);
    expect(a.p.calls[0]!.tools.map((t) => t.name)).not.toContain('warroom_say');
    const b = await rig([{ toolUses: [respond('x')] }]);
    await runAgent({ route: route(CTO), msg: msg({ channelId: '1565682159375749161' }), task: null, history: [] }, b.s.deps);
    expect(b.p.calls[0]!.tools.map((t) => t.name)).toContain('warroom_say');
    const c = await rig([{ toolUses: [respond('x')] }]);
    await runAgent({ route: route(CTO), msg: msg({ channelId: 'th', threadId: 'th', parentChannelId: AI_WARROOM_CHANNEL_ID }), task: null, history: [] }, c.s.deps);
    expect(c.p.calls[0]!.tools.map((t) => t.name)).not.toContain('warroom_say');
  });
});
