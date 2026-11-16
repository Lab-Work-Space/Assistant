import { vi } from 'vitest';
import { FakeConfig } from '../../../governance/test-helpers.js';
import { createHttpClient } from '../../../services/http.js';
import { workspaceFetch, ws, type WsState, type WsTeam } from '../../../tests/fakes/clickup-workspace.js';
import type { PluginDeps } from '../deps.js';
import { createClickUpClient, type TeamsEvent } from './client.js';
import { clickupGroup } from './index.js';

/** CLICKUP-MULTI-1 test rig: the REAL client in all-workspaces mode against the multi-team fake. */
export const B = 'https://api.clickup.com/api/v2';
export const TEAM_A = '9001'; // the main workspace of the fake, named "Core"
export const TEAM_B = '9002'; // "Acme": space 601, list 8001 "Roadmap", task b1

export const teamB = (over: Partial<WsTeam> = {}): WsTeam => ({
  id: TEAM_B, name: 'Acme', spaces: [{ id: '601', name: 'Ops' }],
  lists: [{ id: '8001', name: 'Roadmap', spaceId: '601', statuses: ['to do', 'done'] }],
  tasks: [{ id: 'b1', name: 'Plan Q1', listId: '8001', spaceId: '601', status: { status: 'to do', type: 'open' }, assignees: [], date_updated: '1500' }],
  ...over,
});
/** `n` workspaces in all: Core (9001) plus n-1 generated ones (ids 9100+i, one space and one list each). */
export const teamsOf = (n: number): WsTeam[] =>
  Array.from({ length: n - 1 }, (_, i) => ({
    id: `${9100 + i}`, name: `Team ${String(i).padStart(2, '0')}`, spaces: [{ id: `${7100 + i}`, name: `Space ${i}` }],
    lists: [{ id: `l${9100 + i}`, name: `List ${i}`, spaceId: `${7100 + i}`, statuses: ['to do', 'done'] }],
    tasks: [{ id: `k${9100 + i}`, name: `Task ${i}`, listId: `l${9100 + i}`, spaceId: `${7100 + i}`, status: { status: 'to do', type: 'open' }, assignees: [], date_updated: String(2000 + i) }],
  }));

export function allRig(over: Partial<WsState> = {}, o: { now?: () => number; sleep?: (ms: number) => Promise<void>; usage?: unknown } = {}) {
  const state = ws({ teamName: 'Core', more: [teamB()], ...over });
  const f = workspaceFetch(state);
  const events: TeamsEvent[] = [];
  const log = { warn: vi.fn() };
  const client = createClickUpClient({
    http: createHttpClient({ fetch: f }), token: state.token, allTeams: true, log, onTeamsEvent: (e) => void events.push(e),
    ...(o.now ? { now: o.now } : {}), ...(o.sleep ? { sleep: o.sleep } : {}),
  });
  const g = clickupGroup({ clickup: client, cfg: new FakeConfig(), ...(o.usage ? { clickupUsage: o.usage } : {}), log: { warn: vi.fn() }, clock: () => Date.parse('2026-11-08T05:00:00Z') } as unknown as PluginDeps);
  if ('disabled' in g) throw new Error(g.disabled);
  return { state, f, client, g, events, log };
}
export const paths = (f: { requests: { method: string; url: string }[] }) => f.requests.map((r) => `${r.method} ${r.url.replace(B, '').split('?')[0]}`);
export const bare = (s: string) => s.replace(/<\/?untrusted-[0-9a-f]+[^>]*>/g, '').trim();
