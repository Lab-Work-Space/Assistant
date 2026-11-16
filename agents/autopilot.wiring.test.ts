import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = (p: string): string => readFileSync(join(ROOT, p), 'utf8');
const app = src('app.ts');

describe('AUTO-1 wiring (SA-1 5.4, AP-C3)', () => {
  it('only the main registry is built for the autopilot port; the admin registry is not', () => {
    expect(app).toMatch(/const tools = new ToolRegistry\(\{ halt, incidents, treeGrants: true, autopilot: true, external: \{ get: \(n\) => mcpHost\.get\(n\), names: \(\) => mcpHost\.names\(\) \} \}\)/);
    expect(app).toMatch(/const adminRegistry = new ToolRegistry\(\{ halt, incidents \}\);/);
  });
  it('the agent, the scheduler and tool_request get the project ports; the replay context is async with the project tools', () => {
    expect(app).toContain('autopilot: { projectOf: (id) => autopilot.projectOf(id), toolsFor: (pid, a) => autopilot.toolsFor(pid, a), budgetHit: (t) => projectService.budgetHit(t), decide: (r) => autopilot.decide(r), companyOn: () => autopilot.companyOn(), inCompany: (id) => autopilot.inCompany(id), treeToolsFor: (id, a) => autopilot.treeToolsFor(id, a) }');
    expect(app).toContain('new Scheduler({ autopilot: { projectOf: (id) => autopilot.projectOf(id) },');
    expect(app).toContain('projectGrant: (r) => autopilot.projectGrant(r)');
    expect(app).toContain('context: async (actor, task) => approvedToolContext(actor, task, agent, await autopilot.toolsForTask(task.id, actor).catch(() => []))');
    expect(app).toContain('exhausted: (id) => projectService.exhausted(id)');
  });
  it('the budget claim reads the AI approver\'s heuristics by import, and tool-requests still never imports the approver', () => {
    expect(src('governance/autopilot.ts')).toContain("import { precheckCall } from './ai-approver.js';");
    expect(src('grow/tool-requests.ts')).not.toMatch(/ai-approver|skill-judge/);
  });
  it('the loop strips the port from the approved replay and the registry never decides on the approved path', () => {
    expect(src('agents/loop/loop.ts')).toContain('autopilot: _noAutopilot');
    expect(src('tools/registry.ts')).toContain('(approved || this.opts.autopilot !== true) && ctx.autopilot');
  });
});
