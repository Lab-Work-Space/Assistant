import type { ConfigStore } from '../config/store.js';
import { PROVIDER_ID as LOCAL_PROVIDER_ID, toLocalModel } from './claude-code-local/protocol.js';
import type { LLMProvider } from './types.js';

export type ProviderSel = { provider?: string; model?: string };


export class ProviderRegistry {
  private readonly providers = new Map<string, LLMProvider>();

  /**
   * R8 PV-C01: `defaultUsable` answers whether `provider.default` is backed by a valid stored row. The app passes it in local mode only, so a
   * missing or invalid row never lets the code default (`claude`, metered) serve main work there: a selection that needs the default throws,
   * which every caller already treats as "provider not available" (idle plus incident). Absent (the VPS, tests): no check.
   */
  constructor(private readonly opts: { defaultUsable?: () => boolean } = {}) {}

  register(p: LLMProvider): void {
    this.providers.set(p.id, p);
  }

  has(id: string): boolean {
    return this.providers.has(id);
  }

  get(id: string): LLMProvider {
    const p = this.providers.get(id);
    if (!p) throw new Error(`unknown provider: ${id}`);
    return p;
  }

  /** Order: persona/head override -> department -> `provider.default`. The first level that sets anything wins; gaps fall back to the default. */
  resolve(
    sel: { actor?: ProviderSel; dept?: ProviderSel },
    cfg: Pick<ConfigStore, 'get'>,
  ): { provider: LLMProvider; model: string } {
    const def = cfg.get('provider.default');
    const level = [sel.actor, sel.dept].find((s) => s && (s.provider || s.model));
    if ((!level?.provider || !level.model) && this.opts.defaultUsable && !this.opts.defaultUsable()) throw new Error('provider.default is not set to a valid value');
    const provider = this.get(level?.provider ?? def.provider);
    const model = level?.model ?? def.model;
    // Selection in local mode (R-L1, Gate 1 L7): API model names map to the local ids only for the local provider, so a
    // local id never reaches another provider's price lookup and an unknown name is refused by the provider.
    return { provider, model: provider.id === LOCAL_PROVIDER_ID ? toLocalModel(model) : model };
  }
}
