import type { CardItem } from '../admin/card.js';
import { lineDiff } from '../knowledge/diff.js';
import { escapeCardText } from '../discord/embeds/approval.js';
import { SKILL_ACTOR_BUDGET_BYTES } from './limits.js';
import type { AttachmentRow } from './types.js';

/** One card field holds 1024 escaped characters; model text is split into chunks of at most this many escaped characters (nothing is cut). */
const CHUNK_ESCAPED = 900;
/** Changed lines are listed only while they stay small; a larger rewrite shows the counts and the full new text (the card is whole or refused, never cut). */
const CHANGED_LINES_MAX = 1200;

/** Splits text so every chunk is at most CHUNK_ESCAPED long AFTER the card escaping; every character lands in exactly one chunk. */
export function chunkForCard(text: string): string[] {
  const out: string[] = [];
  let cur = '';
  let len = 0;
  for (const ch of text) {
    const n = escapeCardText(ch, 10).length;
    if (len + n > CHUNK_ESCAPED) { out.push(cur); cur = ''; len = 0; }
    cur += ch;
    len += n;
  }
  if (cur) out.push(cur);
  return out;
}

export interface SkillCardInput {
  kind: 'create' | 'edit';
  skillId: string;
  version: number;
  bytes: number;
  dept: string;
  proposer: string;
  /** For a create: the target; for an edit: where the skill is attached now. */
  target: string;
  attachments: readonly AttachmentRow[];
  budget: readonly { key: string; bytes: number }[];
  reason: string;
  /** GROW-1: the sanitised AI judge note of an escalated proposal (code-labelled; never a prompt input). */
  aiReview?: string | null;
  block: string;
  /** An edit: the active version's block rendered with the NEW version number (so the version line is not noise); the card adds a code-built changed-lines summary. */
  prevBlock?: string;
}

/**
 * SK7: the card shows the full text or nothing. Code-labelled fields carry only validated ids, versions, counts and the target; the model's reason and the
 * rendered block are separate fields whose labels say they were written by a model, so no model text can pose as "Tool delta" or "Confirm". Proposals
 * never carry tools, so the delta is always empty and says so.
 */
export function skillCardItems(i: SkillCardInput): CardItem[] {
  const worst = [...i.budget].sort((a, b) => b.bytes - a.bytes)[0];
  const where = i.kind === 'create' ? i.target : i.attachments.length ? i.attachments.map((a) => `${a.targetKind}:${a.targetId}`).join(', ') : '(not attached)';
  const items: CardItem[] = [
    { label: 'Skill', old: '', neu: '', plain: `${i.kind} ${i.skillId} -> v${i.version} (${i.bytes} bytes)` },
    { label: 'Proposed by', old: '', neu: '', plain: `${i.proposer} (department ${i.dept})` },
    { label: i.kind === 'create' ? 'Attaches to' : 'Attached to (unchanged)', old: '', neu: '', plain: where },
    { label: 'Budget after apply', old: '', neu: '', plain: worst ? `highest: ${worst.key} ${worst.bytes}/${SKILL_ACTOR_BUDGET_BYTES} bytes, ${i.budget.length} actor${i.budget.length === 1 ? '' : 's'} reached` : 'no actor reached' },
    { label: 'Tool delta', old: '', neu: '', plain: 'none (a proposal never carries tools)' },
    { label: "Reason (written by the proposer, a model)", old: '', neu: '', plain: i.reason },
  ];
  if (i.aiReview) items.push({ label: 'AI review (sanitised, not authoritative)', old: '', neu: '', plain: i.aiReview });
  if (i.kind === 'edit' && i.prevBlock !== undefined) {
    // G2SK-04: what changed, built by code from the two stored versions. The counts are code; the changed lines are model text and say so.
    const ops = lineDiff(i.prevBlock, i.block).filter((o) => o.t !== ' ');
    const added = ops.filter((o) => o.t === '+').length;
    const removed = ops.length - added;
    items.push({ label: 'Changes against the active version', old: '', neu: '', plain: `${added} line${added === 1 ? '' : 's'} added, ${removed} removed (the full new text follows)` });
    const lines = ops.map((o) => `${o.t} ${o.line}`).join('\n');
    if (lines && lines.length <= CHANGED_LINES_MAX) {
      const ps = chunkForCard(lines);
      ps.forEach((p, n) => items.push({ label: `Changed lines (written by a model) ${n + 1}/${ps.length}`, old: '', neu: '', plain: p }));
    }
  }
  const parts = chunkForCard(i.block);
  parts.forEach((p, n) => items.push({ label: `Proposed text (written by a model) ${n + 1}/${parts.length}`, old: '', neu: '', plain: p }));
  return items;
}
