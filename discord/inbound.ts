import { MessageReferenceType, type Message } from 'discord.js';
import type { IncomingMessage } from '../company/types.js';
import type { DeptId } from '../core/index.js';
import { handlesIn } from '../company/handles.js';

/** A persona webhook we created, as persisted in `persona_webhooks`. */
export interface KnownWebhook {
  applicationId: string;
  deptId: DeptId;
}

export interface InboundCtx {
  /** GUILD_ID; messages from any other guild (or DMs) are dropped (Gate 1 D5). */
  guildId: string;
  /** BOT_ADMIN_ROLE_ID; admin is never identified by role name (Gate 1 D5). */
  adminRoleId: string;
  /** Bot user id → department, for the head clients that are online. */
  botUserIds: ReadonlyMap<string, DeptId>;
  /** Our persona webhooks by webhook id (Gate 1 D6). */
  webhooks: ReadonlyMap<string, KnownWebhook>;
  /** Persona id of `dept` whose display name is `name` (a webhook message's username), or null. */
  personaByName(dept: DeptId, name: string): string | null;
}

type Author = IncomingMessage['author'];

/**
 * Attribution order (Gate 1 D6):
 * 1. our persisted webhook id AND applicationId equal to the owning head's application AND a persona name of that dept → persona;
 * 2. author is one of our head bot users → head (interaction replies carry a webhookId but our bot user as author);
 * 3. any other webhook or bot → foreign_bot; otherwise human.
 */
function authorOf(m: Message, ctx: InboundCtx): Author {
  const name = m.member?.displayName ?? m.author.globalName ?? m.author.username;
  if (m.webhookId) {
    const hook = ctx.webhooks.get(m.webhookId);
    if (hook && m.applicationId !== null && m.applicationId === hook.applicationId) {
      const personaId = ctx.personaByName(hook.deptId, m.author.username);
      if (personaId) return { id: m.author.id, name: m.author.username, kind: 'persona', actor: { kind: 'persona', personaId } };
    }
  }
  const dept = ctx.botUserIds.get(m.author.id);
  if (dept) return { id: m.author.id, name, kind: 'head', actor: { kind: 'head', dept } };
  if (m.webhookId || m.author.bot) return { id: m.author.id, name, kind: 'foreign_bot' };
  return { id: m.author.id, name, kind: 'human' };
}

/** Cap for text derived from embeds (R30). */
export const EMBED_TEXT_MAX = 8000;

type EmbedLike = { title?: string | null; description?: string | null; fields?: readonly { name: string; value: string }[] };

/** First `max` UTF-16 units, without leaving half of a surrogate pair at the end. */
function cut(s: string, max: number): string {
  if (s.length <= max) return s;
  const end = s.charCodeAt(max - 1);
  return s.slice(0, end >= 0xd800 && end <= 0xdbff ? max - 1 : max);
}

/** Title, description and "name: value" field lines of each embed, joined with newlines. */
export function embedText(embeds: readonly EmbedLike[]): string {
  const lines: string[] = [];
  for (const e of embeds) {
    if (e.title) lines.push(e.title);
    if (e.description) lines.push(e.description);
    for (const f of e.fields ?? []) lines.push(`${f.name}: ${f.value}`);
  }
  return lines.join('\n');
}

/**
 * R30: our bots and personas post embed-only, so their text lives in the embeds. For those authors the content is
 * the message content (if any) followed by the embed text, capped. Humans keep their own content.
 */
function contentOf(m: Message, author: Author): string {
  if (author.kind !== 'head' && author.kind !== 'persona') return m.content;
  const derived = embedText((m.embeds ?? []) as readonly EmbedLike[]);
  if (!derived) return m.content;
  return cut([m.content, derived].filter((s) => s.trim() !== '').join('\n'), EMBED_TEXT_MAX);
}

/**
 * RF1: a reply is a reference of type Default in the same guild and channel; a forward is type Forward (it points into another channel).
 * The snapshot text is cut at EMBED_TEXT_MAX before anything reads it (RF8) and is kept apart from `content`.
 */
function referenceOf(m: Message, ctx: InboundCtx): Pick<IncomingMessage, 'replyToId' | 'forward'> {
  const ref = m.reference;
  if (!ref) return {};
  if (ref.type === MessageReferenceType.Forward) {
    const snap = m.messageSnapshots?.first();
    const text = snap ? cut([cut(snap.content ?? '', EMBED_TEXT_MAX), embedText(((snap.embeds ?? []) as readonly EmbedLike[]).slice(0, 10))].filter((t) => t.trim() !== '').join('\n'), EMBED_TEXT_MAX) : '';
    const known = ref.guildId === ctx.guildId && !!ref.channelId && /^\d{17,20}$/.test(ref.channelId);
    return { forward: { sourceChannelId: known ? ref.channelId : null, sourceMessageId: known && ref.messageId && /^\d{17,20}$/.test(ref.messageId) ? ref.messageId : null, text, attachmentCount: snap?.attachments?.size ?? 0, attachments: snap?.attachments ? [...snap.attachments.values()].slice(0, 10).map((a) => ({ name: a.name ?? 'file', url: a.url, size: a.size, ...(a.contentType ? { contentType: a.contentType } : {}) })) : [] } };
  }
  if (ref.type === MessageReferenceType.Default && ref.messageId && ref.guildId === ctx.guildId && ref.channelId === m.channelId) return { replyToId: ref.messageId };
  return {};
}

/** Maps a discord.js message to the router's shape, or null when it must be ignored (other guild, DM). */
export function toIncoming(m: Message, ctx: InboundCtx): IncomingMessage | null {
  if (!m.guildId || m.guildId !== ctx.guildId) return null;
  const thread = m.channel.isThread() ? m.channel : null;
  // TW11: a thread without its parent (a partial channel) would pass the denylist and routing checks as if it were a top-level channel; never map it.
  if (m.channel.partial || (thread && !thread.parentId)) return null;
  const author = authorOf(m, ctx);
  const mentionedHeads: DeptId[] = [];
  const content = contentOf(m, author);
  const refs = referenceOf(m, ctx);
  // RF2 / P1-B: the implicit reply ping (`mentions.repliedUser`) is never a mention: it counts only when the author typed the mention in the content.
  const repliedAuthorId = refs.replyToId ? m.mentions.repliedUser?.id : undefined;
  // VULN-006: which of our bots wrote the message being replied to, from the gateway's own reference (no fetch): a head bot user, or a persona webhook (webhook id = its user id).
  const repliedDept: DeptId | undefined = repliedAuthorId ? ctx.botUserIds.get(repliedAuthorId) ?? ctx.webhooks.get(repliedAuthorId)?.deptId as DeptId | undefined : undefined;
  const typed = (id: string) => m.content.includes(`<@${id}>`) || m.content.includes(`<@!${id}>`);
  const userIds = refs.forward ? [] : [...m.mentions.users.keys()].filter((id) => id !== repliedAuthorId || typed(id));
  const ids = userIds.filter((id) => !(author.kind !== 'human' && !!refs.replyToId && id === repliedAuthorId));
  // P1-B: mentions of anyone else (a person, a non-bot role, @everyone / @here) so the router can stay silent; our bot's managed role counts as that bot.
  let otherMentions = false;
  if (author.kind === 'human' && !refs.forward) {
    for (const id of userIds) if (!ctx.botUserIds.has(id)) otherMentions = true;
    for (const r of m.mentions.roles?.values() ?? []) {
      const botId = (r as { tags?: { botId?: string } | null }).tags?.botId;
      const d = botId ? ctx.botUserIds.get(botId) : undefined;
      if (d) { if (!mentionedHeads.includes(d)) mentionedHeads.push(d); } else otherMentions = true;
    }
    if (m.mentions.everyone) otherMentions = true;
  }
  // Our bots post with allowedMentions.parse = [], in plain content (chat) or embeds (cards): read their `<@id>` markup from the text either way.
  if (author.kind === 'head' || author.kind === 'persona') for (const x of content.matchAll(/<@!?(\d{17,20})>/g)) ids.push(x[1]!);
  for (const id of ids) {
    const d = ctx.botUserIds.get(id);
    if (d && !mentionedHeads.includes(d)) mentionedHeads.push(d);
  }
  // TW8: a handle such as `@CTO` counts only in the words of our own heads and personas (never a human, so no new human trigger path).
  if (author.kind === 'head' || author.kind === 'persona') for (const d of handlesIn(content)) if (!mentionedHeads.includes(d)) mentionedHeads.push(d);
  return {
    id: m.id,
    channelId: m.channelId,
    parentChannelId: thread ? thread.parentId : null,
    threadId: thread ? thread.id : null,
    author,
    content,
    mentionedHeads,
    // only humans can be admins; the role is checked by id from the member sent with the message
    isAdmin: author.kind === 'human' && !!m.member?.roles.cache.has(ctx.adminRoleId),
    ...refs,
    ...(repliedDept && author.kind === 'human' ? { repliedDept } : {}),
    ...(otherMentions ? { otherMentions: true } : {}),
    // T13: no roles are sent for a system message (a pin notice, a join), so it can never give an author a tier
    ...(author.kind === 'human' && m.member && !m.system ? { memberRoleIds: [...m.member.roles.cache.keys()] } : {}),
    attachments: [...m.attachments.values()].map((a) => ({ name: a.name, url: a.url, size: a.size, ...(a.contentType ? { contentType: a.contentType } : {}) })),
    origin: 'chat',
  };
}

export interface InboundDeps {
  guildId: string;
  adminRoleId: string;
  botUserIds: () => ReadonlyMap<string, DeptId>;
  /** `WebhookSender`: looks up a webhook id in its cache, then in `persona_webhooks`. */
  webhooks: { lookup(webhookId: string): Promise<KnownWebhook | null> };
  org: { personaByName(dept: string, name: string): { id: string } | null };
  /** TW11: debug log for a dropped partial message (ids only, never content). */
  log?: { debug(o: object, m?: string): void };
}

/**
 * TW11: a partial channel, or a thread whose parent is unknown, is fetched first. False (drop the message) when the fetch fails or the
 * parent is still unknown afterwards. Fail closed: the denylist, the ignored list and the warroom rule all read the parent.
 */
export async function completeChannel(m: Message, log?: InboundDeps['log']): Promise<boolean> {
  type Ch = { partial?: boolean; isThread(): boolean; parentId?: string | null; fetch(): Promise<unknown> };
  // `m.channel` is resolved from the client cache on every read, so a fetch that fills the cache is seen by the re-read below.
  const ch = () => m.channel as unknown as Ch | null;
  const incomplete = () => {
    const c = ch();
    return !c || !!c.partial || (c.isThread() && !c.parentId);
  };
  if (!incomplete()) return true;
  try {
    await ch()?.fetch();
  } catch {
    log?.debug({ channelId: m.channelId }, 'partial channel could not be fetched; message dropped');
    return false;
  }
  if (incomplete()) {
    log?.debug({ channelId: m.channelId }, 'channel parent unknown after fetch; message dropped');
    return false;
  }
  return true;
}

/** Async wrapper for the live gateway and history: resolves persisted persona webhooks after a restart. */
export function createInboundMapper(deps: InboundDeps): (m: Message) => Promise<IncomingMessage | null> {
  return async (m) => {
    if (!m.guildId || m.guildId !== deps.guildId) return null;
    if (!(await completeChannel(m, deps.log))) return null;
    const hook = m.webhookId ? await deps.webhooks.lookup(m.webhookId) : null;
    return toIncoming(m, {
      guildId: deps.guildId,
      adminRoleId: deps.adminRoleId,
      botUserIds: deps.botUserIds(),
      webhooks: hook && m.webhookId ? new Map([[m.webhookId, hook]]) : new Map(),
      personaByName: (dept, name) => deps.org.personaByName(dept, name)?.id ?? null,
    });
  };
}
