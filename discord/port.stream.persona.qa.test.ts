import type { Client, Message } from 'discord.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DeptId } from '../core/index.js';
import type { Department, Persona } from '../db/repos/index.js';
import { EDIT_INTERVAL_MS, ELLIPSIS } from '../agents/stream/stream-holdback.js';
import { fakeChannel, fakeRestClient } from '../tests/fakes/discordClient.js';
import { createDiscordPort, type PortOrg } from './port.js';
import { WebhookSender, type WebhookRepo } from './webhooks.js';

/** STREAM-1 tester: the persona webhook path (not covered by the backend suite): create via hook.send, edits via hook.editMessage, final, long final, routable final. */
const ROOM = '1570000000000000301';
const sw: Department = { id: 'software', name: 'Software', categoryNamePattern: 'soft', workChannelId: '1570000000000000300', color: 0x123456, model: null, provider: null, enabled: true };
const sa: Persona = { id: 'system-analyst', deptId: 'software', name: 'System Analyst', avatarUrl: null, promptRef: 'x', model: null, provider: null, tools: [], directChannelId: ROOM, enabled: true };
const org: PortOrg = { dept: (id) => (id === 'software' ? sw : null), persona: (id) => (id === sa.id ? sa : null) };
const actor = { kind: 'persona' as const, personaId: sa.id };
const repo: WebhookRepo = { getByChannel: async () => null, getByWebhookId: async () => null, upsert: async () => undefined };
const WORDS = 'alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa quebec romeo sierra tango uniform victor whiskey xray yankee zulu ';

function world(secrets: string[] = []) {
  const ch = fakeChannel(ROOM);
  const sent: Record<string, unknown>[] = [];
  const edits: { id: string; body: Record<string, unknown> }[] = [];
  let n = 0;
  const hook = {
    id: 'hook-1', token: 'tok', name: 'assistant-personas',
    send: async (m: Record<string, unknown>) => { sent.push(m); return { id: `157000000000009${String(++n).padStart(3, '0')}` }; },
    editMessage: async (id: string, b: Record<string, unknown>) => { edits.push({ id, body: b }); },
  };
  (ch as unknown as { createWebhook: () => Promise<unknown> }).createWebhook = async () => hook;
  const typing = { n: 0 };
  (ch as unknown as { sendTyping: () => Promise<void> }).sendTyping = async () => { typing.n++; };
  const client = fakeRestClient('app-sw', [ch]);
  const port = createDiscordPort({ client: () => client as Client }, new WebhookSender(repo), org, {
    guildId: '1565649426943442944', adminRoleId: '1565000000000000001', inbound: async (m: Message) => ({ id: m.id }) as never, secrets,
    botUserIds: () => new Map<string, DeptId>(), log: { info: () => undefined, warn: () => undefined },
  });
  return { port, ch, hook, sent, edits, typing };
}
const open = (port: ReturnType<typeof world>['port'], replyToId?: string) => {
  const rs = port.openReplyStream!(actor, { channelId: ROOM }, { halted: () => false, ...(replyToId ? { replyToId } : {}) });
  if (!rs) throw new Error('persona stream refused in its own room');
  return rs;
};
const tick = (ms = EDIT_INTERVAL_MS + 100) => vi.advanceTimersByTimeAsync(ms);
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('persona stream over the webhook', () => {
  it('no typing (webhooks cannot type), create by webhook with the persona name, no reply, edits by editMessage with parse [], masked and defanged', async () => {
    const w = world(['PersonaSecretLit9']);
    const rs = open(w.port, '1570000000000009999');
    rs.typing();
    await tick(100);
    expect(w.typing.n).toBe(0);
    const body = `${WORDS}<@12345678901234567> @everyone @CTO then PersonaSecretLit9 and key=Zq81Xw0Pl9MnQ plus more words here for length.`;
    for (let i = 30; i <= body.length; i += 9) { rs.update(body.slice(0, i)); await tick(EDIT_INTERVAL_MS + 10); }
    expect(w.sent).toHaveLength(1);
    expect(w.sent[0]).toMatchObject({ username: 'System Analyst' });
    expect(w.sent[0]).not.toHaveProperty('reply');
    expect(String(w.sent[0]!.content)).toContain(`${ELLIPSIS}\n-# Software · System Analyst`); // the persona caption line follows the marker
    expect(w.edits.length).toBeGreaterThan(0);
    for (const e of w.edits) expect((e.body.allowedMentions as { parse: unknown[] }).parse).toEqual([]);
    const shown = [String(w.sent[0]!.content), ...w.edits.map((e) => String(e.body.content))].join('\n');
    expect(shown).not.toMatch(/PersonaSecretLit9|PersonaSec|Zq81|Xw0P/);
    expect(shown).not.toMatch(/(?<!‍)@everyone|<@\d+>/);
    expect(shown).not.toMatch(/(?<!‍)@CTO/); // preview never carries a live handle
    await rs.release();
  });

  it('finalize edits the webhook preview in place and returns its id; a long final adds the rest through the webhook', async () => {
    const w = world();
    const rs = open(w.port);
    rs.update(WORDS.repeat(2));
    await tick(500);
    expect(w.sent).toHaveLength(1);
    const ids: string[][] = [];
    const long = Array.from({ length: 120 }, (_, i) => `Line ${i} of the long persona answer.`).join(' ');
    expect(long.length).toBeGreaterThan(2000);
    const id = await rs.finalize({ type: 'chat', body: long }, { onSent: (x) => ids.push(x) });
    expect(id).toBe('157000000000009001');
    expect(w.edits.at(-1)!.id).toBe(id);
    expect(String(w.edits.at(-1)!.body.content).length).toBeLessThanOrEqual(2000);
    expect(w.sent.length).toBeGreaterThanOrEqual(2);
    expect(ids).toHaveLength(1);
    expect(ids[0]!.length).toBe(w.sent.length); // preview + every later chunk recorded as the answer
    expect(ids[0]![0]).toBe(id);
  });

  it('a final with a live handle goes out as a fresh webhook post and the preview becomes the pointer', async () => {
    const w = world();
    const rs = open(w.port);
    rs.update(WORDS.repeat(2));
    await tick(500);
    const ids: string[][] = []; const code: string[][] = [];
    const id = await rs.finalize({ type: 'chat', body: 'Hand over to @CTO now please.' }, { onSent: (x) => ids.push(x), onCode: (x) => code.push(x) });
    expect(w.sent).toHaveLength(2);
    expect(String(w.sent[1]!.content)).toContain('Hand over to');
    expect(id).not.toBe('157000000000009001');
    expect(String(w.edits.at(-1)!.body.content).startsWith('-# (answer posted below)')).toBe(true);
    expect(ids.flat()).toContain(id as string);
    expect(code.flat()).toEqual(['157000000000009001']);
  });

  it('edits are throttled: a fast producer (every 100 ms for 9 s) yields at most one write per 1.5 s', async () => {
    const w = world();
    const rs = open(w.port);
    const text = WORDS.repeat(40);
    for (let i = 0; i < 90; i++) { rs.update(text.slice(0, 60 + i * 40)); await vi.advanceTimersByTimeAsync(100); }
    const writes = w.sent.length + w.edits.length;
    expect(writes).toBeGreaterThanOrEqual(3);
    expect(writes).toBeLessThanOrEqual(1 + Math.floor(9000 / EDIT_INTERVAL_MS)); // the create plus one edit per interval
    await rs.release();
  });
});
