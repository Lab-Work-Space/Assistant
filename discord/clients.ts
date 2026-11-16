import { Client, Events, GatewayIntentBits, Partials, type ClientOptions, type Guild, type Interaction, type Message } from 'discord.js';
import type { DeptId } from '../core/index.js';
import { Dedupe } from './dedupe.js';
import { checkGuildPermissions } from './perm/permissions.js';

/** Shared by every client, exactly these (Gate 1 D19): no GuildMembers, no GuildVoiceStates. Member roles come with each guild message. Praw adds GuildVoiceStates on her own client only (clientOptionsFor, P17). */
export const INTENTS: readonly GatewayIntentBits[] = [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent];

/**
 * Default options for every head client: no mention is ever parsed unless a send overrides it (Gate 1 D11).
 * TW11: only `Partials.Channel` (messages in uncached forum posts and threads are not dropped); never Message, User, GuildMember or Reaction.
 * A partial or parentless thread is fetched before it is mapped, see `createInboundMapper`; it is dropped when that fails.
 */
export const CLIENT_OPTIONS: ClientOptions = { intents: [...INTENTS], allowedMentions: { parse: [] }, partials: [Partials.Channel] };

/** P17 (D19 amendment): Praw alone also gets GuildVoiceStates, for voice; the shared INTENTS never change. */
export function clientOptionsFor(dept: DeptId): ClientOptions {
  return { ...CLIENT_OPTIONS, intents: dept === 'praw' ? [...INTENTS, GatewayIntentBits.GuildVoiceStates] : [...INTENTS] };
}

type Log = { info(o: object, m?: string): void; warn(o: object, m?: string): void; error(o: object, m?: string): void };
const silent: Log = { info() {}, warn() {}, error() {} };

export interface ClientManagerOptions {
  guildId: string;
  logger?: Log;
  /** Test seam; defaults to a discord.js Client built with clientOptionsFor(dept). */
  createClient?: (dept: DeptId, options: ClientOptions) => Client;
  readyTimeoutMs?: number;
}

export interface StartResult {
  online: DeptId[];
  failed: { dept: DeptId; error: string }[];
  /** Clients turned off by the fail-closed permission check (Gate 1 D8); the caller posts an alert for each. */
  disabled: { dept: DeptId; warnings: string[] }[];
}

export type OnMessage = (m: Message, dept: DeptId) => void | Promise<void>;
export type OnInteraction = (i: Interaction) => void | Promise<void>;
/** R7: the second interaction path, wired to the `praw` client only; the config path is never attached there. */
export type OnPrawInteraction = OnInteraction;

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export class ClientManager {
  private readonly clients = new Map<DeptId, Client>();
  private readonly dedupe = new Dedupe();
  private readonly barred = new Set<DeptId>();
  private readonly log: Log;

  constructor(private readonly opts: ClientManagerOptions) {
    this.log = opts.logger ?? silent;
  }

  /** Logs every dept in parallel; one failing login does not stop the others. `hq` handles the config interactions, `praw` its own (R7). */
  async start(tokens: Partial<Record<DeptId, string>>, onMessage: OnMessage, onInteraction: OnInteraction, onPrawInteraction?: OnPrawInteraction): Promise<StartResult> {
    const result: StartResult = { online: [], failed: [], disabled: [] };
    const entries = Object.entries(tokens).filter((e): e is [DeptId, string] => !!e[1]);
    await Promise.all(entries.map(async ([dept, token]) => {
      if (this.barred.has(dept)) {
        // G2A-09: a client turned off for unsafe permissions is never brought back by a later start() in this process.
        result.disabled.push({ dept, warnings: [`${dept}: disabled earlier in this process for unsafe permissions`] });
        return;
      }
      const options = clientOptionsFor(dept);
      const client = this.opts.createClient?.(dept, options) ?? new Client(options);
      // discord.js `debug` events are never subscribed to (Gate 1 D10); errors are logged without payloads.
      client.on(Events.Error, (e) => this.log.warn({ dept, err: errText(e) }, 'discord client error'));
      try {
        const guild = await this.connect(client, token);
        const warnings = await checkGuildPermissions(client, dept, guild);
        if (warnings.length) {
          await Promise.resolve(client.destroy()).catch((e: unknown) => this.log.warn({ dept, err: errText(e) }, 'discord client destroy failed'));
          result.disabled.push({ dept, warnings });
          this.log.error({ dept, warnings }, 'discord client disabled: unsafe permissions');
          return;
        }
        this.attach(client, dept, onMessage, onInteraction, onPrawInteraction);
        this.clients.set(dept, client);
        result.online.push(dept);
      } catch (e) {
        await Promise.resolve(client.destroy()).catch(() => {});
        result.failed.push({ dept, error: errText(e) });
        this.log.warn({ dept, err: errText(e) }, 'discord login failed');
      }
    }));
    return result;
  }

  private async connect(client: Client, token: string): Promise<Guild> {
    const timeout = this.opts.readyTimeoutMs ?? 30_000;
    let timer: NodeJS.Timeout | undefined;
    const ready = new Promise<void>((resolve, reject) => {
      client.once(Events.ClientReady, () => resolve());
      timer = setTimeout(() => reject(new Error(`not ready after ${timeout} ms`)), timeout);
    });
    try {
      // both awaited together, so a timeout during a hanging login is never an unhandled rejection
      await Promise.all([client.login(token), ready]);
    } finally {
      clearTimeout(timer);
    }
    const guild = client.guilds.cache.get(this.opts.guildId) ?? (await client.guilds.fetch(this.opts.guildId).catch(() => null));
    if (!guild) throw new Error(`bot is not a member of guild ${this.opts.guildId}`);
    // members.me may be uncached right after ready; without it the permission check would disable the dept
    if (!guild.members.me && typeof guild.members.fetchMe === 'function') await guild.members.fetchMe().catch(() => null);
    return guild;
  }

  /** Listeners are attached only after the permission check passes. */
  private attach(client: Client, dept: DeptId, onMessage: OnMessage, onInteraction: OnInteraction, onPraw?: OnPrawInteraction): void {
    const guard = (what: string, fn: () => void | Promise<void>) => {
      const fail = (e: unknown) => this.log.error({ dept, err: errText(e) }, `${what} handler failed`);
      try {
        Promise.resolve(fn()).catch(fail);
      } catch (e) {
        fail(e);
      }
    };
    client.on(Events.MessageCreate, (m) => {
      if (m.guildId !== this.opts.guildId || this.dedupe.seen(m.id)) return;
      guard('message', () => onMessage(m, dept));
    });
    const handler = dept === 'hq' ? onInteraction : dept === 'praw' ? onPraw : undefined;
    if (handler) {
      client.on(Events.InteractionCreate, (i) => {
        if (i.guildId !== this.opts.guildId) return; // Gate 1 D5
        guard('interaction', () => handler(i));
      });
    }
  }

  /**
   * Turns one client off for good (Gate 1 C21): destroyed, dropped from the map, never re-created in this process (no reconnect loop).
   * Returns the warnings it was disabled with so the caller can alert; false when the client was not online.
   */
  async disable(dept: DeptId, warnings: string[]): Promise<boolean> {
    const client = this.clients.get(dept);
    if (!client) return false;
    this.clients.delete(dept);
    this.barred.add(dept);
    await Promise.resolve(client.destroy()).catch((e: unknown) => this.log.warn({ dept, err: errText(e) }, 'discord client destroy failed'));
    this.log.error({ dept, warnings }, 'discord client disabled: unsafe permissions');
    return true;
  }

  /** True once `disable` turned this department off. */
  isBarred(dept: DeptId): boolean {
    return this.barred.has(dept);
  }

  /**
   * Gate 1 C21 live re-check: the boot permission check again for every online client, on freshly fetched data (not the gateway cache).
   * A client that fails it, or whose check cannot be completed, is disabled. Returns the departments disabled now.
   */
  async recheck(): Promise<{ dept: DeptId; warnings: string[] }[]> {
    const out: { dept: DeptId; warnings: string[] }[] = [];
    for (const [dept, client] of [...this.clients]) {
      let warnings: string[];
      try {
        const guild = client.guilds.cache.get(this.opts.guildId) ?? (await client.guilds.fetch(this.opts.guildId));
        warnings = await checkGuildPermissions(client, dept, guild, { fresh: true });
      } catch (e) {
        warnings = [`${dept}: permission re-check failed (${errText(e).slice(0, 80)}); cannot verify`];
      }
      if (warnings.length && (await this.disable(dept, warnings))) out.push({ dept, warnings });
    }
    return out;
  }

  client(dept: DeptId): Client | undefined {
    return this.clients.get(dept);
  }

  online(): DeptId[] {
    return [...this.clients.keys()];
  }

  botUserIds(): Map<string, DeptId> {
    const out = new Map<string, DeptId>();
    for (const [dept, c] of this.clients) if (c.user) out.set(c.user.id, dept);
    return out;
  }

  async stop(): Promise<void> {
    const all = [...this.clients.values()];
    this.clients.clear();
    await Promise.all(all.map((c) => Promise.resolve(c.destroy()).catch(() => {})));
  }
}
