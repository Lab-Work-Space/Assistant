import { describe, expect, it } from 'vitest';
import type { ActorRef } from '../../company/types.js';
import { PRAW_DEFAULT_MODEL } from '../../company/seed.js';
import { Budget } from '../../governance/budget.js';
import { Halt } from '../../governance/halt.js';
import { FakeConfig } from '../../governance/test-helpers.js';
import { FakeProvider, ProviderRegistry, type ChatChunk, type ChatRequest, type LLMProvider } from '../../providers/index.js';
import { ScriptedBudget } from '../loop/loop-fixture.js';
import { createMeteredModel } from './metered.js';
import { auditSpy, newBus } from '../test-helpers.js';

const PRAW: ActorRef = { kind: 'head', dept: 'praw' };
const media = { role: 'user' as const, content: [{ type: 'media' as const, mimeType: 'image/png', data: 'iVBORw0KGgo=' }, { type: 'text' as const, text: 'Read the text.' }] };

function rig(o: { provider?: LLMProvider; cfg?: FakeConfig; noGemini?: boolean } = {}) {
  const cfg = o.cfg ?? new FakeConfig();
  const bus = newBus();
  const events: string[] = [];
  const budget = new (class extends ScriptedBudget {
    override async reserve(r: Parameters<ScriptedBudget['reserve']>[0]) {
      events.push('reserve');
      return super.reserve(r);
    }
    override async settle(id: string, usd: number) {
      events.push('settle');
      return super.settle(id, usd);
    }
  })(new Budget(null as never, cfg, bus));
  const fake = new FakeProvider(Array.from({ length: 8 }, () => ({ text: 'ใบเสร็จ', usage: { inputTokens: 1200, outputTokens: 40 } })), 'gemini');
  const inner = o.provider ?? fake;
  const provider: LLMProvider = {
    id: inner.id,
    async *chat(req: ChatRequest, signal: AbortSignal): AsyncIterable<ChatChunk> {
      events.push('chat');
      yield* inner.chat(req, signal);
    },
  };
  const providers = new ProviderRegistry();
  if (!o.noGemini) providers.register(provider);
  providers.register(new FakeProvider([], 'claude'));
  const spy = auditSpy();
  const halt = new Halt(cfg, { listByStatus: async () => [], update: async () => null }, bus);
  const metered = createMeteredModel({ providers, cfg, budget, audit: spy.audit, halt });
  return { metered, budget, events, spy, halt, fake };
}

describe('metered', () => {
  it('SPEND-1 C: a named tool rides to the reserve as attribution; with no tool nothing is added', async () => {
    const t = rig();
    await t.metered.call({ actor: PRAW, task: null, system: 's', messages: [media], maxTokens: 64, tool: 'ocr' });
    await t.metered.call({ actor: PRAW, task: null, system: 's', messages: [media], maxTokens: 64 });
    expect(t.budget.reserves[0]).toMatchObject({ attribution: { provider: 'gemini', model: PRAW_DEFAULT_MODEL, tool: 'ocr' } });
    expect(t.budget.reserves[1]).not.toHaveProperty('attribution');
  });

  it('OCR, receipt, STT and vision calls all reserve before the call and settle after', async () => {
    const t = rig();
    for (const kind of ['ocr', 'receipt', 'stt', 'vision']) {
      t.events.length = 0;
      const r = await t.metered.call({ actor: PRAW, task: null, system: `${kind} system`, messages: [media], maxTokens: 1024 });
      expect(r.text).toBe('ใบเสร็จ');
      expect(r.costUsd).toBeGreaterThan(0);
      expect(t.events, kind).toEqual(['reserve', 'chat', 'settle']);
    }
    expect(t.budget.reserves.every((r) => r.provider === 'gemini' && r.model === PRAW_DEFAULT_MODEL && r.actor === PRAW)).toBe(true);
    // PF21: always gemini with PRAW_DEFAULT_MODEL, and the request never carries tools (D16)
    expect(t.fake.calls.every((c) => c.model === PRAW_DEFAULT_MODEL && c.tools.length === 0)).toBe(true);
    expect(t.spy.entries.filter((e) => e.action === 'llm.call')).toHaveLength(4);
  });

  it('refused (no provider call) once the bot daily budget is used up, and when the model has no price', async () => {
    const t = rig();
    t.budget.next = async () => ({ ok: false, scope: 'bot' });
    await expect(t.metered.call({ actor: PRAW, task: null, system: 's', messages: [media], maxTokens: 1024 })).rejects.toThrow(/bot daily budget is used up/);
    expect(t.events).toEqual(['reserve']);

    const p = rig({ cfg: new FakeConfig({ pricing: {} }) });
    await expect(p.metered.call({ actor: PRAW, task: null, system: 's', messages: [media], maxTokens: 1024 })).rejects.toThrow(/no price/);
    expect(p.events).toEqual([]);
    expect(p.spy.entries).toContainEqual(expect.objectContaining({ action: 'budget.reserve', outcome: 'refused:price' }));

    const down = rig();
    down.budget.next = async () => { throw new Error('db down'); };
    await expect(down.metered.call({ actor: PRAW, task: null, system: 's', messages: [media], maxTokens: 1024 })).rejects.toThrow(/meter is unavailable/);
    expect(down.events).toEqual(['reserve']);
  });

  it('refuses clearly when gemini is not registered (PF21)', async () => {
    const t = rig({ noGemini: true });
    await expect(t.metered.call({ actor: PRAW, task: null, system: 's', messages: [media], maxTokens: 1024 })).rejects.toThrow(/Gemini is not available/);
    expect(t.budget.reserves).toHaveLength(0);
  });

  it('halt aborts an in-flight OCR call within 2000 ms', async () => {
    const hanging: LLMProvider = {
      id: 'gemini',
      async *chat(_req, signal) {
        await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
        yield { type: 'stop', reason: 'aborted' };
      },
    };
    const t = rig({ provider: hanging });
    const started = Date.now();
    const p = t.metered.call({ actor: PRAW, task: null, system: 's', messages: [media], maxTokens: 1024 });
    setTimeout(() => void t.halt.halt('test'), 50);
    await expect(p).rejects.toThrow(/halted/i);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(t.budget.released).toHaveLength(1); // no usage arrived: the hold is released
    expect(t.spy.entries).toContainEqual(expect.objectContaining({ action: 'llm.call', outcome: 'aborted' }));
    // halted already: nothing is reserved
    await expect(t.metered.call({ actor: PRAW, task: null, system: 's', messages: [media], maxTokens: 1024 })).rejects.toThrow(/halted/i);
    expect(t.budget.reserves).toHaveLength(1);
  });
});
