import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { CTO, MemTasks, auditSpy, newBus, MemNotes, seededOrg, runCtxBase } from '../agents/test-helpers.js';
import { CONFIG_DEFAULTS } from '../config/defaults.js';
import { Limits } from '../governance/limits.js';
import { FakeConfig } from '../governance/test-helpers.js';
import type { PromptDoc } from '../prompts/index.js';
import { builtinTools } from './builtin/index.js';
import { createToolPolicy, unknownPromptTools } from './policy.js';
import { ToolRegistry } from './registry.js';
import type { ToolContext, ToolPlugin } from './types.js';

const BUILTIN = ['create_task', 'update_task', 'respond'];
const PLUGINS = ['web_search', 'fetch_page', 'extract_receipt', 'clickup_list_open_tasks', 'clickup_create_task'];
const policy = (cfg = new FakeConfig(), registered = [...BUILTIN, ...PLUGINS]) => createToolPolicy(cfg, () => registered, () => BUILTIN);

describe('policy', () => {
  it('"*" expands to all registered; unregistered names dropped', () => {
    const p = policy(new FakeConfig({ 'tools.byDept': { praw: ['ghost_tool'] } }));
    const out = p.effective('praw', ['*']);
    expect(out.sort()).toEqual([...BUILTIN, ...PLUGINS].sort());
    expect(out).not.toContain('ghost_tool');
    expect(out).not.toContain('*');
  });

  it('"*" is ignored for any department but praw', () => {
    expect(policy().effective('software', ['*']).sort()).toEqual(['clickup_list_open_tasks', 'fetch_page', 'web_search']);
  });

  it('byDept adds to a head and to its personas; prompt meta cannot grant a plugin', async () => {
    const p = policy(new FakeConfig({ 'tools.byDept': { software: ['clickup_list_open_tasks'] } }));
    expect(p.effective('software', ['respond', 'clickup_create_task']).sort()).toEqual(['clickup_list_open_tasks', 'respond']);
    const org = await seededOrg();
    org.setToolPolicy(p);
    const sa = org.toolsFor({ kind: 'persona', personaId: 'system-analyst' });
    expect(sa).toContain('clickup_list_open_tasks');
    expect(sa).toContain('respond');
    expect(org.toolsFor({ kind: 'head', dept: 'software' })).toContain('clickup_list_open_tasks');
    expect(org.toolsFor({ kind: 'head', dept: 'hq' })).not.toContain('clickup_list_open_tasks');
  });

  it('dedupes', () => {
    const out = policy(new FakeConfig({ 'tools.byDept': { finance: ['web_search', 'web_search'] } })).effective('finance', ['respond', 'respond']);
    expect(out).toEqual(['respond', 'web_search']);
  });

  it('praw gets everything, finance only web_search/fetch_page/extract_receipt', () => {
    const p = policy();
    expect(p.effective('praw', ['*'])).toEqual(expect.arrayContaining([...BUILTIN, ...PLUGINS]));
    expect(p.effective('finance', []).sort()).toEqual(['extract_receipt', 'fetch_page', 'web_search']);
  });

  it('default byDept contains no write or destructive tool name and no glob', () => {
    const WRITE = /(create|update|delete|add|assign|set|remove|write|post|push|merge|close|comment_on)/;
    for (const [dept, names] of Object.entries(CONFIG_DEFAULTS['tools.byDept'])) {
      for (const n of names) {
        expect(n, `${dept}:${n}`).not.toContain('*');
        if (n === 'extract_receipt' || n === 'doc_create' || n === 'diagram_create' || n === 'image_generate' || n === 'video_generate' || n === 'ws_create' || n === 'ws_write' || n === 'ws_delete') continue; // image/video: duty-gated in code, video always asks, image asks unless direct and untrusted-free (RFMD P5)
        // // doc_create: duty-gated in code at every call, money/tax/offer kinds always ask (RFMD P3); diagram_create: named no-approval allowlist (RFMD P4, RF27)
        expect(n, `${dept}:${n}`).not.toMatch(WRITE);
      }
    }
    for (const id of ['hq', 'rnd', 'software', 'it', 'marketing', 'sales', 'hr', 'finance', 'ops', 'praw'])
      expect(CONFIG_DEFAULTS['tools.byDept'][id]).toEqual(expect.arrayContaining(['web_search', 'fetch_page']));
  });
});

describe('registry', () => {
  it('head without byDept entry denied clickup_create_task', async () => {
    const reg = new ToolRegistry({ halt: { isHalted: () => false } });
    for (const t of builtinTools()) reg.register(t);
    const write: ToolPlugin<{ n: number }> = { name: 'clickup_create_task', description: 'w', inputSchema: z.object({ n: z.number() }), requiresApproval: () => false, run: async () => ({ content: 'ran' }) };
    reg.register(write);
    const org = await seededOrg();
    org.setToolPolicy(createToolPolicy(new FakeConfig(), () => reg.names(), () => builtinTools().map((t) => t.name)));
    const tasks = new MemTasks();
    const spy = auditSpy();
    const c: ToolContext = {
      actor: CTO, task: null, ...runCtxBase(), org, tasks, approvals: { needsApproval: () => false, request: async () => ({}) as never },
      limits: new Limits(new FakeConfig(), tasks), bus: newBus(), notes: new MemNotes(), audit: spy.audit,
    };
    const res = await reg.run('clickup_create_task', { n: 1 }, c);
    expect(res).toMatchObject({ isError: true });
    expect(res.content).toMatch(/not allowed/);
    expect(spy.entries.at(-1)).toMatchObject({ tool: 'clickup_create_task', outcome: 'denied' });
  });
});

describe('unknownPromptTools', () => {
  const doc = (tools: string[]): PromptDoc => ({ ref: 'x', meta: { name: 'x', role: 'r', dept: 'hq', tools, traits: ['a'], fragments: [] }, body: '' });
  it('reports non-"*" names missing from the registry, sorted and deduped', () => {
    const m = new Map([['a', doc(['respond', 'web_serach', '*'])], ['b', doc(['web_serach', 'zzz'])]]);
    expect(unknownPromptTools(m, ['respond'])).toEqual(['web_serach', 'zzz']);
    expect(unknownPromptTools(new Map([['a', doc(['*', 'respond'])]]), ['respond'])).toEqual([]);
  });
});

describe('org', () => {
  it('toolsFor(praw) includes create_task, update_task, respond', async () => {
    const org = await seededOrg();
    org.setToolPolicy(policy());
    const t = org.toolsFor({ kind: 'head', dept: 'praw' });
    expect(t).toEqual(expect.arrayContaining(['create_task', 'update_task', 'respond']));
  });
});

describe('policy: skill tools (SK8)', () => {
  const kinds: Record<string, 'read' | 'write'> = { clickup_create_task: 'write', web_search: 'read', clickup_update_task: 'write', github_create_branch: 'write' };
  const reg = [...BUILTIN, ...PLUGINS, 'clickup_update_task', 'github_create_branch', 'discord_read'];
  const withSkills = (cfg = new FakeConfig(), registered = reg) => createToolPolicy(cfg, () => registered, () => BUILTIN, (n) => (n === 'discord_read' ? 'read' : kinds[n]));

  it('the third parameter adds dept-skill and persona-skill tools that pass G', () => {
    const p = withSkills();
    const base = p.effective('marketing', ['respond']);
    expect(p.effective('marketing', ['respond'], ['clickup_create_task', 'clickup_update_task']).sort()).toEqual([...base, 'clickup_create_task', 'clickup_update_task'].sort());
  });

  it('a name that fails G in the stored version is dropped at run time', () => {
    const p = withSkills();
    const out = p.effective('marketing', ['respond'], ['github_create_branch', 'discord_read', 'create_task', 'ghost', 'clickup_create_task']);
    expect(out.sort()).toEqual([...p.effective('marketing', ['respond']), 'clickup_create_task'].sort());
  });

  it('without a kindOf the policy never adds a skill tool (fail closed)', () => {
    expect(policy().effective('marketing', ['respond'], ['clickup_create_task'])).toEqual(policy().effective('marketing', ['respond']));
  });

  it('skill tools do not change the existing result for the same department and are deduped with byDept', () => {
    const p = withSkills(new FakeConfig({ 'tools.byDept': { marketing: ['clickup_create_task'] } }));
    expect(p.effective('marketing', ['respond'], ['clickup_create_task']).filter((n) => n === 'clickup_create_task')).toHaveLength(1);
  });
});

describe('CLICKUP-HIER-1 (CH-C8): the create tools reach Praw by "*" and no default head', () => {
  const HIER = ['clickup_create_space', 'clickup_create_folder', 'clickup_create_list'];
  it('the three names appear for praw and for no department in the default tools.byDept', () => {
    const registered = [...BUILTIN, ...PLUGINS, ...HIER];
    const p = policy(new FakeConfig(), registered);
    for (const n of HIER) expect(p.effective('praw', ['*'])).toContain(n);
    const byDept = CONFIG_DEFAULTS['tools.byDept'] as Record<string, string[]>;
    for (const dept of Object.keys(byDept)) for (const n of HIER) {
      expect(byDept[dept], `${dept} ${n}`).not.toContain(n);
      if (dept !== 'praw') expect(p.effective(dept, ['*', n]), `${dept} ${n}`).not.toContain(n);
    }
  });
});

