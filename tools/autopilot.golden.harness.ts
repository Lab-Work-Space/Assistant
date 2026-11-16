import { vi } from 'vitest';
import { seededOrg } from '../agents/test-helpers.js';
import { FakeConfig } from '../governance/test-helpers.js';
import { createHttpClient } from '../services/http.js';
import { fakeResolver, fakeTransport } from '../tests/fakes/net.js';
import { workspaceFetch, ws } from '../tests/fakes/clickup-workspace.js';
import { builtinTools, growTools, knowledgeTools, projectTools, releaseTools, skillTools } from './builtin/index.js';
import { createClickUpClient } from './plugins/clickup/client.js';
import type { PluginDeps } from './plugins/deps.js';
import { pluginGroups, registerGroups } from './plugins/index.js';
import { ToolRegistry } from './registry.js';

/** The real tool set: core builtins, the service tools (stub services: only their declarations matter here), every plugin group that boots without external services, plus the ClickUp workspace group on fakes. */
export async function realRegistry(): Promise<ToolRegistry> {
  const reg = new ToolRegistry({ halt: { isHalted: () => false }, autopilot: true });
  for (const t of builtinTools()) reg.register(t);
  for (const t of [...skillTools({} as never), ...knowledgeTools({} as never), ...growTools({ requests: {} as never, ideas: {} as never }), ...projectTools({ projects: {} as never }), ...releaseTools({ releases: {} as never })]) reg.register(t);
  const cu = createClickUpClient({ http: createHttpClient({ fetch: workspaceFetch(ws()) }), token: ws().token, teamId: '9001' });
  const deps = {
    cfg: new FakeConfig({ 'ws.enabled': true }), env: {}, log: { warn: vi.fn() }, workspaceRoot: '/nonexistent/praw-ws', metered: { call: vi.fn() }, net: { resolver: fakeResolver({}), transport: fakeTransport({}) },
    clickup: cu, clickupUsage: { take: async () => true }, clock: () => Date.now(), renderer: {}, docsDir: '/nonexistent/docs',
    reminders: {}, jobs: {}, watches: {}, lessons: {}, org: await seededOrg(), music: {}, mediaGen: {}, github: {}, ws: {}, halt: { track: (p: Promise<unknown>) => p, isHalted: () => false },
  } as unknown as PluginDeps;
  registerGroups(reg, pluginGroups, deps);
  return reg;
}
