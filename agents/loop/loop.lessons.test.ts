import { describe, expect, it, vi } from 'vitest';
import type { ActorRef } from '../../company/types.js';
import { FakeProvider, ProviderRegistry } from '../../providers/index.js';
import { runAgent } from './loop.js';
import { respond, route, setup } from './loop-fixture.js';
import { CTO, humanMsg } from '../test-helpers.js';

const PRAW = { kind: 'head', dept: 'praw' } as const;

async function runAs(actor: ActorRef) {
  const s = await setup();
  const lessons = vi.fn(async () => ['LESSON-ONE', 'LESSON-TWO']);
  s.deps.lessons = lessons;
  const p = new FakeProvider([{ toolUses: [respond('ok')] }], actor.kind === 'head' && actor.dept === 'praw' ? 'gemini' : 'claude');
  const reg = new ProviderRegistry();
  reg.register(p);
  s.deps.providers = reg;
  await runAgent({ route: route(actor), msg: humanMsg('hi'), task: null, history: [] }, s.deps);
  return { lessons, req: p.calls[0]! };
}

describe('runAgent lessons (P13)', () => {
  it('loop › every non-admin run receives lessons (self-knowledge: no longer Praw only)', async () => {
    const praw = await runAs(PRAW);
    expect(praw.lessons).toHaveBeenCalledWith(PRAW);
    const first = JSON.stringify(praw.req.messages[0]);
    expect(first).toContain('LESSON-ONE');
    expect(first).toMatch(/kind=\\"lesson\\"/);
    expect(praw.req.system).not.toContain('LESSON-ONE'); // never system text
    const cto = await runAs(CTO);
    expect(cto.lessons).toHaveBeenCalledWith(CTO);
    expect(JSON.stringify(cto.req.messages)).toContain('LESSON-ONE');
    expect(cto.req.system).not.toContain('LESSON-ONE');
  });
});
