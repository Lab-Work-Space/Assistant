import { describe, expect, it } from 'vitest';
import { handlesIn } from '../company/handles.js';
import type { ActorRef } from '../company/types.js';
import { CH, roundTrip } from '../tests/fakes/roundtrip.js';

/**
 * TEAMTALK-1 Stage 6 (tester): a matrix of hostile model text pushed through the REAL port (noHandles), the REAL inbound mapper and the REAL router.
 * Every row must wake nobody, from a head in a thread and from a persona webhook in its room (top level and thread).
 */
const HQ: ActorRef = { kind: 'head', dept: 'hq' };
const SA: ActorRef = { kind: 'persona', personaId: 'system-analyst' };
const long = (s: string) => `${'y'.repeat(1900)} ${s} ${'z'.repeat(300)}`;
const ROWS: [string, string][] = [
  ['plain', 'please @CFO review'],
  ['all handles', '@CEO @CTO @R&D @IT @Marketing @Sales @HR @CFO @Ops @Praw'],
  ['code fence', '```\n@CFO\n```'],
  ['unterminated fence', '```\n@CFO and more'],
  ['inline code', 'run `@CFO` now'],
  ['after url', 'see https://example.com/a?b=@CFO and @CFO'],
  ['url only', 'https://x.example/@CFO'],
  ['bold/markdown', '**@CFO** _@CTO_ ~~@IT~~ ||@HR||'],
  ['punctuation', '(@CFO), @CFO. @CFO! @CFO? @CFO: "@CFO"'],
  ['newline split', '@\nCFO and @CFO\n@CEO'],
  ['raw user mention', '<@123456789012345678> <@!123456789012345678> <@&123456789012345678>'],
  ['everyone/here', '@everyone @here @EVERYONE @Here'],
  ['already zwj', '@‍CFO @​CFO @⁠CFO'],
  ['fullwidth', '＠CFO @ＣＦＯ'],
  ['crowded', '@@CFO @CFO@CFO x@CFO @CFO_ @CFO2 @CFO&'],
  ['long body', long('@CFO @everyone <@123456789012345678>')],
  ['named head only in url', 'http://@CFO'],
  ['embedded after redaction-like', 'Bearer abcdefghijklmnopqrstuvwxyz @CFO'],
];
const wheres = [
  ['head in thread', HQ, { channelId: CH.work, threadId: CH.thread }],
  ['persona room', SA, { channelId: CH.room }],
  ['persona room thread', SA, { channelId: CH.room, threadId: CH.roomThread }],
] as const;

describe('TEAMTALK-1 noHandles: hostile text wakes nobody', () => {
  for (const [rowName, text] of ROWS) {
    for (const [wn, actor, where] of wheres) {
      it(`${rowName} / ${wn}`, async () => {
        const r = await roundTrip(actor, where, { type: 'chat', title: `T ${text}`.slice(0, 200), body: text, noHandles: true });
        expect(r.routes).toEqual([]);
        expect(handlesIn(r.incoming.content)).toEqual([]);
        const wire = `${(r.sent.content as string) ?? ''}${JSON.stringify(r.sent.embeds ?? [])}`;
        expect(wire).not.toMatch(/<@/);
        expect(wire).not.toMatch(/@(everyone|here)/i);
        expect((r.sent as { allowedMentions?: unknown }).allowedMentions).toEqual({ parse: [] });
      });
    }
  }
  it('control: the same text WITHOUT noHandles from a head does route (the matrix can fail)', async () => {
    const r = await roundTrip(HQ, { channelId: CH.work, threadId: CH.thread }, { type: 'chat', body: 'please @CFO review' });
    expect(r.routes.length).toBeGreaterThan(0);
  });
});
