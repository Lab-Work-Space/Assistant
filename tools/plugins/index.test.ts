import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ToolRegistry } from '../registry.js';
import type { ToolPlugin } from '../types.js';
import { pluginGroups, registerGroups, type GroupFactory } from './index.js';
import { FakeConfig } from '../../governance/test-helpers.js';
import { toGeminiSchema } from '../../providers/gemini/convert.js';
import { fakeResolver, fakeTransport } from '../../tests/fakes/net.js';
import type { PluginDeps } from './deps.js';
import { toolGroupsAlert } from '../../agents/scheduler/notices.js';

const deps = {} as PluginDeps;
const tool = (name: string): ToolPlugin<unknown> => ({ name, description: name, kind: 'read', inputSchema: z.object({}), requiresApproval: () => false, run: async () => ({ content: 'ok' }) });
const on = (id: string, ...names: string[]): GroupFactory => () => ({ id, tools: names.map(tool) });
const off = (id: string, disabled: string): GroupFactory => () => ({ id, disabled });

describe('groups', () => {
  it('a factory returning disabled is not registered and is listed once', () => {
    const reg = new ToolRegistry({ halt: { isHalted: () => false } });
    const r = registerGroups(reg, [on('a', 'a_one'), off('b', 'no B_KEY'), off('b', 'no B_KEY')], deps);
    expect(r.enabled).toEqual(['a']);
    expect(r.disabled).toEqual([{ id: 'b', why: 'no B_KEY' }]);
    expect(reg.names()).toEqual(['a_one']);
  });

  it('duplicate tool names across groups throw at boot', () => {
    const reg = new ToolRegistry({ halt: { isHalted: () => false } });
    expect(() => registerGroups(reg, [on('a', 'same'), on('b', 'same')], deps)).toThrow(/duplicate tool.*same/);
    expect(reg.names()).toEqual([]);
  });

  it('a plugin tool without a kind is a boot error and nothing is registered', () => {
    const reg = new ToolRegistry({ halt: { isHalted: () => false } });
    const { kind: _k, ...nokind } = tool('nk');
    expect(() => registerGroups(reg, [() => ({ id: 'bad', tools: [nokind] })], deps)).toThrow(/no kind/);
    expect(reg.names()).toEqual([]);
  });

  it('a factory that throws disables only its group', () => {
    const reg = new ToolRegistry({ halt: { isHalted: () => false } });
    const warn = vi.fn();
    const r = registerGroups(reg, [() => { throw new Error('boom secret=abc'); }, on('ok', 'ok_tool')], { log: { warn } } as unknown as PluginDeps);
    expect(JSON.stringify(warn.mock.calls)).toContain('Error');
    expect(JSON.stringify(warn.mock.calls)).not.toContain('secret=abc');
    expect(r.enabled).toEqual(['ok']);
    expect(r.disabled).toHaveLength(1);
  });

  it('toolGroupsAlert lists each disabled group once', () => {
    const p = toolGroupsAlert([{ id: 'clickup', why: 'CLICKUP_API_TOKEN not set' }]);
    expect(p).toMatchObject({ type: 'alert', origin: 'governance' });
    expect(p.body).toContain('clickup');
  });
});

describe('plugin groups', () => {
  const full = { cfg: new FakeConfig(), env: {}, log: { warn: vi.fn() }, workspaceRoot: '/nonexistent/praw-ws', metered: { call: vi.fn() }, net: { resolver: fakeResolver({}), transport: fakeTransport({}) } } as unknown as PluginDeps;

  it('the web group is wired and registers fetch_page and web_search as read, untrusted tools', () => {
    const reg = new ToolRegistry({ halt: { isHalted: () => false } });
    const r = registerGroups(reg, pluginGroups, full);
    expect(r.enabled).toContain('web');
    expect(reg.names()).toEqual(expect.arrayContaining(['fetch_page', 'web_search']));
  });

  it('the workspace and pin groups are wired (T20)', () => {
    const reg = new ToolRegistry({ halt: { isHalted: () => false } });
    const r = registerGroups(reg, pluginGroups, full);
    expect(r.enabled).toEqual(expect.arrayContaining(['workspace', 'pin']));
    expect(reg.names()).toEqual(expect.arrayContaining(['list_files', 'read_file', 'write_file', 'pin_message']));
  });

  it('the ocr group is wired (T32)', () => {
    const reg = new ToolRegistry({ halt: { isHalted: () => false } });
    const r = registerGroups(reg, pluginGroups, full);
    expect(r.enabled).toContain('ocr');
    expect(reg.names()).toContain('ocr_image');
  });

  it('all tool schemas convert for Gemini', () => {
    const reg = new ToolRegistry({ halt: { isHalted: () => false } });
    registerGroups(reg, pluginGroups, full);
    const specs = reg.specsFor(reg.names());
    expect(specs.length).toBe(reg.names().length);
    for (const s of specs) {
      const g = toGeminiSchema(s.inputSchema) as { type?: string; properties?: object };
      expect(g.type, s.name).toBe('OBJECT');
      expect(JSON.stringify(g), s.name).not.toMatch(/"\$schema"|"additionalProperties"|"\$ref"/);
    }
  });
});
