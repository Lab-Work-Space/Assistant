import { vi } from 'vitest';
import type { ActorRef } from '../../company/types.js';
import type { Task } from '../../db/repos/tasks.js';
import { Budget, type ReserveRequest, type ReserveResult } from '../../governance/budget.js';
import { Halt } from '../../governance/halt.js';
import { Limits } from '../../governance/limits.js';
import { FakeConfig } from '../../governance/test-helpers.js';
import { FakeProvider, ProviderRegistry, type FakeTurn, type LLMProvider } from '../../providers/index.js';
import { ToolRegistry } from '../../tools/registry.js';
import { builtinTools } from '../../tools/builtin/index.js';
import type { AgentDeps } from './loop.js';
import { TaskRuns } from '../tasks/task-runs.js';
import { MemNotes, MemTasks, auditSpy, newBus, prompts, seededOrg } from '../test-helpers.js';

export const SONNET = 'claude-sonnet-5-5';

/** Budget whose reserve() outcome is scripted; costOf is the real pricing maths. */
export class ScriptedBudget {
  readonly reserves: ReserveRequest[] = [];
  readonly settled: [string, number][] = [];
  readonly released: string[] = [];
  next: () => Promise<ReserveResult> = async () => ({ ok: true, reservationId: `r${this.reserves.length}` });
  constructor(private readonly real: Budget) {}
  costOf(model: string, u: Parameters<Budget['costOf']>[1]) {
    return this.real.costOf(model, u);
  }
  async reserve(r: ReserveRequest) {
    this.reserves.push(r);
    return this.next();
  }
  async settle(id: string, usd: number) {
    this.settled.push([id, usd]);
  }
  async release(id: string) {
    this.released.push(id);
  }
}

export async function setup(opts: { script?: FakeTurn[]; provider?: LLMProvider; prompts?: typeof prompts; turnsPerTask?: number } = {}) {
  const cfg = new FakeConfig(opts.turnsPerTask ? { 'limits.turnsPerTask': opts.turnsPerTask } : {});
  const bus = newBus();
  const tasks = new MemTasks();
  const notes = new MemNotes();
  const spy = auditSpy();
  const provider = opts.provider ?? new FakeProvider(opts.script ?? [], 'claude');
  const providers = new ProviderRegistry();
  providers.register(provider);
  const budget = new ScriptedBudget(new Budget(null as never, cfg, bus));
  const approvals = {
    needsApproval: (est: number) => !Number.isFinite(est) || est > cfg.get('approval.thresholdUsd'),
    request: vi.fn(async (r: { taskId: string }) => {
      await tasks.update(r.taskId, { status: 'awaiting_approval' });
      return { id: 1 } as never;
    }),
    onTreeCapHit: vi.fn(async (r: { taskId?: string }) => {
      await tasks.update(r.taskId!, { status: 'awaiting_approval' });
      return { id: 2 } as never;
    }),
    onLocalCapHit: vi.fn(async (r: { taskId?: string }) => {
      await tasks.update(r.taskId!, { status: 'awaiting_approval' });
      return { id: 3 } as never;
    }),
  };
  const halt = new Halt(cfg, tasks, bus);
  const taskRuns = new TaskRuns();
  const tools = new ToolRegistry({ halt });
  for (const t of builtinTools()) tools.register(t);
  const deps: AgentDeps = {
    org: await seededOrg(opts.prompts ? { prompts: opts.prompts } : {}),
    prompts: opts.prompts ?? prompts,
    overrides: { getActive: async () => null },
    providers, cfg, budget, approvals, tasks, notes, tools, bus, audit: spy.audit,
    limits: new Limits(cfg, tasks),
    halt, taskRuns,
  };
  return { deps, cfg, bus, tasks, notes, spy, provider, budget, approvals, taskRuns };
}

/** Swap in a fresh scripted provider (for scripts that need ids created during setup). */
export function useScript(s: { deps: AgentDeps }, script: FakeTurn[]): FakeProvider {
  const p = new FakeProvider(script, 'claude');
  const reg = new ProviderRegistry();
  reg.register(p);
  s.deps.providers = reg;
  return p;
}

export const route = (actor: ActorRef) => ({ actor, reason: 'mention' as const });
export const respond = (body: string, extra: object = {}) => ({ name: 'respond', input: { type: 'chat', body, ...extra } });
export const owned = (tasks: MemTasks, owner: ActorRef, over: Partial<Task> = {}) =>
  tasks.create({ title: 'Build login', description: 'OAuth login page', deptId: 'software', owner, requester: { kind: 'human', userId: '42' }, origin: 'chat' }).then(async (t) => {
    await tasks.update(t.id, over);
    return (await tasks.get(t.id))!;
  });
