import { lintSkillText } from '../knowledge/lint.js';
import { screenText } from '../knowledge/screen.js';
import { skillToolAllowed, SAFE_TOOL_NAME, type GrantEnv } from '../tools/skill-grant.js';
import {
  SKILL_BLOCK_BYTES_MAX, SKILL_BLOCK_CHARS_MAX, SKILL_ID_RE, SKILL_INSTRUCTIONS_MAX, SKILL_INSTRUCTIONS_MIN, SKILL_TEMPLATES_MAX, SKILL_TEMPLATES_TOTAL_MAX,
  SKILL_TEMPLATE_BODY_MAX, SKILL_TEMPLATE_NAME_MAX, SKILL_TITLE_MAX, SKILL_TOOLS_MAX,
} from './limits.js';
import { blockBytes, blockSha256, renderBlock, type SkillBody, type SkillTemplate } from './render.js';

export interface Draft { title: string; instructions: string; templates: SkillTemplate[]; tools?: string[] }
/** Fixed refusal codes (spec "Refusal codes"). Never carries input text; `detail` is a code list or a validated name. */
export type Refusal = { ok: false; code: string; detail?: string };
export type Validated = { ok: true; body: SkillBody; block: string; bytes: number; sha256: string } | Refusal;

const bytes = (s: string): number => Buffer.byteLength(s, 'utf8');
const refuse = (code: string, detail?: string): Refusal => ({ ok: false, code, ...(detail ? { detail } : {}) });

/**
 * One pipeline for admin text and head proposals (SK4). Order: byte and length caps first (before any screen, lint or regex), then screen
 * (secrets and control characters; title and template names must be one line), then the rendered block's size, then the lint on exactly what is
 * injected. Proposals add the classifier on the same rendered block in the service. `id` and `version` are the ones the block will carry.
 */
export function validateDraft(d: Draft, o: { id: string; version: number; secrets?: readonly string[]; grant?: GrantEnv }): Validated {
  if (!SKILL_ID_RE.test(o.id)) return refuse('bad_id');
  // 1. caps on the raw input (cheap, before anything runs over the text)
  if (d.title.length > SKILL_TITLE_MAX || d.instructions.length > SKILL_INSTRUCTIONS_MAX) return refuse('too_long');
  if (d.templates.length > SKILL_TEMPLATES_MAX) return refuse('too_long', 'templates');
  let total = 0;
  for (const t of d.templates) {
    if (t.name.length > SKILL_TEMPLATE_NAME_MAX || t.body.length > SKILL_TEMPLATE_BODY_MAX) return refuse('too_long');
    total += t.body.length;
  }
  if (total > SKILL_TEMPLATES_TOTAL_MAX) return refuse('too_long', 'templates');
  const rawBytes = bytes(d.title) + bytes(d.instructions) + d.templates.reduce((n, t) => n + bytes(t.name) + bytes(t.body), 0);
  if (rawBytes > SKILL_BLOCK_BYTES_MAX) return refuse('too_many_bytes');
  // 2. screen every field
  const single = (s: string, max: number) => screenText(s, { max, ...(o.secrets ? { secrets: o.secrets } : {}), pii: false, multiline: false });
  const multi = (s: string, max: number) => screenText(s.replace(/\r\n/g, '\n'), { max, ...(o.secrets ? { secrets: o.secrets } : {}), pii: false });
  const title = single(d.title, SKILL_TITLE_MAX);
  if (!title.ok) return refuse('screen', 'title');
  const instructions = multi(d.instructions, SKILL_INSTRUCTIONS_MAX);
  if (!instructions.ok) return refuse('screen', 'instructions');
  if (instructions.text.length < SKILL_INSTRUCTIONS_MIN) return refuse('too_short');
  const templates: SkillTemplate[] = [];
  for (const t of d.templates) {
    const name = single(t.name, SKILL_TEMPLATE_NAME_MAX);
    const body = multi(t.body, SKILL_TEMPLATE_BODY_MAX);
    if (!name.ok || !body.ok) return refuse('screen', 'template');
    templates.push({ name: name.text, body: body.text });
  }
  const body: SkillBody = { id: o.id, version: o.version, title: title.text, instructions: instructions.text, templates };
  // 3. the rendered block is what is stored, hashed, linted, classified and shown
  const block = renderBlock(body);
  if (block.length > SKILL_BLOCK_CHARS_MAX) return refuse('too_long', 'block');
  if (blockBytes(body) > SKILL_BLOCK_BYTES_MAX) return refuse('too_many_bytes');
  // 4. tools (admin only): shape, count and grant rule G
  if (d.tools) {
    if (d.tools.length > SKILL_TOOLS_MAX) return refuse('too_long', 'tools');
    for (const n of d.tools) {
      if (!SAFE_TOOL_NAME.test(n) || !o.grant || !skillToolAllowed(n, o.grant)) return refuse('tool_not_allowed', SAFE_TOOL_NAME.test(n) ? n : undefined);
    }
  }
  const lint = lintSkillText(body, { ref: `skills/${o.id}` });
  if (!lint.ok) return refuse(`lint:${lint.reasons.join(',')}`);
  return { ok: true, body, block, bytes: blockBytes(body), sha256: blockSha256(body) };
}

/** Text of a refusal for a human (admin reply, model tool error): fixed sentences, the code and at most a validated name. */
export function refusalText(r: { code: string; detail?: string }): string {
  const c = r.code;
  const tail = r.detail ? ` (${r.detail})` : '';
  if (c.startsWith('lint:')) return `Refused by the policy check: ${c.slice(5)}. A skill cannot touch safety, approval, secret, tool or identity rules, and cannot imitate the skill block layout. [${c}]`;
  const T: Record<string, string> = {
    not_head: 'Only a department head can propose a skill (Praw cannot).', tainted: 'A skill cannot be proposed after reading outside content; ask again in a fresh request.',
    unknown_skill: 'That skill does not exist.', skill_exists: 'A skill with that id already exists.', not_owner: 'Your department does not own that skill.',
    attached_outside_dept: 'That skill is attached outside your department, so you cannot change it.', bad_target: 'The target must be your department or one of its members.',
    open_cap: 'Your department has too many open skill proposals.', pending_exists: 'That skill already has a proposal waiting.', too_long: 'The skill text is too long.',
    too_many_bytes: 'The skill text is too large.', too_short: 'The instructions are too short.', screen: 'The text was refused (a secret-like value, control characters or a line break in a title).',
    budget_exceeded: 'That would exceed the skill text budget of an actor.', per_target_cap: 'That target has too many skills attached.', tool_not_allowed: 'That tool cannot be granted by a skill.',
    stale: 'The skill changed since this was prepared; ask again.', archived: 'That skill is archived.', unavailable: 'The safety review is not available now; try again later.',
    attempt_cap: 'Too many skill proposals from this department in the last hour; try again later.', no_change: 'That is the same text as now.', bad_id: 'The skill id must be lowercase letters, digits and dashes (2-40 characters).',
    invalid: 'The proposal is missing a required field.', library_full: 'The skill library is full.', not_attached: 'That skill is not attached there.', already_attached: 'That skill is already attached there.',
    not_found: 'That does not exist.', retro_skill_used: 'This retro already proposed one skill; only one skill per weekly retro.', unknown_target: 'Unknown department or member.', unknown_version: 'That version does not exist.', nothing_to_do: 'Nothing would change.',
  };
  return `${T[c] ?? 'Refused.'}${tail} [${c}]`;
}
