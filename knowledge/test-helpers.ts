import { FakeConfig } from '../governance/test-helpers.js';
import { ProviderRegistry, type LLMProvider } from '../providers/index.js';
import type { SmallDeps } from './small.js';

/** A SmallDeps over fake providers and a counting budget, for the tests of the classifier, reflect and the weekly review. */
export function smallRig(providers: LLMProvider[], over: Partial<SmallDeps> = {}, cost = 0.001) {
  const reg = new ProviderRegistry();
  for (const p of providers) reg.register(p);
  const log = { reserved: 0, settled: 0, released: 0, reqs: [] as unknown[] };
  const budget = {
    reserve: async (r: unknown) => (log.reserved++, log.reqs.push(r), { ok: true as const, reservationId: 'r' }),
    settle: async () => void log.settled++, release: async () => void log.released++, costOf: () => cost,
  };
  const d: SmallDeps = { providers: reg, cfg: new FakeConfig() as never, call: { budget: budget as never, halt: { track: () => () => undefined }, audit: async () => undefined }, ...over };
  return { d, log };
}
