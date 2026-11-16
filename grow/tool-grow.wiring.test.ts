import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = (f: string) => readFileSync(join(ROOT, f), 'utf8');

describe('GROW-1 tool_request / tool_idea wiring (grep)', () => {
  const app = src('app.ts');
  it('both names are core builtins (builtinNames) and register through growTools, not builtinTools()', () => {
    expect(app).toMatch(/const builtinNames = \[[^\]]*\.\.\.GROW_TOOL_NAMES\]/);
    expect(app).toContain('for (const t of growTools({ requests: toolRequests, ideas: toolIdeas })) tools.register(t);');
    expect(src('tools/builtin/index.ts')).not.toMatch(/\[createTask[^\]]*(toolRequest|toolIdea|growTools)/);
  });
  it('the 60 s sweep runs from app.ts, once at boot after recovery, and stops on shutdown', () => {
    expect(app).toContain('toolRequests.recover().then(() => toolRequests.sweep())');
    expect(app).toMatch(/toolReqSweep = setInterval\(\(\) => void toolRequests\.sweep\(\), 60_000\)/);
    expect(app).toContain('if (toolReqSweep) clearInterval(toolReqSweep);');
  });
  it('the head notice goes through Scheduler.notifyHead; the grow services reach the commands', () => {
    expect(app).toContain('notifyHead: (dept, text) => scheduler.notifyHead(dept, text)');
    expect(app).toContain('grow: { requests: toolRequests, ideas: toolIdeas },');
  });
  it('the nine heads (not praw) list both tools right after skill_propose, then project_task (the CEO also project_propose)', () => {
    for (const h of ['hq', 'software', 'rnd', 'it', 'ops', 'sales', 'hr', 'finance', 'marketing']) expect(src(`prompts/heads/${h}.md`)).toMatch(/skill_propose, tool_request, tool_idea, project_task(, project_propose|, release_request)?\]/);
    expect(src('prompts/heads/praw.md')).not.toMatch(/tool_request|tool_idea/);
  });
  it('GW-C24 (allowlist, global rule 6): only the repo, the idea service, the tool plugin, the /tool command and the app wiring name tool_ideas or its readers', () => {
    const SKIP = new Set(['node_modules', 'dist', '.git', 'docs', 'vendor', 'data', 'scratchpad']);
    const ALLOWED = new Set(['db/repos/grow.ts', 'db/repos/index.ts', 'db/migrations/039_grow.up.sql', 'db/migrations/039_grow.down.sql', 'grow/tool-ideas.ts', 'tools/builtin/grow.ts', 'discord/commands/tool.ts', 'discord/commands/types.ts', 'app.ts',
      // R7 PLUGIN-FORGE (its own Gate 1: docs/security/2026-11-13-gate1-forge.md): the forge row references an idea, and its repo closes it when the plugin is installed (compare-and-set on status open). The helper file is a test fixture.
      'db/migrations/048_forge.up.sql', 'db/repos/forge.ts', 'db/repos/forge-test-helpers.ts',
      // R7 (spec 5.2): ProjectRepo.create locks the linked idea FOR UPDATE and requires status open and tainted false in the project's own transaction (GW-C24: a tainted idea is refused, `idea_invalid`).
      'db/repos/projects.ts']);
    const hits: string[] = [];
    const walk = (dir: string): void => {
      for (const e of readdirSync(dir)) {
        if (SKIP.has(e)) continue;
        const p = join(dir, e);
        if (statSync(p).isDirectory()) walk(p);
        else if ((e.endsWith('.ts') && !/\.test\.ts$/.test(e)) || e.endsWith('.sql')) {
          if (/tool_ideas|ToolIdea(Repo|Service|Row)|ideas\.(list|listOpen)\(/.test(readFileSync(p, 'utf8'))) hits.push(relative(ROOT, p));
        }
      }
    };
    walk(ROOT);
    expect(hits.length).toBeGreaterThan(0); // positive control: the repo itself is found
    expect(hits.filter((h) => !ALLOWED.has(h))).toEqual([]);
  });
  it('toolreq: is routed only in route(), never in the pre-check branches of decide()', () => {
    const idx = src('discord/commands/index.ts');
    const decide = idx.slice(idx.indexOf('async function decide('), idx.indexOf('export async function handleInteraction'));
    expect(decide).not.toContain('toolreq');
    expect(idx.slice(idx.indexOf('function route('), idx.indexOf('/** Guard order'))).toContain("startsWith('toolreq:') ? toolRequestButton");
  });
});
