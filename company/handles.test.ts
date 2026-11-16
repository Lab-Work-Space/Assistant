import { describe, expect, it } from 'vitest';
import { defangHandles, handlesIn, neutralise, toMentions } from './handles.js';

const ID = { hq: '111111111111111111', software: '222222222222222222', rnd: '333333333333333333', it: '444444444444444444' } as Record<string, string>;
const conv = (t: string) => toMentions(neutralise(t), (d) => ID[d]);

describe('TW8 handles', () => {
  it('converts the listed handles, case-exact and word-bounded, only for heads that have an id', () => {
    expect(conv('@CEO please check, @CTO and @R&D: ok? (@IT)')).toBe('<@111111111111111111> please check, <@222222222222222222> and <@333333333333333333>: ok? (<@444444444444444444>)');
    expect(conv('@Sales stays plain without a live id')).toBe('@Sales stays plain without a live id');
    expect(conv('@ceo @Ceo @cto')).toBe('@ceo @Ceo @cto');
  });

  it('does not convert @ITEM, a@IT.com, @IT.com, @CEOs or @R&Dx', () => {
    for (const t of ['@ITEM', 'write to a@IT.com', 'see @IT.com now', '@CEOs', '@R&Dx', 'x@@IT']) expect(conv(t), t).toBe(t);
    expect(conv('end @IT.')).toBe('end <@444444444444444444>.');
  });

  it('leaves code spans, code fences and URLs alone', () => {
    expect(conv('use `@CTO` here')).toBe('use `@CTO` here');
    expect(conv('```\n@CTO @IT\n```\nthen @IT')).toBe('```\n@CTO @IT\n```\nthen <@444444444444444444>');
    expect(conv('https://x.test/@CTO/a @CTO')).toBe('https://x.test/@CTO/a <@222222222222222222>');
    expect(conv('```unterminated @CTO')).toBe('```unterminated @CTO');
  });

  it('neutralises raw user, nickname and role mentions, @everyone and @here before converting', () => {
    for (const t of ['<@123456789012345678>', '<@!123456789012345678>', '<@&123456789012345678>', '@everyone', '@here', '@EVERYONE']) {
      const out = conv(t);
      expect(out, t).not.toBe(t);
      expect(out.replace(/‍/g, '')).toBe(t);
      expect(/<@!?&?\d{17,20}>|@everyone|@here/i.test(out), t).toBe(false);
    }
  });

  it('a converted mention is never neutralised again, and a model-typed <@id> of a head does not survive as a live mention', () => {
    expect(conv('<@222222222222222222> @CTO')).toMatch(/^<‍@222222222222222222> <@222222222222222222>$/);
  });

  it('handlesIn reads the same handles (outside code and URLs), once per department, in order', () => {
    expect(handlesIn('@CTO @IT @CTO and `@HR` https://a/@Ops a@Sales.com @R&D')).toEqual(['software', 'it', 'rnd']);
  });
});

describe('TEAMTALK T1 defangHandles', () => {
  const samples = [
    'plain @CFO text', '@CEO @CTO @R&D @IT @Marketing @Sales @HR @Ops @Praw', '```\n@CFO inside a fence\n```', '```unterminated @CFO', 'see https://x.test/@CFO then @CFO',
    '`@CTO` inline', 'title @CFO.', '(@IT)', 'a@IT.com @IT', 'x@@IT', '@CFOx @CFO', 'Subtask done: "@CFO review"', /* G2TT-01 */ '@CFOhttps://x.test', '@CFO.https://x.test', 'see @R&Dhttp://a.b ok',
  ];
  it('leaves no handle anywhere, including code spans, fences and URLs', () => {
    for (const t of samples) {
      const out = defangHandles(t);
      expect(handlesIn(out), t).toEqual([]);
      // not even a handle that handlesIn would skip because it sits in code or a URL stays live
      expect(toMentions(out, () => '111111111111111111'), t).not.toMatch(/<@\d/);
      expect(out.replace(/\u200d/g, ''), t).toBe(t);
    }
  });
  it('is idempotent and leaves text without handles unchanged', () => {
    for (const t of samples) expect(defangHandles(defangHandles(t)), t).toBe(defangHandles(t));
    expect(defangHandles('no handles, user@example.com and @items')).toBe('no handles, user@example.com and @items');
    // G2TT-01: context-free, so a near-handle gets the (invisible) ZWJ too
    expect(defangHandles('@ITEM a@IT.com')).toBe('@\u200dITEM a@\u200dIT.com');
  });
  it('handles a title-sized string and a handle after a URL', () => {
    expect(handlesIn(defangHandles('https://a.test/x @CFO'))).toEqual([]);
    expect(handlesIn(defangHandles('@CFO'.repeat(3)))).toEqual([]);
  });
});
