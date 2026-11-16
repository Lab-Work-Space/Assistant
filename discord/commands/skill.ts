import { SKILL_ID_RE, SKILL_INSTRUCTIONS_MAX, SKILL_TITLE_MAX } from '../../skills/limits.js';
import { planSkillAttach, planSkillCreate, planSkillDetach, planSkillEdit, planSkillRollback, planSkillToggle, planSkillTools, parseTarget } from '../../skills/plans.js';
import { renderBlock } from '../../skills/render.js';
import { SkillRefused } from '../../skills/service.js';
import { parseTemplates, templatesToText } from '../../skills/templates.js';
import { refusalText } from '../../skills/validate.js';
import { isError, type Plan } from './plans.js';
import { configReply, ephemeral, type CommandDeps, type Handler, type Reply } from './types.js';

export const SKILL_CREATE_MODAL = 'skill-create:';
export const SKILL_EDIT_MODAL = 'skill-edit:';
/** Templates input: the bodies are capped at 1500 characters in total; the `## name` lines need room on top. */
const TEMPLATES_INPUT_MAX = 1800;
const EDIT_ID = /^skill-edit:([a-z][a-z0-9-]{1,39}):([1-9][0-9]{0,8})$/;

/** SK3: every reply of /skill is ephemeral (the deferral in commands/index.ts is ephemeral too: an editReply cannot make a public deferral private). */
const priv = (title: string, body: string, fields?: { name: string; value: string }[]): Reply => configReply(title, body, { ephemeral: true, ...(fields ? { fields } : {}) });
const NO_SKILLS = ephemeral('Skills are not available in this process.');
const need = (deps: CommandDeps) => deps.skills ?? null;
const by = (userId: string) => `user:${userId}`;
const asDeps = (deps: CommandDeps) => ({ ...(deps.skills ? { skills: deps.skills } : {}), org: deps.org });

/** Runs a plan the slash way: the write is its own transaction with SQL compare-and-swap; a refused or lost check is a fixed-text reply and writes nothing. */
async function runPlan(plan: Plan, title: string): Promise<Reply> {
  if (isError(plan)) return ephemeral(plan.error);
  try {
    await plan.run?.();
  } catch (e) {
    if (e instanceof SkillRefused) return ephemeral(refusalText(e));
    throw e;
  }
  const lines = plan.items.filter((i) => i.plain === undefined).map((i) => `${i.label}: ${i.old} → ${i.neu}`);
  if (plan.risk) lines.push('⚠ This gives an actor more tools. Check them with `/skill show`.');
  return priv(title, lines.join('\n'));
}

const slug = (i: Parameters<Handler>[0]): string | null => {
  const s = (i.options.string('skill') ?? '').trim();
  return SKILL_ID_RE.test(s) ? s : null;
};

export const skillList: Handler = async (i, deps) => {
  const svc = need(deps);
  if (!svc) return NO_SKILLS;
  const targetText = i.options.string('target');
  const t = targetText ? parseTarget(targetText) : null;
  if (targetText && !t) return ephemeral('The target must be dept:<id> or persona:<id>.');
  const [rows, atts] = await Promise.all([svc.repo.list(), svc.repo.attachments()]);
  const where = (id: string) => atts.filter((a) => a.skillId === id).map((a) => `${a.targetKind}:${a.targetId}`);
  const shown = rows.filter((r) => !t || where(r.id).includes(`${t.kind}:${t.id}`));
  if (!shown.length) return priv('Skills', t ? `No skills attached to ${t.kind}:${t.id}.` : 'No skills yet. Create one with /skill create.');
  return priv('Skills', `${shown.length} skill${shown.length === 1 ? '' : 's'}${shown.length > 25 ? ' (first 25 shown)' : ''}`, shown.slice(0, 25).map((r) => ({
    name: `${r.id} v${r.activeVersion}${r.status === 'active' ? '' : ` · ${r.status.toUpperCase()}`}`.slice(0, 256),
    value: `${r.title.slice(0, 100)}\n${where(r.id).join(', ') || '(not attached)'}${r.tools.length ? `\ntools: ${r.tools.join(', ')}` : ''}`.slice(0, 1000),
  })));
};

export const skillShow: Handler = async (i, deps) => {
  const svc = need(deps);
  if (!svc) return NO_SKILLS;
  const id = slug(i);
  const row = id ? await svc.repo.get(id) : null;
  if (!id || !row) return ephemeral('Unknown skill.');
  const wanted = i.options.integer('version');
  const v = wanted === null ? row.activeVersion : wanted;
  const ver = await svc.repo.version(id, v);
  if (!ver) return ephemeral('Unknown version.');
  const atts = (await svc.repo.attachmentsOf(id)).map((a) => `${a.targetKind}:${a.targetId} (priority ${a.priority})`);
  const block = renderBlock({ id, version: v, title: row.title, instructions: ver.instructions, templates: ver.templates });
  return priv(`Skill ${id} v${v}`, block.slice(0, 3900), [
    { name: 'Status', value: `${row.status}, active version v${row.activeVersion}` },
    { name: 'Attached to', value: atts.join('\n').slice(0, 1000) || '(not attached)' },
    { name: 'Tools', value: ver.tools.join(', ') || '(none)' },
    { name: 'Version', value: `${ver.source}${ver.restoredFrom ? ` (restored from v${ver.restoredFrom})` : ''} by ${ver.createdBy.slice(0, 40)}, ${ver.bodyBytes} bytes, sha ${ver.bodySha256.slice(0, 12)}` },
  ]);
};

export const skillCreate: Handler = async (_i, deps) => {
  if (!need(deps)) return NO_SKILLS;
  return {
    modal: {
      customId: SKILL_CREATE_MODAL, title: 'New skill',
      inputs: [
        { id: 'id', label: 'Skill id (lowercase letters, digits, dashes)', style: 'short', required: true, minLength: 2, maxLength: 40 },
        { id: 'title', label: 'Title', style: 'short', required: true, maxLength: SKILL_TITLE_MAX },
        { id: 'instructions', label: 'Instructions', style: 'paragraph', required: true, minLength: 10, maxLength: SKILL_INSTRUCTIONS_MAX },
        { id: 'templates', label: 'Templates (optional): "## name" starts each', style: 'paragraph', required: false, maxLength: TEMPLATES_INPUT_MAX },
      ],
    },
  };
};

export const skillEdit: Handler = async (i, deps) => {
  const svc = need(deps);
  if (!svc) return NO_SKILLS;
  const id = slug(i);
  const row = id ? await svc.repo.get(id) : null;
  if (!id || !row) return ephemeral('Unknown skill.');
  if (row.status === 'archived') return ephemeral(refusalText({ code: 'archived' }));
  const templates = templatesToText(row.templates);
  return {
    modal: {
      customId: `${SKILL_EDIT_MODAL}${id}:${row.activeVersion}`, title: `Edit ${id}`.slice(0, 45),
      inputs: [
        { id: 'title', label: 'Title', style: 'short', required: true, maxLength: SKILL_TITLE_MAX, value: row.title },
        { id: 'instructions', label: 'Instructions', style: 'paragraph', required: true, minLength: 10, maxLength: SKILL_INSTRUCTIONS_MAX, value: row.instructions },
        { id: 'templates', label: 'Templates (optional): "## name" starts each', style: 'paragraph', required: false, maxLength: TEMPLATES_INPUT_MAX, ...(templates ? { value: templates.slice(0, TEMPLATES_INPUT_MAX) } : {}) },
      ],
    },
  };
};

/** Both modals. SK9: the edit custom id is parsed strictly (slug regex, positive integer base version) before anything runs. */
export const skillModalSubmit: Handler = async (i, deps) => {
  if (!need(deps)) return NO_SKILLS;
  const templates = parseTemplates(i.field('templates') ?? '');
  if (templates === null) return ephemeral('Templates must start with a "## name" line.');
  const title = (i.field('title') ?? '').trim();
  const instructions = i.field('instructions') ?? '';
  if (i.customId === SKILL_CREATE_MODAL) {
    const plan = await planSkillCreate((i.field('id') ?? '').trim(), { title, instructions, templates }, null, asDeps(deps), by(i.userId));
    return runPlan(plan, 'Skill created');
  }
  const m = EDIT_ID.exec(i.customId);
  if (!m) return ephemeral('That form is not valid; open /skill edit again.');
  return runPlan(await planSkillEdit(m[1]!, Number(m[2]), { title, instructions, templates }, asDeps(deps), by(i.userId)), 'Skill edited');
};

export const skillAttach: Handler = async (i, deps) => {
  if (!need(deps)) return NO_SKILLS;
  const id = slug(i);
  if (!id) return ephemeral('Unknown skill.');
  return runPlan(await planSkillAttach(id, i.options.string('target') ?? '', i.options.integer('priority') ?? undefined, asDeps(deps), by(i.userId)), 'Skill attached');
};
export const skillDetach: Handler = async (i, deps) => {
  if (!need(deps)) return NO_SKILLS;
  const id = slug(i);
  if (!id) return ephemeral('Unknown skill.');
  return runPlan(await planSkillDetach(id, i.options.string('target') ?? '', asDeps(deps), by(i.userId)), 'Skill detached');
};
export const skillTools: Handler = async (i, deps) => {
  if (!need(deps)) return NO_SKILLS;
  const id = slug(i);
  if (!id) return ephemeral('Unknown skill.');
  return runPlan(await planSkillTools(id, i.options.string('action') ?? '', (i.options.string('tool') ?? '').trim(), asDeps(deps), by(i.userId)), 'Skill tools changed');
};
export const skillToggle = (enabled: boolean): Handler => async (i, deps) => {
  if (!need(deps)) return NO_SKILLS;
  const id = slug(i);
  if (!id) return ephemeral('Unknown skill.');
  return runPlan(await planSkillToggle(id, enabled, asDeps(deps), by(i.userId)), enabled ? 'Skill enabled' : 'Skill disabled');
};
export const skillRollback: Handler = async (i, deps) => {
  if (!need(deps)) return NO_SKILLS;
  const id = slug(i);
  if (!id) return ephemeral('Unknown skill.');
  return runPlan(await planSkillRollback(id, i.options.integer('version') ?? 0, asDeps(deps), by(i.userId)), 'Skill rolled back');
};

export const skillProposals: Handler = async (_i, deps) => {
  const svc = need(deps);
  if (!svc) return NO_SKILLS;
  const open = await svc.repo.listProposals(['open', 'card'], 25);
  if (!open.length) return priv('Skill proposals', 'No proposals are waiting.');
  // ids, departments, kinds and slugs only (all validated): no proposal text and no reason in a listing
  return priv('Skill proposals', `${open.length} waiting. Read one in full with /skill review <id>.`, open.map((p) => ({ name: `#${p.id} ${p.kind} ${p.skillId}`, value: `from ${p.deptId} head, ${p.status === 'card' ? 'card posted' : 'open'}` })));
};

export const skillReview: Handler = async (i, deps) => {
  if (!need(deps) || !deps.admin?.mintSkillCard) return NO_SKILLS;
  const id = i.options.integer('proposal');
  if (id === null || id < 1) return ephemeral('Unknown proposal.');
  const r = await deps.admin.mintSkillCard(i.userId, id);
  return r.ok ? ephemeral(r.text) : ephemeral(r.error);
};

export const skillReject: Handler = async (i, deps) => {
  const svc = need(deps);
  if (!svc) return NO_SKILLS;
  const id = i.options.integer('proposal');
  if (id === null || id < 1) return ephemeral('Unknown proposal.');
  return (await svc.rejectProposal(id, i.userId)) ? ephemeral(`Proposal #${id} rejected.`) : ephemeral('That proposal is not waiting.');
};
