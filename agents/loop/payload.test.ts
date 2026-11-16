import { describe, expect, it } from 'vitest';
import { textToPayload, toPayload } from './payload.js';

describe('toPayload', () => {
  it('toPayload rejects 26 fields by truncating to 25', () => {
    const fields = Array.from({ length: 26 }, (_, i) => ({ name: `f${i}`, value: `v${i}` }));
    const p = toPayload({ type: 'report', title: 'R', body: 'b', fields });
    expect(p.fields).toHaveLength(25);
    expect(p.fields!.at(-1)).toEqual({ name: 'f24', value: 'v24' });
  });

  it('truncates title to 256 and drops footer and buttons from model output', () => {
    const p = toPayload({ type: 'approval', title: 'x'.repeat(300), body: 'b', footer: { model: 'm', costUsd: 9, ms: 1 }, buttons: { approvalId: '7' } });
    expect(p).toEqual({ type: 'chat', title: 'x'.repeat(256), body: 'b' });
  });

  it('config type and invalid shapes fall back to chat', () => {
    expect(toPayload({ type: 'config', body: 'halted=false' })).toEqual({ type: 'chat', body: 'halted=false' });
    expect(toPayload('hello')).toEqual({ type: 'chat', body: 'hello' });
    expect(toPayload(42)).toEqual({ type: 'chat', body: '42' });
  });

  it('textToPayload honours a JSON payload and keeps plain text as chat', () => {
    expect(textToPayload('{"type":"report","body":"done"}')).toEqual({ type: 'report', body: 'done' });
    expect(textToPayload('just words')).toEqual({ type: 'chat', body: 'just words' });
    expect(textToPayload('{not json')).toEqual({ type: 'chat', body: '{not json' });
  });

  it('textToPayload unwraps a leaked respond call and never posts tool_calls JSON raw', () => {
    const leak = (c: unknown) => JSON.stringify({ tool_calls: c });
    expect(textToPayload(leak([{ name: 'respond', input: { type: 'report', body: 'done' } }]))).toEqual({ type: 'report', body: 'done' });
    for (const t of [
      leak([{ name: 'create_task', input: { title: 'x' } }]),
      leak([{ name: 'respond', input: { nope: 1 } }]),
      '{"tool_calls":[{"name":"respond","input":{"body":"say "hi""}}]}',
      '{ "tool_calls" : "x"',
    ]) {
      const out = textToPayload(t);
      expect(out.type).toBe('chat');
      expect(out.body).not.toContain('tool_calls');
    }
  });
});

describe('owner plain-chat rule', () => {
  it('a model answer typed approval renders as chat, never a card', async () => {
    const { toPayload } = await import('./payload.js');
    expect(toPayload({ type: 'approval', body: 'waiting for card #4' })).toEqual({ type: 'chat', body: 'waiting for card #4' });
  });
});
