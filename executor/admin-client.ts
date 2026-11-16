import { Client, Events, GatewayIntentBits, Options, Sweepers, type ClientOptions, type Guild } from 'discord.js';
import { ADMIN_EXECUTOR_ID, checkGuildPermissions } from '../discord/perm/permissions.js';

/**
 * The executor's Discord client ("LW Admin", Gate 1 S3, S8). It is NOT a department: no org entry, no routing, no model path, and no
 * MessageCreate or InteractionCreate listener is ever attached to it. Intents are exactly Guilds + GuildMembers (the owner turns on Server
 * Members Intent for this application only; no Message Content, no presence).
 */
export const ADMIN_INTENTS: readonly GatewayIntentBits[] = [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers];

/** S8: a capped member cache and no presence or message caches (member data is PII; it is never written to the database except as ids). */
export const ADMIN_CACHE_LIMITS = { ...Options.DefaultMakeCacheSettings, GuildMemberManager: 200, PresenceManager: 0, MessageManager: 0, GuildMessageManager: 0, ReactionManager: 0, ReactionUserManager: 0, ThreadMemberManager: 0 } as const;

export function adminClientOptions(): ClientOptions {
  return {
    intents: [...ADMIN_INTENTS],
    allowedMentions: { parse: [] },
    makeCache: Options.cacheWithLimits(ADMIN_CACHE_LIMITS),
    sweepers: { ...Options.DefaultSweeperSettings, guildMembers: { interval: 300, filter: Sweepers.filterByLifetime({ lifetime: 600 }) }, users: { interval: 300, filter: Sweepers.filterByLifetime({ lifetime: 600 }) } },
  };
}

type Log = { info(o: object, m?: string): void; warn(o: object, m?: string): void; error(o: object, m?: string): void };
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export interface AdminStart {
  ok: boolean;
  userId?: string;
  /** Why the executor stays off (unsafe permissions or a failed login). */
  problems: string[];
}

/** One login, one fail-closed permission check (S4). A client that fails it is destroyed and never brought back in this process (G2A-09). */
export class AdminClient {
  private client: Client | undefined;
  private barred: string[] | null = null;

  constructor(private readonly o: { guildId: string; log: Log; createClient?: (options: ClientOptions) => Client; readyTimeoutMs?: number }) {}

  async start(token: string): Promise<AdminStart> {
    if (this.barred) return { ok: false, problems: this.barred };
    const client = this.o.createClient?.(adminClientOptions()) ?? new Client(adminClientOptions());
    client.on(Events.Error, (e) => this.o.log.warn({ err: errText(e) }, 'executor client error'));
    try {
      const guild = await this.connect(client, token);
      const warnings = await checkGuildPermissions(client, ADMIN_EXECUTOR_ID, guild);
      if (warnings.length) {
        await Promise.resolve(client.destroy()).catch(() => undefined);
        this.barred = warnings;
        this.o.log.error({ warnings }, 'executor disabled: unsafe permissions');
        return { ok: false, problems: warnings };
      }
      this.client = client;
      return { ok: true, ...(client.user ? { userId: client.user.id } : {}), problems: [] };
    } catch (e) {
      await Promise.resolve(client.destroy()).catch(() => undefined);
      this.o.log.warn({ err: errText(e) }, 'executor login failed');
      return { ok: false, problems: ['login failed'] };
    }
  }

  private async connect(client: Client, token: string): Promise<Guild> {
    const timeout = this.o.readyTimeoutMs ?? 30_000;
    let timer: NodeJS.Timeout | undefined;
    const ready = new Promise<void>((resolve, reject) => {
      client.once(Events.ClientReady, () => resolve());
      timer = setTimeout(() => reject(new Error(`not ready after ${timeout} ms`)), timeout);
    });
    try {
      await Promise.all([client.login(token), ready]);
    } finally {
      clearTimeout(timer);
    }
    const guild = client.guilds.cache.get(this.o.guildId) ?? (await client.guilds.fetch(this.o.guildId).catch(() => null));
    if (!guild) throw new Error(`the executor is not a member of guild ${this.o.guildId}`);
    if (!guild.members.me && typeof guild.members.fetchMe === 'function') await guild.members.fetchMe().catch(() => null);
    return guild;
  }

  get(): Client | undefined {
    return this.client;
  }

  /** C21 on the executor itself: the boot check on freshly fetched data. Warnings disable it for good. */
  async recheck(): Promise<string[]> {
    const c = this.client;
    if (!c) return this.barred ?? ['the executor is offline'];
    let warnings: string[];
    try {
      const guild = c.guilds.cache.get(this.o.guildId) ?? (await c.guilds.fetch(this.o.guildId));
      warnings = await checkGuildPermissions(c, ADMIN_EXECUTOR_ID, guild, { fresh: true });
    } catch (e) {
      warnings = [`admin: permission re-check failed (${errText(e).slice(0, 80)}); cannot verify`];
    }
    if (warnings.length) await this.disable(warnings);
    return warnings;
  }

  async disable(warnings: string[]): Promise<void> {
    const c = this.client;
    this.client = undefined;
    this.barred = warnings;
    if (c) await Promise.resolve(c.destroy()).catch(() => undefined);
    this.o.log.error({ warnings }, 'executor disabled: unsafe permissions');
  }

  isBarred(): string[] | null {
    return this.barred;
  }

  async stop(): Promise<void> {
    const c = this.client;
    this.client = undefined;
    if (c) await Promise.resolve(c.destroy()).catch(() => undefined);
  }
}
