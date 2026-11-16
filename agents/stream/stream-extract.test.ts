import { describe, expect, it } from 'vitest';
import { BODY_LIMIT, RespondExtractor } from './stream-extract.js';

/** Gate 1 S20: strict incremental extraction of the respond body. */

const input = () => new RespondExtractor({ shape: 'input' });
const local = (tools: string[] = ['respond', 'warroom_say']) => new RespondExtractor({ shape: 'local', tools: new Set(tools) });

function run(x: RespondExtractor, json: string, step: number): string {
  for (let i = 0; i < json.length; i += step) x.feed(json.slice(i, i + step));
  return x.body;
}
const STEPS = [1, 2, 3, 7, 1000];

describe('shape input (Claude API respond block)', () => {
  it('decodes the body of a normal input at every fragment size', () => {
    const obj = { type: 'chat', title: 'T', body: 'Line one\nLine "two" \\ back/slash \t tab é ไทย 😀', fields: [{ name: 'n', value: 'v' }] };
    for (const s of STEPS) expect(run(input(), JSON.stringify(obj), s)).toBe(obj.body);
  });
  it('body key order does not matter (type/title first, or body first)', () => {
    expect(run(input(), '{"body":"abc","type":"chat"}', 2)).toBe('abc');
    expect(run(input(), '{"type":"chat","title":"x","body":"abc"}', 2)).toBe('abc');
  });
  it('handles \\uXXXX split across fragments, including a surrogate pair', () => {
    const json = '{"body":"a\\u00e9b \\ud83d\\ude00 c"}';
    for (const s of STEPS) expect(run(input(), json, s)).toBe('aéb 😀 c');
  });
  it('a lone surrogate is passed through like JSON.parse does', () => {
    const json = '{"body":"x\\ud83dy"}';
    expect(run(input(), json, 1)).toBe(JSON.parse(json).body);
  });
  it('an escaped key that decodes to body is the body key; a duplicate body freezes the block', () => {
    expect(run(input(), '{"bo\\u0064y":"hi there"}', 3)).toBe('hi there');
    const x = input();
    x.feed('{"body":"first",');
    x.feed('"body":"second"}');
    expect(x.body).toBe('first');
    expect(x.status).toBe('frozen');
    const y = input();
    y.feed('{"body":"first","bo\\u0064y":"second"}');
    expect(y.body).toBe('first');
    expect(y.status).toBe('frozen');
  });
  it('a nested body (inside fields) is ignored; the top-level body still streams', () => {
    expect(run(input(), '{"fields":[{"body":"NESTED","name":"x"}],"body":"top"}', 4)).toBe('top');
    expect(run(input(), '{"fields":[{"body":"NESTED"}]}', 4)).toBe('');
  });
  it('a non-string body freezes', () => {
    for (const bad of ['{"body":5}', '{"body":{"a":"b"}}', '{"body":["x"]}', '{"body":null}', '{"body":true}']) {
      const x = input();
      x.feed(bad);
      expect(x.body).toBe('');
      expect(x.status).toBe('frozen');
    }
  });
  it('invalid JSON freezes: raw control character, invalid escape, non-JSON whitespace, top-level non-object, trailing garbage', () => {
    const cases: [string, string][] = [
      ['{"body":"a\nb"}', 'a'],
      ['{"body":"a\\qb"}', 'a'],
      ['{"body":"ab\\u12G4"}', 'ab'],
      ['{"body":"ab"} x', 'ab'],
      ['[{"body":"ab"}]', ''],
      ['{"body":"ab"} x', 'ab'],
      ['{"x":1,,"body":"ab"}', ''],
      ['{" body":"ab"}', ''],
      ['{ "body":"ab"}', ''],
    ];
    for (const [json, expected] of cases) {
      const x = input();
      x.feed(json);
      expect(x.body, json).toBe(expected);
    }
    const nbsp = input();
    nbsp.feed('{ "body":"ab"}');
    expect(nbsp.status).toBe('frozen');
  });
  it('a 200 KB delta is bounded: the body stops at BODY_LIMIT and the call stays fast', () => {
    const big = `{"body":"${'x'.repeat(200_000)}"}`;
    const x = input();
    const t0 = Date.now();
    x.feed(big);
    expect(x.body.length).toBe(BODY_LIMIT);
    expect(Date.now() - t0).toBeLessThan(500);
    expect(x.status).toBe('done');
  });
  it('20,000-deep nesting freezes without recursion or quadratic work', () => {
    const x = input();
    const t0 = Date.now();
    x.feed(`{"a":${'['.repeat(20_000)}`);
    expect(x.status).toBe('frozen');
    expect(Date.now() - t0).toBeLessThan(500);
  });
  it('a very long key is not captured whole', () => {
    const x = input();
    x.feed(`{"${'k'.repeat(100_000)}":1,"body":"ok"}`);
    expect(x.body).toBe('ok');
  });
  it('feed is incremental and returns whether the body grew', () => {
    const x = input();
    expect(x.feed('{"body":"')).toBe(false);
    expect(x.feed('abc')).toBe(true);
    expect(x.feed('def')).toBe(true);
    expect(x.feed('"}')).toBe(false);
    expect(x.status).toBe('done');
    expect(x.body).toBe('abcdef');
  });
});

describe('shape local (claude-code-local structured output), VULN-004', () => {
  const j = (calls: unknown) => JSON.stringify({ tool_calls: calls });
  it('streams the respond item body', () => {
    const json = j([{ name: 'respond', input: { type: 'chat', body: 'Hello there' } }]);
    for (const s of STEPS) expect(run(local(), json, s)).toBe('Hello there');
  });
  it('only the respond item streams: another tool before it is skipped', () => {
    const json = j([{ name: 'warroom_say', input: { body: 'NOT THIS' } }, { name: 'respond', input: { body: 'this one' } }]);
    expect(run(local(), json, 5)).toBe('this one');
  });
  it('input before name: nothing streams', () => {
    const x = local();
    x.feed('{"tool_calls":[{"input":{"body":"SECRET-OTHER"},"name":"respond"}]}');
    expect(x.body).toBe('');
  });
  it('duplicate name before input (respond then another): nothing streams', () => {
    const x = local();
    x.feed('{"tool_calls":[{"name":"respond","name":"warroom_say","input":{"body":"NOT THIS"}}]}');
    expect(x.body).toBe('');
    const y = local();
    y.feed('{"tool_calls":[{"name":"warroom_say","name":"respond","input":{"body":"NOT THIS"}}]}');
    expect(y.body).toBe('');
  });
  it('respond not in req.tools: nothing streams', () => {
    const x = local(['warroom_say']);
    x.feed(j([{ name: 'respond', input: { body: 'nope' } }]));
    expect(x.body).toBe('');
  });
  it('an escaped name that decodes to respond counts as respond; a name with other case does not', () => {
    expect(run(local(), '{"tool_calls":[{"name":"resp\\u006fnd","input":{"body":"yes"}}]}', 3)).toBe('yes');
    expect(run(local(), '{"tool_calls":[{"name":"Respond","input":{"body":"no"}}]}', 3)).toBe('');
  });
  it('a duplicate input in the item freezes; a duplicate tool_calls freezes', () => {
    const x = local();
    x.feed('{"tool_calls":[{"name":"respond","input":{"body":"one"},"input":{"body":"two"}}]}');
    expect(x.body).toBe('one'); // already shown; the final text replaces it
    const y = local();
    y.feed('{"tool_calls":[],"tool_calls":[{"name":"respond","input":{"body":"two"}}]}');
    expect(y.body).toBe('');
  });
  it('a nested body inside input.fields is ignored; a non-object input is ignored', () => {
    expect(run(local(), j([{ name: 'respond', input: { fields: [{ body: 'NESTED' }], body: 'top' } }]), 2)).toBe('top');
    expect(run(local(), '{"tool_calls":[{"name":"respond","input":"body"}]}', 2)).toBe('');
  });
  it('a text-only structured output streams nothing', () => {
    expect(run(local(), '{"text":"plain reply"}', 3)).toBe('');
  });
  it('the first respond item wins; later items are not mixed in', () => {
    const json = j([{ name: 'respond', input: { body: 'first' } }, { name: 'respond', input: { body: 'second' } }]);
    expect(run(local(), json, 4)).toBe('first');
  });
  it('a name with a non-string value or an over-long name never matches', () => {
    expect(run(local(), '{"tool_calls":[{"name":5,"input":{"body":"x"}}]}', 3)).toBe('');
    expect(run(local(), `{"tool_calls":[{"name":"${'respond'.repeat(40)}","input":{"body":"x"}}]}`, 3)).toBe('');
  });
});
