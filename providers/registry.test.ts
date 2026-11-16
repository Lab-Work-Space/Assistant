import { describe, expect, it } from 'vitest';
import type { ConfigStore } from '../config/store.js';
import { FakeProvider } from './fake.js';
import { ProviderRegistry } from './registry.js';

const cfg = { get: () => ({ provider: 'claude', model: 'default-model' }) } as unknown as ConfigStore;

function reg(): ProviderRegistry {
  const r = new ProviderRegistry();
  for (const id of ['claude', 'other']) {
    r.register(new FakeProvider([], id));
  }
  return r;
}

describe('ProviderRegistry', () => {
  it('persona model override beats dept beats default', () => {
    const r = reg();
    expect(r.resolve({ actor: { model: 'a' }, dept: { model: 'd' } }, cfg).model).toBe('a');
    expect(r.resolve({ dept: { provider: 'other', model: 'd' } }, cfg)).toMatchObject({ model: 'd', provider: { id: 'other' } });
    expect(r.resolve({}, cfg)).toMatchObject({ model: 'default-model', provider: { id: 'claude' } });
  });

  it('get throws for an unknown provider', () => {
    expect(() => reg().get('nope')).toThrow(/nope/);
  });

  it('has() reports registration', () => {
    expect(reg().has('claude')).toBe(true);
    expect(reg().has('claude-code-local')).toBe(false);
  });

  it('local provider maps API model names to local ids; other providers are untouched (L7)', () => {
    const r = reg();
    r.register(new FakeProvider([], 'claude-code-local'));
    const local = { get: () => ({ provider: 'claude-code-local', model: 'local/claude-sonnet-5-5' }) } as unknown as ConfigStore;
    expect(r.resolve({ actor: { model: 'claude-haiku-5-5' } }, local)).toMatchObject({ model: 'local/claude-haiku-5-5', provider: { id: 'claude-code-local' } });
    expect(r.resolve({ dept: { model: 'claude-sonnet-5-5' } }, local).model).toBe('local/claude-sonnet-5-5');
    expect(r.resolve({}, local).model).toBe('local/claude-sonnet-5-5');
    expect(r.resolve({ actor: { model: 'mystery-1' } }, local).model).toBe('mystery-1'); // unknown names pass through and are refused by the provider
    expect(r.resolve({ actor: { model: 'claude-haiku-5-5' } }, cfg).model).toBe('claude-haiku-5-5');
    expect(r.resolve({ actor: { provider: 'claude', model: 'claude-haiku-5-5' } }, local)).toMatchObject({ model: 'claude-haiku-5-5', provider: { id: 'claude' } });
  });

  // R8 PV-C01: in local mode the code default (claude) must never serve main work because a provider.default row is missing or invalid.
  it('defaultUsable: a selection that needs provider.default throws while it is not usable; a fully explicit selection does not', () => {
    let usable = false;
    const r = new ProviderRegistry({ defaultUsable: () => usable });
    for (const id of ['claude', 'other']) r.register(new FakeProvider([], id));
    expect(() => r.resolve({}, cfg)).toThrow(/provider\.default/);
    expect(() => r.resolve({ actor: { model: 'a' } }, cfg)).toThrow(/provider\.default/); // the provider still comes from the default
    expect(() => r.resolve({ dept: { provider: 'other' } }, cfg)).toThrow(/provider\.default/); // so does the model
    expect(r.resolve({ dept: { provider: 'other', model: 'd' } }, cfg)).toMatchObject({ model: 'd', provider: { id: 'other' } });
    usable = true;
    expect(r.resolve({}, cfg)).toMatchObject({ provider: { id: 'claude' } });
  });
  it('without the option nothing changes', () => {
    expect(reg().resolve({}, cfg)).toMatchObject({ provider: { id: 'claude' } });
  });
});
