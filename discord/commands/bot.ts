import { applyPlan, isError, planBotModel, planBotToggle, planBotTools, refusal } from './plans.js';
import type { Handler } from './types.js';
import { changeReply, configReply, ephemeral } from './types.js';

export { hasPrice, selectionError } from './plans.js';

const HEX = /^#?([0-9a-fA-F]{6})$/;

export const botList: Handler = async (_i, deps) =>
  configReply('Department heads', `${deps.org.heads().length} departments`, {
    fields: deps.org.heads().map((d) => ({
      name: `${d.id} (${d.enabled ? 'enabled' : 'disabled'})`,
      value: `model ${d.model ?? '(default)'} · provider ${d.provider ?? '(default)'} · color #${d.color.toString(16).padStart(6, '0')}`,
    })),
  });

export const botToggle = (enabled: boolean): Handler => async (i, deps) => {
  const p = await planBotToggle(i.options.string('dept') ?? '', enabled, deps);
  return isError(p) ? refusal(p) : applyPlan(p, i.userId, deps);
};

export const botModel: Handler = async (i, deps) => {
  const p = await planBotModel(i.options.string('dept') ?? '', i.options.string('provider') ?? '', i.options.string('model') ?? '', deps);
  return isError(p) ? refusal(p) : applyPlan(p, i.userId, deps);
};

export const botColor: Handler = async (i, deps) => {
  const id = i.options.string('dept') ?? '';
  const m = HEX.exec(i.options.string('hex') ?? '');
  const d = await deps.repos.departments.get(id);
  if (!d) return ephemeral('Unknown department.');
  if (!m) return ephemeral('Color must be a hex value like #3498db.');
  const color = parseInt(m[1]!, 16);
  await deps.repos.departments.upsert({ ...d, color });
  await deps.org.reload();
  await deps.audit({ actor: `user:${i.userId}`, action: 'bot.color', tool: id, outcome: 'ok' });
  const hex = (n: number) => `#${n.toString(16).padStart(6, '0')}`;
  return changeReply(`${id} color`, hex(d.color), hex(color));
};

/** Per-department plugin allowlist (`tools.byDept`). Heads run delegated, so a write tool added here still needs approval. */
export const botTools: Handler = async (i, deps) => {
  const p = planBotTools(i.options.string('dept') ?? '', i.options.string('action') ?? '', i.options.string('tool') ?? '', deps);
  return isError(p) ? refusal(p) : applyPlan(p, i.userId, deps);
};
