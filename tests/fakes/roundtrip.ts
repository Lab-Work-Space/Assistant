import type { Client, Message } from 'discord.js';
import type { OutboundPayload } from '../../agents/loop/payload.js';
import { route, type Route, type RouterOrg } from '../../company/router.js';
import type { ActorRef, IncomingMessage } from '../../company/types.js';
import type { DeptId } from '../../core/index.js';
import type { Department, Persona, Task } from '../../db/repos/index.js';
import { toIncoming, type InboundCtx } from '../../discord/inbound.js';
import { createDiscordPort, type PostOptions } from '../../discord/port.js';
import { WebhookSender, type WebhookRepo } from '../../discord/webhooks.js';
import { fakeChannel, fakeRestClient } from './discordClient.js';

/**
 * TEAMTALK-1 T1 round trip with the REAL pipeline: a payload goes through the real port (redact, neutralise, defang, build), the captured Discord message
 * becomes a discord.js-shaped Message, the REAL `toIncoming` maps it and the REAL `route()` decides. Nothing in between is faked, so a relay that
 * would start another head's run shows up as a non-empty route list.
 */
export const GUILD = '1565649426943442944';
export const BOT = { hq: '1565000000000000111', software: '1565000000000000222', finance: '1565000000000000555' } as Record<string, string>;
export const CH = { work: '1565000000000000301', thread: '1565000000000000302', room: '1565000000000000303', roomThread: '1565000000000000304' };
const dept = (id: string): Department => ({ id, name: id, categoryNamePattern: id, workChannelId: id === 'software' ? CH.work : null, color: 1, model: null, provider: null, enabled: true }) as Department;
export const PERSONA: Persona = { id: 'system-analyst', deptId: 'software', name: 'System Analyst', avatarUrl: null, promptRef: 'x', model: null, provider: null, tools: [], directChannelId: CH.room, enabled: true };
const routerOrg: RouterOrg = {
  dept: (id) => (['hq', 'software', 'finance'].includes(id) ? { id, enabled: true, workChannelId: id === 'software' ? CH.work : null } : null),
  persona: (id) => (id === PERSONA.id ? PERSONA : null),
  personasOf: (d) => (d === 'software' ? [PERSONA] : []),
  deptOfChannel: (c) => ((c === CH.work || c === CH.room) ? 'software' : null),
  personaByDirectChannel: (c) => (c === CH.room ? PERSONA : null),
};
const repo: WebhookRepo = { getByChannel: async () => null, getByWebhookId: async () => null, upsert: async () => undefined };

export type Posted = { sent: Record<string, unknown>; incoming: IncomingMessage; routes: Route[] };

/** Posts `payload` as `actor` into `where`, then reads it back as the gateway would deliver it and routes it. `task` is the task of that thread (if any). */
export async function roundTrip(actor: ActorRef, where: { channelId: string; threadId?: string }, payload: OutboundPayload, o: { task?: Task | null; popts?: PostOptions } = {}): Promise<Posted> {
  const wk = fakeChannel(CH.work);
  const th = fakeChannel(CH.thread, { thread: CH.work });
  const room = fakeChannel(CH.room);
  const rt = fakeChannel(CH.roomThread, { thread: CH.room });
  const chans = [wk, th, room, rt];
  const clients = new Map<string, Client>(['hq', 'software', 'finance'].map((d) => [d, fakeRestClient(BOT[d]!, chans)]));
  const port = createDiscordPort({ client: (d) => clients.get(d) }, new WebhookSender(repo), { dept, persona: (id) => (id === PERSONA.id ? PERSONA : null) }, {
    guildId: GUILD, adminRoleId: '1565000000000000001', inbound: async (m: Message) => ({ id: m.id }) as never, botUserIds: () => new Map(Object.entries(BOT).map(([d, id]) => [id, d as DeptId])),
  });
  await port.post(actor, where, payload, o.popts);
  const chan = [wk, th, room, rt].find((c) => c.id === (where.threadId ?? where.channelId))!;
  const hook = room.created[0];
  const sent = (actor.kind === 'persona' ? hook!.sent[hook!.sent.length - 1] : chan.sent[chan.sent.length - 1]) as Record<string, unknown>;
  const threadMode = where.threadId !== undefined;
  const isPersona = actor.kind === 'persona';
  const ctx: InboundCtx = {
    guildId: GUILD, adminRoleId: '1565000000000000001', botUserIds: new Map(Object.entries(BOT).map(([d, id]) => [id, d as DeptId])),
    webhooks: new Map(hook ? [[hook.id, { applicationId: BOT.software!, deptId: 'software' as DeptId }]] : []),
    personaByName: (d, name) => (d === 'software' && name === PERSONA.name ? PERSONA.id : null),
  };
  const author = isPersona ? { id: hook!.id, username: PERSONA.name, bot: true, globalName: null } : { id: BOT[(actor as { dept: string }).dept]!, username: 'bot', bot: true, globalName: null };
  const message = {
    id: '1570000000000009999', guildId: GUILD, channelId: where.threadId ?? where.channelId,
    channel: { id: where.threadId ?? where.channelId, isThread: () => threadMode, parentId: threadMode ? where.channelId : 'cat', partial: false },
    author, member: null, webhookId: isPersona ? hook!.id : null, applicationId: isPersona ? BOT.software : null,
    content: (sent.content as string | undefined) ?? '', mentions: { users: new Map() }, attachments: new Map(), embeds: (sent.embeds as unknown[]) ?? [], system: false, reference: null,
  } as unknown as Message;
  const incoming = toIncoming(message, ctx)!;
  const routes = await route(incoming, { org: routerOrg, taskByThread: async () => o.task ?? null });
  return { sent, incoming, routes };
}
