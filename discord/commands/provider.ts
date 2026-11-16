import { encryptSecret } from '../../config/secrets.js';
import { applyPlan, isError, planProviderDefault, refusal } from './plans.js';
import { configReply, ephemeral, type Handler } from './types.js';

const PROVIDER_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
export const PROVIDER_MODAL = 'provider-add:';
const KEY_MAX = 512;

/** Opens the key modal; the key is typed into Discord's modal only, never into a command option. */
export const providerAdd: Handler = async (i) => {
  const id = i.options.string('id') ?? '';
  if (!PROVIDER_ID.test(id)) return ephemeral('Provider id must be 1-32 chars of a-z, 0-9 and -.');
  return {
    modal: {
      customId: `${PROVIDER_MODAL}${id}`,
      title: `API key for ${id}`,
      inputs: [{ id: 'key', label: 'API key', style: 'short', required: true, minLength: 8, maxLength: KEY_MAX }],
    },
  };
};

/** Gate 1 D12: encrypt with AAD = provider id; the value is never logged, audited or echoed. */
export const providerModalSubmit: Handler = async (i, deps) => {
  const id = i.customId.slice(PROVIDER_MODAL.length);
  if (!PROVIDER_ID.test(id)) return ephemeral('Invalid provider id.');
  const key = i.field('key');
  if (!key || key.length > KEY_MAX) return ephemeral('Invalid key.');
  const enc = encryptSecret(key.trim(), deps.masterKey, id);
  await deps.repos.providerKeys.upsert({ provider: id, ...enc });
  await deps.audit({ actor: `user:${i.userId}`, action: 'provider.add', provider: id, outcome: 'ok' });
  // Providers are built once at boot, so a stored gemini key only takes effect after a restart (R15).
  const note = id === 'gemini' ? ' Restart the bot to apply it.' : '';
  return configReply('Provider key stored', `Key for **${id}** saved encrypted.${note}`, { ephemeral: true });
};

export const providerDefault: Handler = async (i, deps) => {
  const plan = planProviderDefault(i.options.string('id') ?? '', i.options.string('model') ?? '', deps);
  return isError(plan) ? refusal(plan) : applyPlan(plan, i.userId, deps, i.userId);
};
