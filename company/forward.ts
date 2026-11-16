import { redactText } from '../core/logger.js';
import { DEPT_IDS } from '../core/index.js';
import { defangHandles, neutralise } from './handles.js';
import type { ActorRef } from './types.js';
import type { Task } from '../db/repos/tasks.js';

/**
 * P1 (RF9-RF11): the code-owned text of a forwarded task. The title is a fixed template (it becomes the thread name and the #tasks card, so no model text
 * ever reaches it); the description holds the link, the reason and the summary for the owner's run; the CARDS (thread card, #tasks log) show it through
 * `cardBody`, which withholds the model text when the target room can be seen by people who cannot see the source.
 */

/** Per-run and per-root caps on `forward_to`, counted in code (RF10); deliberately not config keys. */
export const FORWARDS_PER_RUN = 2;
export const FORWARDS_PER_ROOT = 4;

export const SUMMARY_MAX = 1500;
export const REASON_MAX = 500;

/** The fixed line a card shows instead of the summary (RF11). */
export const FORWARD_WITHHELD = 'The summary is not shown here: this room can be seen by people who cannot see the source channel. Open the source link if you have access.';

export const forwardTitle = (duty: string): string => `Forwarded work (${duty.replace(/[^a-z_]/g, '')})`;

const ZERO_WIDTH = new RegExp('[\\u00ad\\u200b-\\u200f\\u2028\\u2029\\u202a-\\u202e\\u2060-\\u2064\\ufeff]', 'g');

/** Model text for a human-visible card: invisible characters stripped, NFKC (full-width `＠` becomes `@`), secrets masked, mentions broken, capped. */
export function cleanCardText(text: string, max: number, secrets: readonly string[] = []): string {
  const plain = text.replace(ZERO_WIDTH, '').normalize('NFKC').replace(ZERO_WIDTH, '').replace(new RegExp('[\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f]', 'g'), ' ');
  const cut = neutralise(redactText(plain, secrets)).trim();
  return cut.length <= max ? cut : cut.slice(0, max);
}

/** A message link built from ids only (never from model text). Null without a guild id or a channel. */
export function discordLink(guildId: string | undefined, channelId: string | null | undefined, messageId?: string | null): string | null {
  const id = /^\d{1,25}$/;
  if (!guildId || !channelId || !id.test(guildId) || !id.test(channelId)) return null;
  return `https://discord.com/channels/${guildId}/${channelId}${messageId && id.test(messageId) ? `/${messageId}` : ''}`;
}

/** The first line is always the source line; `cardBody` relies on it. */
export function forwardDescription(d: { link: string | null; from: string; reason: string; summary: string }): string {
  return `Forwarded work from ${d.from}. Source: ${d.link ?? '(no source link)'}\n\nReason: ${d.reason}\n\nSummary: ${d.summary}`;
}

/** What a card shows for a task's description. A forwarded task whose audience is wider than the source's shows the source line and a fixed line. */
export function cardBody(task: Pick<Task, 'description' | 'forwardCard'>): string {
  if (task.forwardCard === 'link') return `${task.description.split('\n')[0] ?? ''}\n${FORWARD_WITHHELD}`.trim();
  return task.description.trim() === '' ? '-' : task.description;
}

const CHAIN_MAX = 12;

/**
 * Departments already in the chain of work: the caller (when a head), and the owner department of the given task and each ancestor. The one copy:
 * forward_to and the mention reroute both read it (RR-C19). `get` reads a task by id; a failed read ends the walk.
 */
export async function chainDepts(start: { actor?: ActorRef; task: Task | null }, get: (id: string) => Promise<Task | null>): Promise<Set<string>> {
  const out = new Set<string>();
  if (start.actor?.kind === 'head') out.add(start.actor.dept);
  let t = start.task;
  for (let i = 0; t && i < CHAIN_MAX; i++) {
    out.add(t.deptId);
    if (t.owner.kind === 'head') out.add(t.owner.dept);
    if (t.requester.kind === 'head') out.add(t.requester.dept);
    t = t.parentId ? await get(t.parentId).catch(() => null) : null;
  }
  return out;
}

/** REROUTE-1: a human mention reroutes at most this many heads per message (after de-duplication); a bot's cap comes from the router (3, the CEO 5). */
export const REROUTES_PER_MESSAGE_HUMAN = 3;
/** REROUTE-1 (RR-C12): open rerouted root tasks one person may have. */
export const REROUTE_ROOTS_PER_PERSON = 3;
/** REROUTE-1 (RR-C4): the window of the duplicate guard. */
export const REROUTE_DUP_WINDOW_MS = 15 * 60_000;

/** The label in a reroute title: a department id, or the literal `member`; never a display name (RR-C13). */
export const rerouteLabel = (from: string): string => ((DEPT_IDS as readonly string[]).includes(from) ? from : 'member');

/** Fixed title (it becomes the thread name and the #tasks card): no message text, no name. */
export const rerouteTitle = (from: string): string => `Rerouted mention (from ${rerouteLabel(from)})`;

/** The first line is always the source line; `cardBody` relies on it. `quote` must already be cleaned (cleanCardText). */
export function rerouteDescription(d: { link: string | null; from: string; quote: string }): string {
  return `Rerouted mention from ${rerouteLabel(d.from)}. Source: ${d.link ?? '(no source link)'}\n\nQuote: ${d.quote}`;
}

/** Fixed refusal wording (Thai), by code; nothing a model or a person wrote is echoed (spec Errors). */
export const REROUTE_REFUSALS = {
  no_access: 'คุณยังไม่มีสิทธิ์โพสต์ในห้องงานของแผนกนั้น',
  not_allowed: 'ไม่ได้รับอนุญาตให้ส่งต่อเรื่องนี้',
  limit: 'ถึงขีดจำกัดของงานแล้ว',
  chain: 'แผนกนั้นอยู่ในสายงานเดียวกันอยู่แล้ว',
  no_room: 'ห้องงานของแผนกนั้นใช้งานไม่ได้',
  disabled: 'แผนกนั้นปิดอยู่หรือออฟไลน์',
} as const;
export type RerouteRefusal = keyof typeof REROUTE_REFUSALS;

/** A name written into a code-made notice: handles and raw mentions broken, so the line can never route (RR-C16). */
export const inertName = (name: string): string => defangHandles(neutralise(name));
