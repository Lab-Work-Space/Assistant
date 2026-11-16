import { PermissionFlagsBits, type Client, type Webhook } from 'discord.js';
import type { DeptId } from '../core/index.js';
import type { Persona, PersonaWebhookRepo } from '../db/repos/index.js';
import type { OutboundMessage } from './embeds/index.js';
import type { KnownWebhook } from './inbound.js';

export const PERSONA_WEBHOOK_NAME = 'assistant-personas';

export type WebhookRepo = Pick<PersonaWebhookRepo, 'getByChannel' | 'getByWebhookId' | 'upsert'>;

type Entry = { dept: DeptId; hook: Webhook };

const UNKNOWN_WEBHOOK = 10015;

/**
 * Persona messages go through one webhook per parent channel, created lazily by the persona's head client
 * and persisted with that head's application id (Gate 1 D6). Webhooks are matched by persisted id only,
 * never by name; an unknown `assistant-personas` webhook is ignored and a new one is created.
 */
export class WebhookSender {
  private readonly byChannel = new Map<string, Promise<Entry>>();
  private readonly known = new Map<string, KnownWebhook>();
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(private readonly repo: WebhookRepo) {}

  /** Sends `msgs` in order as `persona`; returns the first message id. */
  async send(persona: Persona, headClient: Client, channelId: string, threadId: string | undefined, msgs: OutboundMessage[], onSent?: (ids: string[]) => void): Promise<string> {
    const dept = persona.deptId as DeptId;
    const { hook } = await this.resolve(dept, headClient, channelId);
    return this.enqueue(hook.id, async () => {
      const ids: string[] = [];
      try {
        for (const m of msgs) {
          const sent = await hook.send({ ...m, username: persona.name, avatarURL: persona.avatarUrl ?? undefined, threadId });
          ids.push(sent.id);
        }
      } catch (e) {
        if ((e as { code?: unknown }).code === UNKNOWN_WEBHOOK) this.byChannel.delete(channelId);
        throw e;
      } finally {
        if (ids.length) onSent?.(ids);
      }
      return ids[0]!;
    });
  }

  /** TW17: edits a message this persona webhook posted (a webhook can edit only its own messages). Errors, including Unknown Message (10008), propagate. */
  async edit(persona: Persona, headClient: Client, channelId: string, threadId: string | undefined, messageId: string, msg: OutboundMessage): Promise<void> {
    const { hook } = await this.resolve(persona.deptId as DeptId, headClient, channelId);
    await this.enqueue(hook.id, async () => {
      await hook.editMessage(messageId, { ...(msg.content !== undefined ? { content: msg.content } : {}), embeds: msg.embeds, components: msg.components, allowedMentions: { parse: [] }, ...(threadId ? { threadId } : {}) } as never);
    });
  }

  /** Our persona webhook with this id (cache, then the persisted row), or null. */
  async lookup(webhookId: string): Promise<KnownWebhook | null> {
    const hit = this.known.get(webhookId);
    if (hit) return hit;
    const row = await this.repo.getByWebhookId(webhookId);
    if (!row) return null;
    return this.register(row.webhookId, row.applicationId, row.deptId);
  }

  /** Webhooks known so far, for `toIncoming`. */
  knownWebhooks(): ReadonlyMap<string, KnownWebhook> {
    return this.known;
  }

  private register(webhookId: string, applicationId: string, deptId: DeptId): KnownWebhook {
    const k = { applicationId, deptId };
    this.known.set(webhookId, k);
    return k;
  }

  private async resolve(dept: DeptId, client: Client, channelId: string): Promise<Entry> {
    let p = this.byChannel.get(channelId);
    if (!p) {
      p = this.load(dept, client, channelId);
      this.byChannel.set(channelId, p);
      p.catch(() => this.byChannel.delete(channelId));
    }
    const entry = await p;
    if (entry.dept !== dept) throw new Error(`persona webhook of channel ${channelId} belongs to ${entry.dept}, not ${dept}`);
    return entry;
  }

  private async load(dept: DeptId, client: Client, channelId: string): Promise<Entry> {
    const appId = client.application?.id ?? client.user?.id;
    if (!appId || !client.user) throw new Error(`${dept} head client is not ready`);
    const ch = await client.channels.fetch(channelId);
    if (!ch || ch.isThread() || !('createWebhook' in ch)) throw new Error(`channel ${channelId} cannot host persona webhooks`);
    if (!ch.permissionsFor(client.user)?.has(PermissionFlagsBits.ManageWebhooks)) {
      throw new Error(`${dept} head lacks Manage Webhooks on channel ${channelId}; persona messages there are refused`);
    }
    const row = await this.repo.getByChannel(channelId);
    if (row && row.deptId !== dept) throw new Error(`persona webhook of channel ${channelId} belongs to ${row.deptId}, not ${dept}`);
    if (row && row.applicationId === appId) {
      const hook = (await ch.fetchWebhooks()).get(row.webhookId);
      if (hook?.token) {
        this.register(hook.id, appId, dept);
        return { dept, hook };
      }
    }
    const hook = await ch.createWebhook({ name: PERSONA_WEBHOOK_NAME, reason: 'persona messages' });
    await this.repo.upsert({ channelId, webhookId: hook.id, applicationId: appId, deptId: dept });
    this.register(hook.id, appId, dept);
    return { dept, hook };
  }

  private enqueue<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const next = (this.queues.get(key) ?? Promise.resolve()).catch(() => {}).then(fn);
    this.queues.set(key, next.catch(() => {}));
    return next;
  }
}
