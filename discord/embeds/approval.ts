import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import type { APIActionRowComponent, APIComponentInMessageActionRow } from 'discord.js';
import type { OutboundPayload } from '../../agents/loop/payload.js';
import { redactText, sanitize } from '../../core/logger.js';
import { BATCH_MAX_ITEMS } from '../../db/repos/approval-batches.js';
import type { Approval } from '../../db/repos/ledger.js';
import { grantUrlCheck } from '../../tools/plugins/web/grant-url.js';
import { TREE_GRANT_TOOLS } from '../../tools/tree-grant-tools.js';
import type { EmbedStyle } from './style.js';

export const APPROVAL_COLOR = 0xf1c40f;
export const approvalStyle: EmbedStyle = () => ({ color: APPROVAL_COLOR });

/** W-C9: the grant button names the scope honestly: the whole task tree, not one task. */
export const GRANT_LABEL = 'Allow web reading for this task tree';
export const BATCH_GRANT_LABEL = 'Approve all + allow web reading';
export const REVOKE_LABEL = 'Revoke web reading';
/** `approval:g:<grantId>:revoke` (W-C11b: the handler checks that the message is that grant's card). */
export const REVOKE_ID = /^approval:g:(\d{1,15}):revoke$/;
export const revokeCustomId = (grantId: number): string => `approval:g:${grantId}:revoke`;
/** TREEGRANT-1: the task-tree grant button, its revoke button and their ids (a separate anchored shape: `approval:t:<gid>:revoke`). */
export const TASK_LABEL = 'Approve the whole task';
export const BATCH_TASK_LABEL = 'Approve all + whole task';
export const TASK_REVOKE_LABEL = 'Revoke whole-task approval';
export const TASK_REVOKE_ID = /^approval:t:(\d{1,15}):revoke$/;
export const taskRevokeCustomId = (grantId: number): string => `approval:t:${grantId}:revoke`;
const taskRevokeButton = (grantId: number) => new ButtonBuilder().setCustomId(taskRevokeCustomId(grantId)).setLabel(TASK_REVOKE_LABEL).setStyle(ButtonStyle.Danger);
export const taskRevokeRow = (grantId: number): APIActionRowComponent<APIComponentInMessageActionRow> =>
  new ActionRowBuilder<ButtonBuilder>().addComponents(taskRevokeButton(grantId)).toJSON();
const revokeButton = (grantId: number) => new ButtonBuilder().setCustomId(revokeCustomId(grantId)).setLabel(REVOKE_LABEL).setStyle(ButtonStyle.Danger);

/** Custom ids are `approval:<id>:approve|reject|ask|grant` (parsed by the interaction handler); `grant` only for a card that qualifies (WEBGRANT-1 D5). */
export function approvalRow(approvalId: string, grant = false, task = false): APIActionRowComponent<APIComponentInMessageActionRow> {
  const id = (action: string) => `approval:${approvalId}:${action}`;
  const row = new ActionRowBuilder<ButtonBuilder>()
    .addComponents(
      new ButtonBuilder().setCustomId(id('approve')).setLabel('Approve').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(id('reject')).setLabel('Reject').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(id('ask')).setLabel('Ask').setEmoji('💬').setStyle(ButtonStyle.Secondary),
    );
  // TG-C14: exactly one of the two extra buttons; the web grant wins (a fetch_page card can never be a task-grant card anyway)
  if (grant) row.addComponents(new ButtonBuilder().setCustomId(id('grant')).setLabel(GRANT_LABEL).setStyle(ButtonStyle.Primary));
  else if (task) row.addComponents(new ButtonBuilder().setCustomId(id('task')).setLabel(TASK_LABEL).setStyle(ButtonStyle.Primary));
  return row.toJSON();
}

/** The closing row of a card whose grant was made: the revoke button only. */
export const revokeRow = (grantId: number): APIActionRowComponent<APIComponentInMessageActionRow> =>
  new ActionRowBuilder<ButtonBuilder>().addComponents(revokeButton(grantId)).toJSON();

/** Custom ids are `admincfg:<cardId>:confirm|cancel` (Gate 1 C4); the id is an opaque random token and carries no value, op or user. */
export const ADMIN_CARD_ID = /^admincfg:([0-9a-f]{32}):(confirm|cancel)$/;
export function adminCardRow(cardId: string): APIActionRowComponent<APIComponentInMessageActionRow> {
  const id = (action: string) => `admincfg:${cardId}:${action}`;
  return new ActionRowBuilder<ButtonBuilder>()
    .addComponents(
      new ButtonBuilder().setCustomId(id('confirm')).setLabel('Confirm').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(id('cancel')).setLabel('Cancel').setStyle(ButtonStyle.Danger),
    )
    .toJSON();
}

/** SPEND-1: `spendovr:<id>:approve|reject`; the id is a 128-bit random token and carries no amount (Gate 1 S2). */
export const SPEND_OVERRIDE_ID = /^spendovr:([0-9a-f]{32}):(approve|reject)$/;
export function spendOverrideRow(id: string): APIActionRowComponent<APIComponentInMessageActionRow> {
  const cid = (action: string) => `spendovr:${id}:${action}`;
  return new ActionRowBuilder<ButtonBuilder>()
    .addComponents(
      new ButtonBuilder().setCustomId(cid('approve')).setLabel('Approve raise').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(cid('reject')).setLabel('Reject').setStyle(ButtonStyle.Danger),
    )
    .toJSON();
}

/** GROW-1: `toolreq:<token>:approve|reject`; the token is 128-bit random and carries no tool name (Gate 1 GW-C17). */
export const TOOL_REQUEST_ID = /^toolreq:([0-9a-f]{32}):(approve|reject)$/;
export function toolRequestRow(token: string): APIActionRowComponent<APIComponentInMessageActionRow> {
  const cid = (action: string) => `toolreq:${token}:${action}`;
  return new ActionRowBuilder<ButtonBuilder>()
    .addComponents(
      new ButtonBuilder().setCustomId(cid('approve')).setLabel('Approve tool').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(cid('reject')).setLabel('Reject').setStyle(ButtonStyle.Danger),
    )
    .toJSON();
}

/** R5 RELEASE-1: `relcard:<token>:approve|reject`; the token is 128-bit random and carries no slug, title or hash (Gate 1 RL-C11). */
export const RELEASE_CARD_ID = /^relcard:([0-9a-f]{32}):(approve|reject)$/;
export function releaseCardRow(token: string): APIActionRowComponent<APIComponentInMessageActionRow> {
  const cid = (action: string) => `relcard:${token}:${action}`;
  return new ActionRowBuilder<ButtonBuilder>()
    .addComponents(
      new ButtonBuilder().setCustomId(cid('approve')).setLabel('Approve release').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(cid('reject')).setLabel('Reject').setStyle(ButtonStyle.Danger),
    )
    .toJSON();
}

/** AUTO-1: `projcard:<token>:approve|reject` and `projbud:<token>:raise|close`; the tokens are 128-bit random and carry no amount or name (Gate 1 AP-C11). */
export const PROJECT_CARD_ID = /^projcard:([0-9a-f]{32}):(approve|reject)$/;
export function projectCardRow(token: string): APIActionRowComponent<APIComponentInMessageActionRow> {
  const cid = (action: string) => `projcard:${token}:${action}`;
  return new ActionRowBuilder<ButtonBuilder>()
    .addComponents(
      new ButtonBuilder().setCustomId(cid('approve')).setLabel('Approve project').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(cid('reject')).setLabel('Reject').setStyle(ButtonStyle.Danger),
    )
    .toJSON();
}
export const PROJECT_BUDGET_ID = /^projbud:([0-9a-f]{32}):(raise|close)$/;
export function projectBudgetRow(token: string): APIActionRowComponent<APIComponentInMessageActionRow> {
  const cid = (action: string) => `projbud:${token}:${action}`;
  return new ActionRowBuilder<ButtonBuilder>()
    .addComponents(
      new ButtonBuilder().setCustomId(cid('raise')).setLabel('Raise budget').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(cid('close')).setLabel('Close project').setStyle(ButtonStyle.Danger),
    )
    .toJSON();
}

const TARGET_KEYS = ['target', 'repo', 'repository', 'url', 'path', 'channel', 'channelId', 'name'];
const ID_KEYS = ['id', 'itemId', 'taskId', 'issue', 'number'];
const MAX_SUMMARY_FIELDS = 8;
/** CLICKUP-MULTI-1 (CM-C6): the four system pins of a workspace ClickUp write. They are always shown whole and never count toward MAX_SUMMARY_FIELDS. */
const PIN_KEYS: readonly string[] = ['in_list_id', 'list_path', 'in_task', 'in_workspace', 'in_space_id', 'in_folder_id', 'parent_path'];
/** CLICKUP-HIER-1: a call is workspace-pinned when ANY of these is a string (a create without a list carries `in_space_id`, `in_folder_id` or `in_workspace` instead of `in_list_id`). */
const PINNED_BY: readonly string[] = ['in_list_id', 'in_space_id', 'in_folder_id', 'in_workspace'];
const VALUE_MAX = 120;
const REASON_MAX = 300;
const NAME_MAX = 64;
const QUERY_CHUNK = 250; // x4 for markdown escaping stays within Discord's 1024 field limit
const KEY_MAX = 40;
const SHA_PREFIX = 12;

/** CLICKUP-ALL-1 (C1): tools whose text/description is shown whole (label Body) on a workspace-pinned call. Code-defined, never from input. */
export const FULL_BODY_TOOLS: readonly string[] = ['clickup_create_task', 'clickup_update_task', 'clickup_add_comment', 'clickup_create_list'];

/** Invisible or format code points: format chars (zero width, bidi, soft hyphen, BOM), tag chars, variation selectors, private use. */
export const HIDDEN = /[\p{Cf}\p{Co}\u{E0000}-\u{E007F}\u{FE00}-\u{FE0F}\u{E0100}-\u{E01EF}]/gu;

export const visibleCode = (c: string) => `\\u{${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}}`;

/**
 * D7: model- or user-derived text on a card is data. Neutralise markdown, mentions and control characters, then cap.
 * Invisible characters (tag-encoded text, zero width) are written as visible `\u{XXXX}` before the cap, so the approver sees them.
 */
export function escapeCardText(s: string, max: number, secrets: readonly string[] = []): string {
  const clean = redactText(s, secrets)
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f\u2028\u2029]/g, ' ')
    .replace(HIDDEN, visibleCode);
  const cut = clean.length > max ? `${clean.slice(0, max - 1)}\u2026` : clean;
  return cut.replace(/[\\`*_~|>[\]()#]/g, '\\$&').replace(/@/g, '@\u200b').replace(/</g, '\\<');
}

const show = (v: unknown): string => (typeof v === 'string' ? v : JSON.stringify(v) ?? '');
const firstKey = (o: Record<string, unknown>, keys: string[]): string | undefined => keys.find((k) => o[k] !== undefined && o[k] !== null);

/** What a card shows of a stored tool call; `cut` is the one signal that the card shows less than the call that will run. */
type ToolView = {
  tool: string; target?: string; item?: string; queryLabel: 'Query' | 'Prompt' | 'Body'; queryChunks: string[]; changes?: string; sha?: string; cut: boolean;
  /** G2CW-01: redaction changed what a field shows at some layer (raw value or pin, JSON-quoted text, one chunk, one-line JSON). Only cardShowsWhole reads it (solo and one-line views), so other cards render as before. */
  masked: boolean;
};

/**
 * Shared by the solo card and the batch card (B2: one helper, not a copy). `oneLine` (batch card, B3): every model-derived value is
 * JSON-quoted before escaping, so it is exactly one line, and the Changes entries are joined on one line.
 */
function toolCallView(a: Approval, secrets: readonly string[], oneLine: boolean): ToolView {
  const raw = a.toolInput && typeof a.toolInput === 'object' && !Array.isArray(a.toolInput) ? (sanitize(a.toolInput, secrets) as Record<string, unknown>) : {};
  const target = firstKey(raw, TARGET_KEYS);
  const idKey = firstKey(raw, ID_KEYS);
  // G2-05: a search query is shown in full, JSON-quoted (no raw newline), over as many Query fields as it needs.
  // G2RF5-01 (Gate 1 RF31): a generation `prompt` is shown the same way (Prompt fields), never cut to VALUE_MAX.
  // CLICKUP-ALL-1 (C1): the text of a workspace ClickUp write (comment text, task description) is shown the same way, label Body. Only for a call that
  // carries the workspace pin (`in_list_id`, set by the tool's precheck): list-mode calls keep their old, cut rendering and are never turned into a card that cannot be posted.
  const pinned = PINNED_BY.some((k) => typeof raw[k] === 'string'); // a workspace-pinned call: its pins are not counted
  const bodyKey = a.toolName && FULL_BODY_TOOLS.includes(a.toolName) && pinned ? (typeof raw['text'] === 'string' ? 'text' : typeof raw['description'] === 'string' ? 'description' : undefined) : undefined;
  const fullKey = typeof raw['query'] === 'string' ? 'query' : typeof raw['prompt'] === 'string' ? 'prompt' : bodyKey;
  const query = fullKey === undefined ? undefined : (raw[fullKey] as string);
  const queryLabel = bodyKey !== undefined && fullKey === bodyKey ? 'Body' : fullKey === 'prompt' ? 'Prompt' : 'Query';
  const rest = Object.keys(raw).sort().filter((k) => k !== target && k !== idKey && k !== fullKey);
  // The approver must know when the card shows less than the call that will run (the digest covers the full input).
  const plain = pinned ? rest.filter((k) => !PIN_KEYS.includes(k)) : rest;
  let cut = plain.length > MAX_SUMMARY_FIELDS;
  let masked = JSON.stringify(raw) !== JSON.stringify(a.toolInput ?? {}); // G2CW-01: sanitize changed a stored value (a pin included), so the card masks it
  const val = (v: unknown, max = VALUE_MAX) => {
    const e = oneLine ? escapeCardText(JSON.stringify(v) ?? '', max + 2, secrets) : escapeCardText(show(v), max, secrets);
    cut ||= show(v).length > max || e.endsWith('\u2026'); // the second test catches escapes that grew the text past the cap
    if (oneLine) masked ||= redactText(JSON.stringify(v) ?? '', secrets) !== (JSON.stringify(v) ?? ''); // G2CW-01: JSON quoting (`\n` -> `\` + `n`) can start a match the raw value lacks
    return e;
  };
  const quoted = query === undefined ? '' : redactText(JSON.stringify(query), secrets).replace(HIDDEN, visibleCode); // before chunking, so no escape is cut off
  // chunks of at most QUERY_CHUNK UTF-16 units, cut between code points so a surrogate pair (an emoji) is never split
  const chunks: string[] = [];
  let cur = '';
  for (const ch of quoted) {
    if (cur.length + ch.length > QUERY_CHUNK) {
      chunks.push(cur);
      cur = '';
    }
    cur += ch;
  }
  if (cur) chunks.push(cur);
  // G2CW-01: a chunk boundary can start a match (`^`, `\b`) that the whole text does not have, so the card would mask text the call sends
  if (query !== undefined) masked ||= redactText(JSON.stringify(query), secrets) !== JSON.stringify(query) || chunks.some((c) => redactText(c, secrets) !== c);
  const queryChunks = chunks.map((c) => escapeCardText(c, QUERY_CHUNK, secrets));
  const key = (k: string) => {
    cut ||= k.length > KEY_MAX;
    return oneLine ? escapeCardText(JSON.stringify(k), KEY_MAX + 2, secrets) : escapeCardText(k, KEY_MAX, secrets);
  };
  const tool = escapeCardText(a.toolName ?? '?', NAME_MAX, secrets);
  const targetText = target ? val(raw[target]) : undefined;
  const itemText = idKey ? val(raw[idKey]) : undefined;
  let counted = 0;
  const shown = rest.filter((k) => (pinned && PIN_KEYS.includes(k)) || counted++ < MAX_SUMMARY_FIELDS);
  const changes = rest.length
    ? shown.map((k) => `${key(k)}: ${val(raw[k])}`).join(oneLine ? '; ' : '\n') +
      (plain.length > MAX_SUMMARY_FIELDS ? `${oneLine ? ' ' : '\n'}(+${plain.length - MAX_SUMMARY_FIELDS} more)` : '')
    : undefined;
  const sha = a.inputSha256 ? a.inputSha256.slice(0, SHA_PREFIX).replace(/[^0-9a-f]/g, '') : undefined;
  return {
    tool, queryLabel, queryChunks, cut, masked,
    ...(targetText !== undefined ? { target: targetText } : {}), ...(itemText !== undefined ? { item: itemText } : {}),
    ...(changes !== undefined ? { changes } : {}), ...(sha !== undefined ? { sha } : {}),
  };
}

/**
 * W-C9/W-C10: the text a card carries once its grant was made. Names the task tree root, says every department in the tree may read, gives the
 * caps and states the leak bound in plain words (the character budget snapshotted into the grant). Built from code values only.
 */
export function grantClosingText(g: { rootId: string; expiresAt: Date; maxFetches: number; maxHosts: number; maxUrlChars: number }, decided: string, secrets: readonly string[] = []): string {
  const until = `<t:${Math.floor(g.expiresAt.getTime() / 1000)}:f>`;
  return [
    decided,
    `Web reading allowed for task tree ${escapeCardText(g.rootId, NAME_MAX, secrets)} until ${until}: every department working on this task tree may read up to ${g.maxFetches} pages on up to ${g.maxHosts} sites without asking again.`,
    `If a page tricks the bot, it can send up to about ${g.maxUrlChars} characters of what it has read in this task tree to sites it picks, without asking you.`,
    'Writing, sending and deploying still ask every time. Use Revoke web reading to stop it.',
  ].join('\n');
}

// ---- task-tree grant (TREEGRANT-1) ----

/** What a card that carries "Approve the whole task" tells the admin BEFORE the click (TG-C11). Numbers from config and the root (already the conversation cap when it applies). */
export interface TreeGrantOffer {
  maxCalls: number; hours: number;
  /** Set when the click also allows web reading (`web.taskGrant.enabled`): the web caps that go into the companion grant. */
  web: { hours: number; maxFetches: number; maxHosts: number; maxUrlChars: number } | null;
}

const COVERED_TEXT = 'write_file (new files only; in practice it still asks, because a run that resumes after any approval or reads outside content never writes without asking), pin_message, forum_post, forward_to (only when its audience is not wider), doc_create (not money, tax or offer drafts) and music controls';
const STILL_ASKS_TEXT = 'Still asks every time: image and video generation, ClickUp and GitHub changes, reminders, schedules, deletions, settings, deploys and anything dangerous.';

const webTail = (w: NonNullable<TreeGrantOffer['web']>): string =>
  `It also allows web reading for the tree: up to ${w.maxFetches} pages on up to ${w.maxHosts} sites for ${w.hours} hours. If a page tricks the bot, it can send up to about ${w.maxUrlChars} characters of what it has read in this task tree to sites it picks, without asking you.`;

/** The code-built body text of a card that shows the task button. Integers and fixed words only. */
export function taskOfferText(o: TreeGrantOffer): string {
  return [
    `"${TASK_LABEL}" approves this call and lets every department and persona in this task tree run up to ${o.maxCalls} further calls without asking, for the rest of this run and the department tasks it starts (it ends when this conversation or task finishes, and after ${o.hours} hours at most): ${COVERED_TEXT}.`,
    STILL_ASKS_TEXT,
    ...(o.web ? [webTail(o.web)] : []),
    'Cards already waiting stay waiting.',
  ].join('\n');
}

/** The whole card content of a live task grant, rebuilt from its row alone (what the usage-line editor writes). */
export function taskGrantCardText(
  g: { approvalId: number; grantedBy: string; rootId: string; expiresAt: Date; maxCalls: number; used: number; usedByTool: unknown },
  web: { maxFetches: number; maxHosts: number; maxUrlChars: number } | null, secrets: readonly string[] = [],
): string {
  const by = /^[0-9]{17,20}$/.test(g.grantedBy) ? `<@${g.grantedBy}>` : 'a Bot Admin';
  return `${taskGrantClosingText({ rootId: g.rootId, expiresAt: g.expiresAt, maxCalls: g.maxCalls, web }, `Approval #${g.approvalId} approved by ${by}.`, secrets)}\n${taskUsageLine(g.used, g.maxCalls, g.usedByTool)}`;
}

const END_WORDS: Readonly<Record<string, string>> = {
  admin: 'revoked by a Bot Admin', halt: 'the company was halted', disabled: 'the feature was switched off', root_ended: 'the task ended', superseded: 'replaced by a newer approval',
};
/** What a closed task-grant card says (a fixed phrase per reason; the usage line is code-built). */
export function taskGrantEndedText(g: { rootId: string; used: number; maxCalls: number; usedByTool: unknown }, reason: string, secrets: readonly string[] = []): string {
  return `Whole-task approval ended (${END_WORDS[reason] ?? 'ended'}) for task tree ${escapeCardText(g.rootId, NAME_MAX, secrets)}. Calls in this task tree ask again. ${taskUsageLine(g.used, g.maxCalls, g.usedByTool)}`;
}

const SAFE_TOOL_NAME = /^[a-z][a-z0-9_]{0,63}$/;
const COVERED_NAMES: readonly string[] = TREE_GRANT_TOOLS;
const isCount = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;

/** TG-C17: `Used 7/40 · write_file×3 forum_post×2`; only registered covered tool names and safe integers, never a title, input or model text. */
export function taskUsageLine(used: number, max: number, byTool: unknown): string {
  const parts: string[] = [];
  if (byTool && typeof byTool === 'object' && !Array.isArray(byTool)) {
    for (const [k, v] of Object.entries(byTool as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))) {
      if (COVERED_NAMES.includes(k) && SAFE_TOOL_NAME.test(k) && isCount(v) && v > 0) parts.push(`${k}\u00d7${v}`);
    }
  }
  return `Used ${isCount(used) ? used : 0}/${isCount(max) ? max : 0}${parts.length ? ` \u00b7 ${parts.join(' ')}` : ''}`;
}

/** The card message content once a task grant was made on it (also the closing text that stays when it ends). Code values only. */
export function taskGrantClosingText(
  g: { rootId: string; expiresAt: Date; maxCalls: number; web: { maxFetches: number; maxHosts: number; maxUrlChars: number } | null },
  decided: string, secrets: readonly string[] = [],
): string {
  const until = `<t:${Math.floor(g.expiresAt.getTime() / 1000)}:f>`;
  return [
    decided,
    `Whole task approved for task tree ${escapeCardText(g.rootId, NAME_MAX, secrets)} until ${until} or until the task ends: every department and persona in this task tree may run up to ${g.maxCalls} calls without asking again: ${COVERED_TEXT}.`,
    STILL_ASKS_TEXT,
    ...(g.web ? [`Web reading is also allowed: up to ${g.web.maxFetches} pages on up to ${g.web.maxHosts} sites. If a page tricks the bot, it can send up to about ${g.web.maxUrlChars} characters of what it has read in this task tree to sites it picks, without asking you.`] : []),
    `Use ${TASK_REVOKE_LABEL} to stop it.`,
  ].join('\n');
}

/** The stored `fetch_page` url of an approval, or null (any other tool, or an input without a string url). */
function storedFetchUrl(a: Approval): string | null {
  if (a.toolName !== 'fetch_page' || !a.toolInput || typeof a.toolInput !== 'object' || Array.isArray(a.toolInput)) return null;
  const u = (a.toolInput as { url?: unknown }).url;
  return typeof u === 'string' ? u : null;
}

/**
 * W-C4: whether the stored url is shown whole on the SOLO card (the one signal the card itself uses for "shows less than the call that will run").
 * Shared by the grant button and Approvals.decideGrant, so the button and the click can never disagree.
 */
export function soloShowsWhole(a: Approval, secrets: readonly string[] = []): boolean {
  return a.toolName !== undefined && a.toolName !== null && !toolCallView(a, secrets, false).cut;
}

/** WEBGRANT-1 D5/W4: whether the solo card gets the grant button: `fetch_page`, a url that passes grantUrlCheck, shown whole. Recomputed from the stored input. */
export function soloGrantEligible(a: Approval, secrets: readonly string[] = []): boolean {
  const url = storedFetchUrl(a);
  return url !== null && grantUrlCheck(url).ok && soloShowsWhole(a, secrets);
}

/** The batch card shows the grant button only when every member qualifies (D5). */
export function batchGrantEligible(members: readonly Approval[], secrets: readonly string[] = []): boolean {
  return members.length > 0 && members.every((m) => {
    const url = storedFetchUrl(m);
    return url !== null && grantUrlCheck(url).ok && compactItem(m, secrets, STATUS_LONGEST) !== null;
  });
}

/**
 * The card for a tool approval (R4/P3), built only from the stored validated call (tool name, input) and the
 * code-produced reason, never from model prose. The approver sees the tool, its target, the item id and the changes.
 */
export function toolApprovalPayload(a: Approval, secrets: readonly string[] = [], opts: { grantEnabled?: boolean; /** TREEGRANT-1: the offer to show (null/absent: no task button; the caller has already checked eligibility and that the tree has no live grant). */ taskGrant?: TreeGrantOffer | null } = {}): OutboundPayload {
  const v = toolCallView(a, secrets, false);
  const base = [
    { name: 'Tool', value: v.tool },
    ...(v.target !== undefined ? [{ name: 'Target', value: v.target }] : []),
    ...(v.item !== undefined ? [{ name: 'Item', value: v.item }] : []),
    ...v.queryChunks.map((c, i) => ({ name: i === 0 ? v.queryLabel : `${v.queryLabel} (cont.)`, value: c })),
    ...(v.changes !== undefined ? [{ name: 'Changes', value: v.changes }] : []),
    ...(v.sha !== undefined ? [{ name: 'Input sha256', value: v.sha }] : []),
    ...(v.cut ? [{ name: 'Note', value: 'Input truncated on this card; the approved call is the full stored input.' }] : []),
    { name: 'Task', value: escapeCardText(a.taskId, NAME_MAX, secrets) },
    { name: 'Requested by', value: escapeCardText(a.requestedBy, NAME_MAX, secrets) },
  ];
  const reason = escapeCardText(a.reason, REASON_MAX, secrets);
  // AI-APPROVE-1 (AA-C19): the AI review line, only through escapeCardText, and only while the card keeps within Discord's limits (else omitted, never cut)
  const ai = a.aiReview ? { name: 'AI review', value: escapeCardText(a.aiReview, 200, secrets) } : null;
  const fields = ai && ai.value.length >= 1 && ai.value.length <= FIELD_VALUE_LIMIT && base.length + 1 <= 25
    && 64 + reason.length + [...base, ai].reduce((n, f) => n + f.name.length + f.value.length, 0) <= EMBED_LIMIT - 200 ? [...base, ai] : base;
  const web = opts.grantEnabled === true && soloGrantEligible(a, secrets);
  // TG-C11/C14: the task button only with its explanatory text in the body and only while the whole card still fits Discord's limits (it is never cut)
  const offerText = !web && opts.taskGrant ? taskOfferText(opts.taskGrant) : null;
  const withOffer = offerText !== null ? `${reason}\n\n${offerText}` : null;
  const room = withOffer !== null && fields.length <= 25 && withOffer.length <= 4096
    && 64 + withOffer.length + fields.reduce((n, f) => n + f.name.length + f.value.length, 0) <= EMBED_LIMIT - 200; // title + footer margin
  return {
    type: 'approval',
    origin: 'governance',
    title: `Approval #${a.id} needed`,
    body: room ? withOffer! : reason,
    fields,
    buttons: { approvalId: String(a.id), ...(web ? { grant: true as const } : room ? { task: true as const } : {}) },
  };
}

/**
 * CLICKUP-ALL-1 (C1b): whether the SOLO card of this stored call shows the whole call within Discord's limits: nothing cut (no Note field), at most 25
 * fields, every field value at most 1024 characters, the whole embed at most 6000. A tool's precheck refuses a call for which this is false, before any card exists.
 */
export function cardShowsWhole(a: Approval, secrets: readonly string[] = []): boolean {
  const v0 = toolCallView(a, secrets, false);
  // G2CW-01 (C5): neither the solo card nor the one-line batch item may mask text that the call sends
  if (v0.cut || v0.masked || toolCallView(a, secrets, true).masked) return false;
  const p = toolApprovalPayload(a, secrets);
  const f = p.fields ?? [];
  return f.length <= 25 && f.every((x) => x.name.length <= 256 && x.value.length >= 1 && x.value.length <= FIELD_VALUE_LIMIT) && (p.title ?? '').length + (p.body ?? '').length + f.reduce((n, x) => n + x.name.length + x.value.length, 0) <= EMBED_LIMIT;
}

// ---- batched tool approvals (APPROVAL-BATCH-1) ----

export { BATCH_MAX_ITEMS };
const FIELD_VALUE_LIMIT = 1024; // Discord's field value limit
const EMBED_LIMIT = 6000; // Discord's limit over one message's embeds
const TITLE_LIMIT = 256;
/** The longest Status text a refreshed card can show (a refresh never adds text beyond this budget). */
const STATUS_LONGEST = 'approved';

/** B8: the batch custom id is its own anchored shape; `approval:b:<batchId>:<digest12>:approve|reject|ask`. The single-item `approval:<id>:<action>` never matches it. */
export const BATCH_APPROVAL_ID = /^approval:b:(\d{1,15}):([0-9a-f]{12}):(approve|reject|ask|grant|task)$/;
export type BatchAction = 'approve' | 'reject' | 'ask' | 'grant' | 'task';
export const batchCustomId = (batchId: number, digest: string, action: BatchAction): string => `approval:b:${batchId}:${digest}:${action}`;
export function parseBatchCustomId(id: string): { batchId: number; digest: string; action: BatchAction } | null {
  const m = BATCH_APPROVAL_ID.exec(id);
  return m ? { batchId: Number(m[1]), digest: m[2]!, action: m[3] as BatchAction } : null;
}
const itemCustomId = (approvalId: number, action: 'approve' | 'reject') => `approval:${approvalId}:${action}`;

/**
 * B6/B8: row 0 is Approve all (n) / Deny all (n) / Ask; then two items per row (Approve #id, Deny #id), at most 4 rows. Only pending
 * items get buttons; with none pending there are no components at all.
 */
export function batchRows(b: NonNullable<OutboundPayload['batchButtons']>): APIActionRowComponent<APIComponentInMessageActionRow>[] {
  const pending = b.items.filter((i) => i.pending);
  // WEBGRANT-1: once a grant was made on this card its revoke button takes the place of the grant button, even when nothing is pending any more.
  if (pending.length === 0) return b.revokeTaskGrantId !== undefined ? [taskRevokeRow(b.revokeTaskGrantId)] : b.revokeGrantId !== undefined ? [revokeRow(b.revokeGrantId)] : [];
  const row0 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(batchCustomId(b.batchId, b.digest, 'approve')).setLabel(`Approve all (${pending.length})`).setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(batchCustomId(b.batchId, b.digest, 'reject')).setLabel(`Deny all (${pending.length})`).setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(batchCustomId(b.batchId, b.digest, 'ask')).setLabel('Ask').setEmoji('💬').setStyle(ButtonStyle.Secondary),
  );
  // TG-C14: row 0 holds Approve all, Deny all, Ask plus exactly one of: a task revoke, a web revoke, the web grant or the task grant
  if (b.revokeTaskGrantId !== undefined) row0.addComponents(taskRevokeButton(b.revokeTaskGrantId));
  else if (b.revokeGrantId !== undefined) row0.addComponents(revokeButton(b.revokeGrantId));
  else if (b.task) row0.addComponents(new ButtonBuilder().setCustomId(batchCustomId(b.batchId, b.digest, 'task')).setLabel(BATCH_TASK_LABEL).setStyle(ButtonStyle.Primary));
  else if (b.grant) row0.addComponents(new ButtonBuilder().setCustomId(batchCustomId(b.batchId, b.digest, 'grant')).setLabel(BATCH_GRANT_LABEL).setStyle(ButtonStyle.Primary));
  const rows: APIActionRowComponent<APIComponentInMessageActionRow>[] = [row0.toJSON()];
  for (let i = 0; i < pending.length && rows.length < 5; i += 2) {
    const row = new ActionRowBuilder<ButtonBuilder>();
    for (const it of pending.slice(i, i + 2)) {
      row.addComponents(
        new ButtonBuilder().setCustomId(itemCustomId(it.id, 'approve')).setLabel(`Approve #${it.id}`).setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(itemCustomId(it.id, 'reject')).setLabel(`Deny #${it.id}`).setStyle(ButtonStyle.Danger),
      );
    }
    rows.push(row.toJSON());
  }
  return rows;
}

const oneLineOf = (s: string) => s.replace(/[\r\n\t]+/g, ' ');

/** The compact value of one item: code-written bold labels, each model value on exactly one line (B3). Null when the item cannot be shown whole. */
function compactItem(a: Approval, secrets: readonly string[], status: string): { name: string; value: string } | null {
  const v = toolCallView(a, secrets, true);
  if (v.cut || v.queryChunks.length > 1) return null; // B2: the card would show less than the call that will run
  const lines = [
    `**Reason:** ${oneLineOf(escapeCardText(JSON.stringify(a.reason) ?? '""', REASON_MAX + 2, secrets))}`,
    ...(v.target !== undefined ? [`**Target:** ${oneLineOf(v.target)}`] : []),
    ...(v.item !== undefined ? [`**Item:** ${oneLineOf(v.item)}`] : []),
    ...(v.queryChunks[0] !== undefined ? [`**${v.queryLabel}:** ${oneLineOf(v.queryChunks[0])}`] : []),
    ...(v.changes !== undefined ? [`**Changes:** ${oneLineOf(v.changes)}`] : []),
    ...(v.sha !== undefined ? [`**Input sha256:** ${v.sha}`] : []),
  ];
  // AI-APPROVE-1: the AI review line (cut to 80), before Status, only while the value stays within the field limit (else omitted)
  const status_ = `**Status:** ${status}`;
  const aiLine = a.aiReview ? `**AI review:** ${oneLineOf(escapeCardText(a.aiReview, 80, secrets))}` : null;
  const withAi = aiLine !== null && [...lines, aiLine, status_].join('\n').length <= FIELD_VALUE_LIMIT;
  const value = [...lines, ...(withAi ? [aiLine] : []), status_].join('\n');
  if (value.length > FIELD_VALUE_LIMIT) return null;
  return { name: `#${a.id} · ${v.tool}`, value };
}

/** B2: whether this item can join a batch at all: shown whole, and its compact field fits Discord's field limit with the longest Status. */
export function compactItemFits(a: Approval, secrets: readonly string[] = []): boolean {
  return a.kind === 'tool' && !!a.toolName && compactItem(a, secrets, STATUS_LONGEST) !== null;
}

const size = (p: { title: string; body: string; fields: { name: string; value: string }[] }) =>
  p.title.length + p.body.length + p.fields.reduce((n, f) => n + f.name.length + f.value.length, 0);

/** The title, body and fields of a batch card; all the budget checks share this. */
function batchCard(members: readonly Approval[], secrets: readonly string[], statusOf: (a: Approval) => string) {
  if (members.length < 1 || members.length > BATCH_MAX_ITEMS) throw new Error('a batch card shows 1 to 8 items');
  const fields: { name: string; value: string }[] = [];
  for (const m of members) {
    const f = compactItem(m, secrets, statusOf(m));
    if (!f) throw new Error(`approval #${m.id} cannot be shown whole on a batch card`);
    fields.push(f);
  }
  const first = members[0]!;
  const title = `Approvals #${first.id}–#${members[members.length - 1]!.id} needed: ${members.length} tool approvals, task ${escapeCardText(first.taskId, NAME_MAX, secrets)}`;
  const body = `Requested by ${escapeCardText(first.requestedBy, NAME_MAX, secrets)}.\nEach call is approved separately; 'Approve all' approves exactly the calls listed on this card.`;
  return { title, body, fields };
}

/** B2: whether the card still fits (title, body, every field at the longest Status) with `next` added: <= 6000 and every title/field in limits. */
export function batchFits(members: readonly Approval[], next: Approval, secrets: readonly string[] = []): boolean {
  if (members.length + 1 > BATCH_MAX_ITEMS) return false;
  try {
    const c = batchCard([...members, next], secrets, () => STATUS_LONGEST);
    return c.title.length <= TITLE_LIMIT && size(c) <= EMBED_LIMIT;
  } catch {
    return false;
  }
}

/**
 * The batched card: ONE embed (rendered by the dedicated single-embed branch of buildMessage), one field per item named `#<id> · <tool>`.
 * Built only from stored validated calls and code-written text. Throws when the card would not fit whole (nothing is ever truncated).
 */
export function batchApprovalPayload(
  members: readonly (Approval & { live?: boolean })[], batch: { id: number; digest: string }, secrets: readonly string[] = [],
  /** WEBGRANT-1: `grant` = the feature is on (the button is added only when every member qualifies); `revokeGrantId` = a grant made on this card, shown as its revoke button. */
  opts: { grant?: boolean; revokeGrantId?: number; grantNote?: string; /** TREEGRANT-1: the offer (every member already checked by the caller); revokeTaskGrantId = a task grant made on this card. */ taskGrant?: TreeGrantOffer | null; revokeTaskGrantId?: number } = {},
): OutboundPayload {
  // A row past its expiry by the DB clock is still `pending` until expireOld sweeps it; the card shows it as expired and offers no buttons for it.
  const dead = (m: Approval & { live?: boolean }) => m.status === 'pending' && m.live === false;
  const c = batchCard(members, secrets, (m) => (dead(m) ? 'expired' : m.status));
  const longest = batchCard(members, secrets, () => STATUS_LONGEST);
  if (c.title.length > TITLE_LIMIT || size(longest) > EMBED_LIMIT) throw new Error('the batch card exceeds Discord limits');
  const web = opts.grant === true && opts.revokeGrantId === undefined && opts.revokeTaskGrantId === undefined && batchGrantEligible(members, secrets);
  // TG-C11/C14: the task button with its text in the body, only while the card still fits (title, body, every field at the longest Status, <= 6000)
  const offerBody = !web && opts.taskGrant && opts.revokeGrantId === undefined && opts.revokeTaskGrantId === undefined ? `${c.body}\n${taskOfferText(opts.taskGrant)}` : null;
  const room = offerBody !== null && offerBody.length <= 4096 && longest.title.length + offerBody.length + longest.fields.reduce((n, f) => n + f.name.length + f.value.length, 0) <= EMBED_LIMIT;
  return {
    type: 'approval',
    origin: 'governance',
    title: c.title,
    body: room ? offerBody! : c.body,
    fields: c.fields,
    batchButtons: {
      batchId: batch.id, digest: batch.digest, items: members.map((m) => ({ id: m.id, pending: m.status === 'pending' && !dead(m) })),
      ...(opts.revokeTaskGrantId !== undefined ? { revokeTaskGrantId: opts.revokeTaskGrantId, ...(opts.grantNote !== undefined ? { grantNote: opts.grantNote } : {}) }
        : opts.revokeGrantId !== undefined ? { revokeGrantId: opts.revokeGrantId, ...(opts.grantNote !== undefined ? { grantNote: opts.grantNote } : {}) }
          : web ? { grant: true as const } : room ? { task: true as const } : {}),
    },
  };
}

// ---- overtime requests (OT-1) ----

/**
 * OT-1: `approval:ot:<id>:<digest12>:approve|deny|day|revoke`. Anchored and strict: it cannot match APPROVAL_ID (a digit follows `approval:`),
 * BATCH_APPROVAL_ID (`approval:b:`) or REVOKE_ID (`approval:g:`). The id only points at the stored row; the digest is a random nonce stored with it.
 */
export const OT_ID = /^approval:ot:(\d{1,15}):([0-9a-f]{12}):(approve|deny|day|revoke)$/;
export type OtAction = 'approve' | 'deny' | 'day' | 'revoke';
export const otCustomId = (id: number, digest: string, action: OtAction): string => `approval:ot:${id}:${digest}:${action}`;
export function parseOtCustomId(s: string): { id: number; digest: string; action: OtAction } | null {
  const m = OT_ID.exec(s);
  return m ? { id: Number(m[1]), digest: m[2]!, action: m[3] as OtAction } : null;
}
/** OT-C17: the whole-day button says it opens ALL held work for the day, not only this task tree. */
export const OT_DAY_LABEL = 'Make today a workday (all work)';
export const OT_APPROVE_LABEL = 'Approve OT (this task tree)';
export const OT_REVOKE_LABEL = 'Revoke OT';

/** The one button row of an OT card: the three decisions, or the revoke button once a grant was made on it. */
export function otRows(b: NonNullable<OutboundPayload['otButtons']>): APIActionRowComponent<APIComponentInMessageActionRow>[] {
  const id = (a: OtAction) => otCustomId(b.id, b.digest, a);
  const row = new ActionRowBuilder<ButtonBuilder>();
  if (b.mode === 'granted') row.addComponents(new ButtonBuilder().setCustomId(id('revoke')).setLabel(OT_REVOKE_LABEL).setStyle(ButtonStyle.Danger));
  else row.addComponents(
    new ButtonBuilder().setCustomId(id('approve')).setLabel(OT_APPROVE_LABEL).setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(id('deny')).setLabel('Deny').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(id('day')).setLabel(OT_DAY_LABEL).setStyle(ButtonStyle.Secondary),
  );
  return [row.toJSON()];
}

const SNOWFLAKE = /^[0-9]{17,20}$/;

/** What the request card shows. Every text here is a code value or neutralised model/user text (OT-C10). */
export interface OtCardView {
  id: number; digest: string; rootId: string; rootTitle: string;
  /** The root's thread, shown as a channel mention (a link, never a ping). */
  threadId: string | null;
  /** The person whose request started the tree (a user id shown as a no-ping mention; anything else is shown escaped). */
  requestedBy: string;
  held: { tasks: number; depts: string[]; rollups: number; botTalk: number };
  spentUsd: number;
  /** min(now + hours, local midnight). */
  until: Date;
  maxRuns: number; maxUsd: number;
}

const stamp = (d: Date) => `<t:${Math.floor(d.getTime() / 1000)}:t>`;
const money = (n: number) => `$${n.toFixed(n < 1 && n !== 0 ? 4 : 2)}`;

function otFields(v: OtCardView, secrets: readonly string[]): { name: string; value: string }[] {
  const depts = v.held.depts.slice(0, 8).map((d) => escapeCardText(d, 32, secrets)).join(', ');
  const heldParts = [
    `${v.held.tasks} task${v.held.tasks === 1 ? '' : 's'}${depts ? ` (${depts})` : ''}`,
    ...(v.held.rollups ? [`${v.held.rollups} roll-up${v.held.rollups === 1 ? '' : 's'}`] : []),
    ...(v.held.botTalk ? [`${v.held.botTalk} bot message${v.held.botTalk === 1 ? '' : 's'}`] : []),
  ];
  const tree = [escapeCardText(v.rootTitle, 100, secrets), `\`${v.rootId.replace(/[^\w.-]/g, '').slice(0, 64)}\``, ...(v.threadId && SNOWFLAKE.test(v.threadId) ? [`<#${v.threadId}>`] : [])].join('\n');
  return [
    { name: 'Task tree', value: tree },
    { name: 'Requested by', value: SNOWFLAKE.test(v.requestedBy) ? `<@${v.requestedBy}>` : escapeCardText(v.requestedBy, 64, secrets) },
    { name: 'Why', value: 'Today is an off day (weekly or holiday).' },
    { name: 'Held now', value: heldParts.join('; ') },
    { name: 'Spent so far', value: `${money(v.spentUsd)} in this task tree` },
    { name: 'If approved', value: `Until ${stamp(v.until)}, up to ${v.maxRuns} runs, up to ${money(v.maxUsd)} more spend in this task tree. Runs already started finish even if you revoke.` },
  ];
}

/** The OT request card: code-built, one embed, origin governance, no pings (the requester is a mention inside a field). */
export function otRequestPayload(v: OtCardView, secrets: readonly string[] = []): OutboundPayload {
  return {
    type: 'approval', origin: 'governance', title: `OT request #${v.id}`,
    body: 'Work in this task tree is held because today is an off day. Approve overtime for this one task tree, or make today a workday for all held work.',
    fields: otFields(v, secrets),
    otButtons: { id: v.id, digest: v.digest, mode: 'request' },
  };
}

/** The card message content of a grant (also the closing text kept when it ends). `by` is a user id. */
export function otGrantedNote(g: { by: string; until: Date; runsUsed: number; maxRuns: number; maxUsd: number }): string {
  return `OT approved by ${SNOWFLAKE.test(g.by) ? `<@${g.by}>` : 'a Bot Admin'} until ${stamp(g.until)}, runs ${g.runsUsed}/${g.maxRuns}, up to ${money(g.maxUsd)}.`;
}

/** The same card after an approval: the grant in the message content and the Revoke button in place of the three decisions. */
export function otGrantedPayload(v: OtCardView, g: { by: string; until: Date; runsUsed: number; maxRuns: number; maxUsd: number }, secrets: readonly string[] = []): OutboundPayload {
  return { ...otRequestPayload(v, secrets), title: `OT approved #${v.id}`, otButtons: { id: v.id, digest: v.digest, mode: 'granted', note: otGrantedNote(g) } };
}
