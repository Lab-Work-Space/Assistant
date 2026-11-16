import { EventEmitter } from 'node:events';
import { GatewayIntentBits, PermissionFlagsBits, type Client } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';
import { ADMIN_CACHE_LIMITS, ADMIN_INTENTS, AdminClient, adminClientOptions } from './admin-client.js';
import { ADMIN_EXTRA_BITS } from '../discord/perm/perm-bits.js';
import { ClientManager, clientOptionsFor } from '../discord/clients.js';
import { DEPT_IDS } from '../core/index.js';
import { fakeClient, fakeGuild } from '../tests/fakes/discordClient.js';
import { loadExecutorEnv } from './env.js';
import { loadEnv } from '../core/env.js';

const GUILD = '1565649426943442944';
const F = PermissionFlagsBits;
const mk = (guild: ReturnType<typeof fakeGuild>) => new AdminClient({ guildId: GUILD, log: { info() {}, warn() {}, error() {} }, createClient: () => fakeClient({ userId: 'adminbot', guild }) as Client });

describe('the executor client (S3, S8)', () => {
  it('S3: intents are exactly Guilds + GuildMembers, no mention is ever parsed, and it is not a department', () => {
    expect([...ADMIN_INTENTS].sort()).toEqual([GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers].sort());
    expect(adminClientOptions().intents).toEqual([...ADMIN_INTENTS]);
    expect(adminClientOptions().allowedMentions).toEqual({ parse: [] });
    expect((DEPT_IDS as readonly string[]).includes('admin')).toBe(false);
    expect(clientOptionsFor('praw').intents).not.toContain(GatewayIntentBits.GuildMembers); // Praw and the department bots keep D19 unchanged
  });
  it('S3: the ClientManager has no "admin" client, and no MessageCreate or InteractionCreate listener is attached by AdminClient.start', async () => {
    const cm = new ClientManager({ guildId: GUILD, createClient: () => fakeClient({ userId: 'x', guild: fakeGuild() }) });
    expect(cm.client('admin' as never)).toBeUndefined();
    const guild = fakeGuild({ guildWide: [F.ViewChannel, ...ADMIN_EXTRA_BITS] });
    const fake = fakeClient({ userId: 'adminbot', guild }) as unknown as EventEmitter;
    const a = new AdminClient({ guildId: GUILD, log: { info() {}, warn() {}, error() {} }, createClient: () => fake as unknown as Client });
    expect((await a.start('token')).ok).toBe(true);
    expect(fake.listenerCount('messageCreate')).toBe(0);
    expect(fake.listenerCount('interactionCreate')).toBe(0);
  });
  it('S8: the member cache is capped, presences and message caches are off, sweepers run', () => {
    expect(ADMIN_CACHE_LIMITS).toMatchObject({ GuildMemberManager: 200, PresenceManager: 0, MessageManager: 0, GuildMessageManager: 0 });
    const o = adminClientOptions();
    expect(typeof o.makeCache).toBe('function');
    expect(o.sweepers?.guildMembers).toMatchObject({ interval: 300 });
  });
});

describe('the executor boot check (S4)', () => {
  it('starts with exactly the spec bits; an extra bit disables it for good (no restart in this process)', async () => {
    const ok = mk(fakeGuild({ guildWide: [F.ViewChannel, F.SendMessages, ...ADMIN_EXTRA_BITS] }));
    expect(await ok.start('t')).toMatchObject({ ok: true, userId: 'adminbot' });
    for (const bit of [F.Administrator, F.ManageWebhooks, F.MentionEveryone]) {
      const a = mk(fakeGuild({ guildWide: [...ADMIN_EXTRA_BITS, bit] }));
      const r = await a.start('t');
      expect(r.ok).toBe(false);
      expect(r.problems[0]).toMatch(/not allowed/);
      expect(a.isBarred()).not.toBeNull();
      expect((await a.start('t')).ok).toBe(false); // G2A-09: never brought back
    }
  });
  it('able to view a DENIED channel disables it', async () => {
    const a = mk(fakeGuild({ guildWide: [...ADMIN_EXTRA_BITS], viewable: ['1565715069969502310'] }));
    expect((await a.start('t')).problems.join(' ')).toContain('1565715069969502310');
  });
  it('a stays-down probe (global rule 14): once disabled by a re-check it stays disabled across later checks and starts', async () => {
    const guild = fakeGuild({ guildWide: [...ADMIN_EXTRA_BITS] });
    const a = mk(guild);
    await a.start('t');
    expect(await a.recheck()).toEqual([]);
    (guild as unknown as { members: { me: { permissions: { bitfield: bigint } } } }).members.me.permissions = { bitfield: F.Administrator } as never;
    const w = await a.recheck();
    expect(w.join(' ')).toMatch(/Administrator/);
    for (let i = 0; i < 3; i++) {
      expect((await a.recheck()).length).toBeGreaterThan(0);
      expect((await a.start('t')).ok).toBe(false);
    }
    expect(a.get()).toBeUndefined();
  });
  it('Gate rule 14: after a disable the executor stays down for 60 s of timers, with its own reconnect loop given every chance (no login, no client)', async () => {
    vi.useFakeTimers();
    try {
      const guild = fakeGuild({ guildWide: [...ADMIN_EXTRA_BITS] });
      const fake = fakeClient({ userId: 'adminbot', guild });
      let logins = 0;
      const login = fake.login.bind(fake);
      fake.login = async (t?: string) => { logins++; return login(t); };
      const a = new AdminClient({ guildId: GUILD, log: { info() {}, warn() {}, error() {} }, createClient: () => fake as Client });
      const started = a.start('t');
      await vi.advanceTimersByTimeAsync(10);
      expect((await started).ok).toBe(true);
      (guild as unknown as { members: { me: { permissions: { bitfield: bigint } } } }).members.me.permissions = { bitfield: F.Administrator } as never;
      expect((await a.recheck()).length).toBeGreaterThan(0);
      const before = logins;
      for (let t = 0; t < 12; t++) {
        await vi.advanceTimersByTimeAsync(5000); // 12 x 5 s = 60 s
        fake.fire('shardDisconnect'); // the gateway drops: a reconnect loop would log in again
        expect(a.get()).toBeUndefined();
        expect(a.isBarred()).not.toBeNull();
      }
      expect(logins).toBe(before);
      expect((fake as unknown as { destroyed: boolean }).destroyed).toBe(true);
      expect((await a.start('t')).ok).toBe(false);
      expect(logins).toBe(before);
    } finally {
      vi.useRealTimers();
    }
  });
  it('a failed login reports a problem without throwing', async () => {
    const a = new AdminClient({ guildId: GUILD, log: { info() {}, warn() {}, error() {} }, createClient: () => fakeClient({ userId: 'x', failLogin: true }) as Client });
    expect(await a.start('bad')).toEqual({ ok: false, problems: ['login failed'] });
  });
});

describe('S2/S6: the token lives in the executor\'s environment only', () => {
  const base = { DATABASE_URL: 'postgres://x', BOT_ADMIN_ROLE_ID: '1566025466274512988', EXECUTOR_SOCKET: '/tmp/e.sock' };
  it('the executor loads its token, and refuses any other bot token or provider secret in its environment', () => {
    expect(loadExecutorEnv({ ...base, BOT_TOKEN_ADMIN: 'x'.repeat(30) })).toMatchObject({ token: 'x'.repeat(30), socketPath: '/tmp/e.sock' });
    expect(() => loadExecutorEnv({ ...base, BOT_TOKEN_ADMIN: 'x'.repeat(30), BOT_TOKEN_HQ: 'y'.repeat(30) })).toThrow(/another bot token/);
    for (const k of ['ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'CONFIG_MASTER_KEY']) expect(() => loadExecutorEnv({ ...base, BOT_TOKEN_ADMIN: 'x'.repeat(30), [k]: 'v' })).toThrow(new RegExp(k));
    expect(() => loadExecutorEnv({ ...base })).toThrow(/BOT_TOKEN_ADMIN/);
    expect(() => loadExecutorEnv({ ...base, BOT_TOKEN_ADMIN: 'x'.repeat(30), EXECUTOR_SOCKET: 'relative.sock' })).toThrow(/absolute/);
  });
  it('the main application refuses to start with BOT_TOKEN_ADMIN in its environment, and the error never contains the value', () => {
    const main = { DATABASE_URL: 'postgres://x', CONFIG_MASTER_KEY: Buffer.alloc(32, 1).toString('base64'), BOT_ADMIN_ROLE_ID: '1566025466274512988' };
    expect(loadEnv(main).botTokens).toEqual({});
    const secret = 'PLANTED-ADMIN-TOKEN-VALUE-0123456789';
    let msg = '';
    try { loadEnv({ ...main, BOT_TOKEN_ADMIN: secret }); } catch (e) { msg = (e as Error).message; }
    expect(msg).toMatch(/BOT_TOKEN_ADMIN belongs to the separate executor/);
    expect(msg).not.toContain(secret);
    expect(loadEnv({ ...main, EXECUTOR_SOCKET: '/tmp/e.sock' }).executorSocket).toBe('/tmp/e.sock');
    expect(() => loadEnv({ ...main, EXECUTOR_SOCKET: 'rel' })).toThrow();
  });
  it('a planted BOT_TOKEN_ADMIN cannot reach a child process and is masked in logs', async () => {
    const { childEnv } = await import('../core/child-env.js');
    expect(() => childEnv({ BOT_TOKEN_ADMIN: 'x' })).toThrow(/may not be passed/);
    const { redactText } = await import('../core/logger.js');
    const tok = 'MTIzNDU2Nzg5MDEyMzQ1Njc4.GabcDE.abcdefghijklmnopqrstuvwxyz0123456789';
    expect(redactText(`BOT_TOKEN_ADMIN=${tok}`)).not.toContain(tok);
  });
});
