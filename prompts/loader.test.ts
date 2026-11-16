import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEPT_IDS } from '../core/index.js';
import { PROMPTS_DIR, loadPrompts } from './index.js';

const fmDir = (file: string, tools: string, extra = '') => {
  const dir = mkdtempSync(join(tmpdir(), 'prompts-'));
  mkdirSync(join(dir, 'heads'));
  writeFileSync(join(dir, 'heads', file), `---\nname: X\nrole: r\ndept: ${file.replace('.md', '')}\ntools: ${tools}\ntraits: [a]\n${extra}---\nbody`);
  return dir;
};

const HEADS = [...DEPT_IDS];
const MEMBERS: Record<string, string> = {
  'ceo-business-advisor': 'hq',
  'legal-and-contracts': 'hq',
  'research-scientist': 'rnd',
  'innovation-brainstorm': 'rnd',
  'system-analyst': 'software',
  'ux-ui-consultant': 'software',
  'pair-programmer': 'software',
  'code-reviewer-qa': 'software',
  'project-manager': 'software',
  'project-admin': 'software',
};
const TOOLS = ['create_task', 'update_task', 'respond', 'kb_search', 'knowledge_propose', 'prompt_propose', 'skill_propose', 'tool_request', 'tool_idea', 'project_task']; // heads (AUTO-1: project_task after tool_idea; the CEO alone also has project_propose); the knowledge tools are core builtins (self-knowledge)

describe('loader', () => {
  it('tools ["*"] and plain names load; unknown pattern (spaces, caps) rejected', () => {
    expect(loadPrompts(fmDir('praw.md', '["*"]')).get('heads/praw')!.meta.tools).toEqual(['*']);
    expect(loadPrompts(fmDir('hq.md', '[web_search, respond]')).get('heads/hq')!.meta.tools).toEqual(['web_search', 'respond']);
    expect(() => loadPrompts(fmDir('hq.md', '[Bad Name]'))).toThrow(/heads\/hq/);
    expect(() => loadPrompts(fmDir('hq.md', '[BadName]'))).toThrow(/heads\/hq/);
  });
  it('tools:["*"] outside heads/praw.md rejected', () => {
    expect(() => loadPrompts(fmDir('hq.md', '["*"]'))).toThrow(/heads\/hq.*\*/);
  });
  it('unquoted-alias frontmatter yields a clear error', () => {
    expect(() => loadPrompts(fmDir('praw.md', '[*]'))).toThrow(/heads\/praw.*quote/i);
  });
  it('accepts a hex color', () => {
    expect(loadPrompts(fmDir('praw.md', '["*"]', 'color: "#F48FB1"\n')).get('heads/praw')!.meta.color).toBe('#F48FB1');
  });
});

describe('loadPrompts', () => {
  const docs = loadPrompts(PROMPTS_DIR);

  it('every head and member file parses with required meta', () => {
    expect(HEADS).toHaveLength(10);
    for (const d of HEADS) {
      const doc = docs.get(`heads/${d}`);
      expect(doc, `heads/${d}`).toBeDefined();
      expect(doc!.meta.dept).toBe(d);
      expect(doc!.meta.effort).toBe('medium');
      expect(doc!.meta.tools).toEqual(d === 'praw' ? ['*'] : d === 'hq' ? [...TOOLS.slice(0, 3), 'warroom_say', 'forward_to', 'ask_requester', 'answer_subtask', 'resolve_blocked', 'meeting_start', ...TOOLS.slice(3), 'project_propose'] : [...TOOLS.slice(0, 3), 'warroom_say', 'forward_to', 'ask_requester', 'answer_subtask', 'resolve_blocked', ...TOOLS.slice(3), ...(d === 'software' ? ['release_request'] : [])]); // R5: only the software head also requests releases; every head asks in the warroom (F2); the CEO alone calls meetings (TW13); HEAL-1: every head may resolve a blocked task it decides about
      expect(doc!.meta.traits.length).toBeGreaterThan(1);
      expect(doc!.body.length).toBeGreaterThan(200);
    }
    for (const [id, dept] of Object.entries(MEMBERS)) {
      const doc = docs.get(`members/${id}`);
      expect(doc, `members/${id}`).toBeDefined();
      expect(doc!.meta.dept).toBe(dept);
      expect(doc!.meta.effort).toBe('low');
      expect(doc!.meta.tools).toEqual(['update_task', 'respond', 'ask_requester']); // ASKBACK-1: members ask their requester, they are never asked
      expect(doc!.meta.traits.length).toBeGreaterThan(1);
    }
  });

  it('loads system prompts and fragments, and fragment references resolve', () => {
    for (const s of ['charter', 'safety', 'tool-use', 'output', 'language']) expect(docs.has(`system/${s}`)).toBe(true);
    for (const f of ['delegation', 'approval-request', 'report-format', 'asking', 'healing']) expect(docs.has(`fragments/${f}`)).toBe(true);
    for (const doc of docs.values()) for (const f of doc.meta.fragments) expect(docs.has(`fragments/${f}`)).toBe(true);
  });

  it('safety and output prompts carry the required rules', () => {
    const safety = docs.get('system/safety')!.body;
    expect(safety).toMatch(/untrusted/);
    expect(safety).toMatch(/@everyone/);
    expect(docs.get('system/output')!.body).toMatch(/respond/);
  });

  it('rejects invalid dept and unknown tools', () => {
    const dir = mkdtempSync(join(tmpdir(), 'prompts-'));
    mkdirSync(join(dir, 'heads'));
    const fm = (dept: string, tools: string) =>
      `---\nname: X\nrole: r\ndept: ${dept}\ntools: [${tools}]\ntraits: [a]\n---\nbody`;
    writeFileSync(join(dir, 'heads', 'bad.md'), fm('nope', 'respond'));
    expect(() => loadPrompts(dir)).toThrow(/heads\/bad/);
    writeFileSync(join(dir, 'heads', 'bad.md'), fm('hq', 'Rm Rf'));
    expect(() => loadPrompts(dir)).toThrow(/heads\/bad/);
  });

  it('heads never reference personas of another department', () => {
    for (const [ref, head] of docs) {
      if (!ref.startsWith('heads/')) continue;
      for (const [mref, m] of docs) {
        if (!mref.startsWith('members/') || m.meta.dept === head.meta.dept) continue;
        const id = mref.slice('members/'.length);
        expect(head.body, `${ref} mentions ${id}`).not.toContain(id);
        expect(head.body, `${ref} mentions ${m.meta.name}`).not.toContain(m.meta.name);
      }
      if (head.meta.dept !== 'hq') expect(head.body, ref).not.toMatch(/legal member/i);
    }
  });

  it('report-format tells where memory bullets go', () => {
    const body = docs.get('fragments/report-format')!.body;
    expect(body).toContain('update_task.notes');
    expect(body).toMatch(/summary/);
  });
});

describe('WS-P1: software workspace guide', () => {
  const prompts = loadPrompts(PROMPTS_DIR);
  it('the software head body has the fixed ws guide, and the frontmatter tools list has no ws_ tool', () => {
    const d = prompts.get('heads/software')!;
    expect(d.body).toContain('## Project workspaces (ws_* tools)');
    for (const t of ['ws_create', 'ws_write', 'ws_run', 'ws_export']) expect(d.body).toContain(t);
    expect(d.body).toMatch(/Never claim a test or build passed without the `ws_run` result/);
    expect(d.body).toMatch(/Real Chrome testing is not available/);
    expect(d.body).toMatch(/GitHub tools, with approval/);
    expect(d.meta.tools.some((t) => t.startsWith('ws_'))).toBe(false);
  });
  it('every software member prompt names the ws tools', () => {
    for (const [id, dept] of Object.entries(MEMBERS)) if (dept === 'software') {
      const d = prompts.get(`members/${id}`)!;
      expect(d.body, id).toContain('ws_list, ws_read, ws_write, ws_delete, ws_run and ws_export');
      expect(d.meta.tools.some((t) => t.startsWith('ws_')), id).toBe(false);
    }
  });
});
