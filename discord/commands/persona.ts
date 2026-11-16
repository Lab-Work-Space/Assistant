import type { Persona } from '../../db/repos/index.js';
import type { PromptDoc } from '../../prompts/index.js';
import { DEPT_IDS, type DeptId } from '../../core/index.js';
import { applyPlan, isError, PERSONA_BODY_MAX, planPersonaEdit, refusal } from './plans.js';
import { changeReply, configReply, ephemeral, type CommandDeps, type Handler } from './types.js';

export const PERSONA_MODAL = 'persona-edit:';
const NAME_MAX = 80;
const BODY_MAX = PERSONA_BODY_MAX;
const SLUG = /^[a-z0-9][a-z0-9-]{0,39}$/;

/** Rejects mass-mention and mention markup in names (Gate 1 D11). */
export function validName(name: string): boolean {
  const n = name.trim();
  return n.length > 0 && n.length <= NAME_MAX && !/@everyone|@here|<@/i.test(n) && !/[\r\n]/.test(n);
}

export function validAvatar(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && url.length <= 512;
  } catch {
    return false;
  }
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);

/** Template for a new persona's prompt: a sibling member prompt of the same department, else a generic one. */
function templateFor(dept: DeptId, deps: CommandDeps): PromptDoc | null {
  for (const p of deps.org.personasOf(dept)) {
    const d = deps.prompts.get(p.promptRef);
    if (d) return d;
  }
  return null;
}

const baseDoc = (ref: string, name: string, dept: DeptId, tpl: PromptDoc | null, body?: string): PromptDoc => ({
  ref,
  meta: { ...(tpl?.meta ?? { tools: ['respond'], traits: ['helpful'], fragments: [], role: 'Team member' }), name, dept },
  body: body ?? tpl?.body ?? `You are ${name}, a member of the ${dept} department. Help the department head and be concise.`,
});

/**
 * Boot helper: custom personas (not in the prompt files) get their prompt doc rebuilt from a sibling template;
 * the active override (their body) is applied by resolvePrompt as usual.
 */
export async function restoreCustomPrompts(
  personas: Persona[],
  prompts: Map<string, PromptDoc>,
  siblingOf: (p: Persona) => PromptDoc | null,
): Promise<void> {
  for (const p of personas) {
    if (!prompts.has(p.promptRef)) prompts.set(p.promptRef, baseDoc(p.promptRef, p.name, p.deptId as DeptId, siblingOf(p)));
  }
}

export const personaCreate: Handler = async (i, deps) => {
  const name = (i.options.string('name') ?? '').trim();
  const dept = i.options.string('dept') ?? '';
  const avatar = i.options.string('avatar');
  if (dept === 'praw') return ephemeral('Praw has no personas; it is a single assistant (R21).');
  if (!(DEPT_IDS as readonly string[]).includes(dept) || !deps.org.dept(dept)) return ephemeral('Unknown department.');
  if (!validName(name)) return ephemeral(`Name must be 1-${NAME_MAX} characters without mentions.`);
  if (avatar !== null && !validAvatar(avatar)) return ephemeral('Avatar must be an https URL.');
  const id = slug(name);
  if (!SLUG.test(id)) return ephemeral('Name must contain letters or digits.');
  if (await deps.repos.personas.get(id)) return ephemeral(`A persona with id ${id} already exists.`);
  const ref = `members/${id}`;
  if (deps.prompts.has(ref)) return ephemeral(`A prompt ${ref} already exists.`);
  const tpl = templateFor(dept as DeptId, deps);
  const doc = baseDoc(ref, name, dept as DeptId, tpl);
  await deps.repos.personas.upsert({
    id, deptId: dept, name, avatarUrl: avatar, promptRef: ref, model: null, provider: null,
    tools: [...doc.meta.tools], directChannelId: null, enabled: true,
  });
  try {
    await deps.repos.overrides.upsert(ref, doc.body, i.userId); // persists the body for restarts
  } catch (err) {
    await deps.repos.personas.delete(id); // no persona without its prompt
    throw err;
  }
  deps.prompts.set(ref, doc);
  await deps.org.reload();
  await deps.audit({ actor: `user:${i.userId}`, action: 'persona.create', tool: id, outcome: 'ok' });
  return changeReply('persona', '(none)', `${name} (${dept}, id ${id})`);
};

async function find(i: Parameters<Handler>[0], deps: CommandDeps): Promise<Persona | null> {
  return deps.repos.personas.get(i.options.string('persona') ?? '');
}

export const personaEdit: Handler = async (i, deps) => {
  const p = await find(i, deps);
  if (!p) return ephemeral('Unknown persona.');
  return {
    modal: {
      customId: `${PERSONA_MODAL}${p.id}`,
      title: `Prompt for ${p.name}`.slice(0, 45),
      inputs: [{ id: 'body', label: 'Prompt body', style: 'paragraph', required: true, minLength: 10, maxLength: BODY_MAX }],
    },
  };
};

export const personaModalSubmit: Handler = async (i, deps) => {
  const plan = await planPersonaEdit(i.customId.slice(PERSONA_MODAL.length), i.field('body') ?? '', deps, i.userId);
  return isError(plan) ? refusal(plan) : applyPlan(plan, i.userId, deps);
};

export const personaReset: Handler = async (i, deps) => {
  const p = await find(i, deps);
  if (!p) return ephemeral('Unknown persona.');
  const old = await deps.repos.overrides.getActive(p.promptRef);
  if (!old) return ephemeral('No active override to reset.');
  await deps.repos.overrides.delete(p.promptRef);
  await deps.org.reload();
  await deps.audit({ actor: `user:${i.userId}`, action: 'persona.reset', tool: p.id, outcome: 'ok' });
  return changeReply(`${p.name} prompt`, `override v${old.version}`, 'file default');
};

export const personaDelete: Handler = async (i, deps) => {
  const p = await find(i, deps);
  if (!p) return ephemeral('Unknown persona.');
  // Soft delete: seed re-inserts missing rows at boot, so the row stays, disabled (R27).
  await deps.repos.personas.upsert({ ...p, enabled: false });
  await deps.org.reload();
  await deps.audit({ actor: `user:${i.userId}`, action: 'persona.delete', tool: p.id, outcome: 'ok' });
  return changeReply('persona', `${p.name} (${p.deptId}, enabled)`, 'disabled');
};

export const personaList: Handler = async (_i, deps) => {
  const all = await deps.repos.personas.list();
  return configReply('Personas', `${all.length} personas`, {
    fields: all.slice(0, 25).map((p) => ({ name: `${p.name} (${p.id})`, value: `${p.deptId}${p.enabled ? '' : ' · DISABLED (deleted)'}` })),
  });
};
