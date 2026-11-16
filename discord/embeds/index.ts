import { EmbedBuilder } from 'discord.js';
import type { APIActionRowComponent, APIEmbed, APIComponentInMessageActionRow, AllowedMentionsTypes } from 'discord.js';
import type { OutboundPayload, PayloadType } from '../../agents/loop/payload.js';
import { alertStyle } from './alert.js';
import { adminCardRow, approvalRow, approvalStyle, batchRows, otRows, spendOverrideRow, toolRequestRow, releaseCardRow, projectCardRow, projectBudgetRow } from './approval.js';
import { chatStyle } from './chat.js';
import { configStyle } from './config.js';
import { reportStyle } from './report.js';
import { splitText, truncate } from './split.js';
import type { BuildContext, EmbedStyle } from './style.js';
import { taskStyle } from './task.js';

export type { BuildContext } from './style.js';

export type OutboundMessage = {
  content?: string;
  embeds: APIEmbed[];
  components: APIActionRowComponent<APIComponentInMessageActionRow>[];
  allowedMentions: { parse: AllowedMentionsTypes[]; roles?: string[]; users?: string[]; repliedUser?: boolean };
  /** WS13: the first message of a roll-up replies to the person's message; the reply never pings the author. */
  reply?: { messageReference: string; failIfNotExists: false };
  /** TEAMTALK-1: message flags; 4 = SuppressEmbeds (a code-written relay with bare links). */
  flags?: number;
};

const STYLES: Record<PayloadType, EmbedStyle> = {
  chat: chatStyle, task: taskStyle, report: reportStyle, approval: approvalStyle, alert: alertStyle, config: configStyle,
};

const DESC_MAX = 4096;
const EMBED_MAX = 6000;
const EMBEDS_PER_MESSAGE = 10;
const FIELDS_PER_EMBED = 25;
const TITLE_MAX = 256;
const FIELD_NAME_MAX = 256;
const FIELD_VALUE_MAX = 1024;
const FOOTER_MAX = 512;

/** Characters Discord counts toward the 6000 limit. */
export function embedSize(e: APIEmbed): number {
  return (e.title?.length ?? 0) + (e.description?.length ?? 0) + (e.footer?.text.length ?? 0) + (e.author?.name.length ?? 0) +
    (e.fields ?? []).reduce((n, f) => n + f.name.length + f.value.length, 0);
}

export function footerText(p: OutboundPayload, ctx: BuildContext): string | undefined {
  const stats = p.footer ? `${p.footer.model} · $${p.footer.costUsd.toFixed(4)} · ${(p.footer.ms / 1000).toFixed(1)}s` : undefined;
  const text = [ctx.footerLabel, stats].filter((s): s is string => !!s).join(' · ');
  return text === '' ? undefined : truncate(text, FOOTER_MAX);
}

/** Packs fields into embeds of at most 25 fields and `budget` chars (name + value). */
function packFields(fields: { name: string; value: string }[], budget: number): { name: string; value: string }[][] {
  const groups: { name: string; value: string }[][] = [];
  let cur: { name: string; value: string }[] = [];
  let size = 0;
  for (const f of fields) {
    const n = f.name.length + f.value.length;
    if (cur.length === FIELDS_PER_EMBED || size + n > budget) {
      groups.push(cur);
      cur = [];
      size = 0;
    }
    cur.push(f);
    size += n;
  }
  if (cur.length) groups.push(cur);
  return groups;
}

const CONTENT_MAX = 2000;

/**
 * Owner rule (2026-11-05): embeds are only for settings (`config`) and requests to a person (approval cards, buttons, governance notices).
 * Everything else a bot says in chat is posted as plain message content.
 */
export const isCardPayload = (p: OutboundPayload): boolean =>
  p.type === 'approval' || p.type === 'config' || p.origin === 'governance' || !!p.buttons || !!p.adminCardId || !!p.spendOverrideId || !!p.toolRequestId || !!p.releaseCardId || !!p.projectCardId || !!p.projectBudgetId;

/**
 * Renders a chat answer as plain content: a bold title, the body, `**name:** value` lines for fields and a small `-#` footer line, split
 * into messages of at most 2000 characters. `allowedMentions.parse` stays empty, so a `<@id>` in the text renders without pinging anyone.
 */
export function buildPlainMessage(p: OutboundPayload, ctx: BuildContext): OutboundMessage[] {
  const footer = p.type === 'chat' && ctx.dept === 'praw' ? undefined : footerText(p, ctx);
  const title = truncate(`${p.title ?? ''}`.trim(), TITLE_MAX);
  const parts = [
    title === '' ? '' : `**${title}**`,
    p.body.trimEnd(),
    (p.fields ?? []).map((f) => `**${f.name.trim() === '' ? '-' : f.name}:** ${f.value.trim() === '' ? '-' : f.value}`).join('\n'),
    footer ? `-# ${footer}` : '',
  ].filter((s) => s.trim() !== '');
  const text = parts.length ? parts.join('\n') : '(empty)';
  return splitText(text, CONTENT_MAX).map((c) => ({ content: c, embeds: [], components: [], allowedMentions: { parse: [] } }));
}

/**
 * The batched approval card (B2): exactly one message with exactly one embed (title, description, every field, footer) and the
 * batch button rows. Nothing is truncated or split: a card over Discord's limits throws, and the caller falls back to solo cards.
 */
function buildBatchCard(p: OutboundPayload, ctx: BuildContext): OutboundMessage[] {
  const style = STYLES[p.type](p, ctx);
  const footer = footerText(p, ctx);
  const fields = p.fields ?? [];
  const e: APIEmbed = new EmbedBuilder().setColor(style.color).setTitle(p.title ?? '-').setDescription(p.body)
    .addFields(fields.map((f) => ({ name: f.name, value: f.value }))).toJSON();
  if (footer) e.footer = { text: footer };
  if ((p.title ?? '').length > TITLE_MAX || p.body.length > DESC_MAX || fields.length > FIELDS_PER_EMBED || embedSize(e) > EMBED_MAX
    || fields.some((f) => f.name.length > FIELD_NAME_MAX || f.value.length > FIELD_VALUE_MAX || f.name.trim() === '' || f.value.trim() === '')) {
    throw new Error('the batch card exceeds Discord limits');
  }
  // OT-1: the overtime card shares this single-embed path (it must render as one message so updateCard can edit it in place)
  const note = p.otButtons ? p.otButtons.note : p.batchButtons!.grantNote;
  return [{ ...(note !== undefined ? { content: note.slice(0, CONTENT_MAX) } : {}), embeds: [e], components: p.otButtons ? otRows(p.otButtons) : batchRows(p.batchButtons!), allowedMentions: { parse: [] } }];
}

/** Renders a payload into one or more Discord messages (plain JSON, ready for the REST API). */
export function buildMessage(p: OutboundPayload, ctx: BuildContext): OutboundMessage[] {
  if (p.batchButtons || p.otButtons) return buildBatchCard(p, ctx);
  const style = STYLES[p.type](p, ctx);
  const body = p.body.trimEnd() === '' ? '(empty)' : p.body.trimEnd();
  const footer = p.type === 'chat' && ctx.dept === 'praw' ? undefined : footerText(p, ctx);
  const fields = (p.fields ?? []).slice(0, FIELDS_PER_EMBED).map((f) => ({
    name: truncate(f.name.trim() === '' ? '-' : f.name, FIELD_NAME_MAX),
    value: truncate(f.value.trim() === '' ? '-' : f.value, FIELD_VALUE_MAX),
  }));

  const shapes: { description?: string; fields?: { name: string; value: string }[] }[] = splitText(body, DESC_MAX).map((d) => ({ description: d }));
  for (const group of packFields(fields, EMBED_MAX - (footer?.length ?? 0))) shapes.push({ fields: group });

  const title = truncate(`${p.title ?? ''}`.trim(), TITLE_MAX);
  const embeds: APIEmbed[] = shapes.map((s, i) => {
    const e = new EmbedBuilder().setColor(style.color);
    if (i === 0 && title !== '') e.setTitle(title);
    if (s.description !== undefined) e.setDescription(s.description);
    if (s.fields) e.addFields(s.fields);
    if (i === shapes.length - 1 && footer) e.setFooter({ text: footer });
    return e.toJSON();
  });

  const pingAdmin = p.type === 'alert' && p.origin === 'governance' && !!ctx.adminRoleId && /^\d+$/.test(ctx.adminRoleId);
  // Discord's 6000-char limit is the sum across all embeds of one message: group greedily.
  const groups: APIEmbed[][] = [];
  let cur: APIEmbed[] = [];
  let curSize = 0;
  for (const e of embeds) {
    const n = embedSize(e);
    if (cur.length === EMBEDS_PER_MESSAGE || (cur.length > 0 && curSize + n > EMBED_MAX)) {
      groups.push(cur);
      cur = [];
      curSize = 0;
    }
    cur.push(e);
    curSize += n;
  }
  groups.push(cur);
  const messages: OutboundMessage[] = groups.map((g, i) => {
    const ping = pingAdmin && i === 0;
    const users = i === 0 && p.origin === 'governance' ? (p.mentionUsers ?? []).filter((u) => /^\d{17,20}$/.test(u)) : [];
    const msg: OutboundMessage = { embeds: g, components: [], allowedMentions: ping ? { parse: [], roles: [ctx.adminRoleId!] } : users.length ? { parse: [], users } : { parse: [] } };
    if (ping) msg.content = `<@&${ctx.adminRoleId}>`;
    else if (users.length) msg.content = users.map((u) => `<@${u}>`).join(' ');
    return msg;
  });
  if (p.type === 'approval' && p.buttons) messages[messages.length - 1]!.components = [approvalRow(p.buttons.approvalId, p.buttons.grant === true, p.buttons.task === true)];
  else if (p.type === 'approval' && p.adminCardId) messages[messages.length - 1]!.components = [adminCardRow(p.adminCardId)];
  else if (p.type === 'approval' && p.spendOverrideId) messages[messages.length - 1]!.components = [spendOverrideRow(p.spendOverrideId)];
  else if (p.type === 'approval' && p.toolRequestId) messages[messages.length - 1]!.components = [toolRequestRow(p.toolRequestId)];
  else if (p.type === 'approval' && p.projectCardId) messages[messages.length - 1]!.components = [projectCardRow(p.projectCardId)];
  else if (p.type === 'approval' && p.projectBudgetId) messages[messages.length - 1]!.components = [projectBudgetRow(p.projectBudgetId)];
  else if (p.type === 'approval' && p.releaseCardId) messages[messages.length - 1]!.components = [releaseCardRow(p.releaseCardId)];
  return messages;
}
