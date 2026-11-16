import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { attachConfirmListener, discordConfirmPort, type ConfirmClient } from './confirm-discord.js';
import { SecondConfirm } from './confirm.js';

const USER = '900000000000000001';
const CHAN = '1565667791938387969';
const TOKEN = 'ab'.repeat(16);

function fakeClient(o: { dm?: 'ok' | 'fail'; channel?: 'ok' | 'fail' | 'missing' } = {}) {
  const sent: { where: string; body: Record<string, unknown> }[] = [];
  const ee = new EventEmitter();
  const client = {
    users: { fetch: async () => ({ send: async (b: Record<string, unknown>) => { if (o.dm === 'fail') throw new Error('Cannot send messages to this user'); sent.push({ where: 'dm', body: b }); } }) },
    channels: { fetch: async () => (o.channel === 'missing' ? null : { isTextBased: () => true, send: async (b: Record<string, unknown>) => { if (o.channel === 'fail') throw new Error('Missing Permissions'); sent.push({ where: 'channel', body: b }); } }) },
    on: (e: string, f: (...a: never[]) => void) => ee.on(e, f as (...a: unknown[]) => void),
  } as unknown as ConfirmClient;
  return { client, sent, ee };
}
const send = (c: ConfirmClient) => discordConfirmPort(() => c).send({ userId: USER, channelId: CHAN, token: TOKEN, text: 'Do @everyone thing' });

describe('discordConfirmPort', () => {
  it('sends a DM with one danger button whose id carries the token, and no mentions', async () => {
    const f = fakeClient();
    expect(await send(f.client)).toBe('dm');
    const b = f.sent[0]!.body;
    expect(JSON.stringify(b.components)).toContain(`lwadmin2:${TOKEN}`);
    expect(b.allowedMentions).toEqual({ parse: [] });
    expect(String(b.content)).not.toContain('@everyone');
  });
  it('falls back to the channel with a mention of only that user when DMs are closed', async () => {
    const f = fakeClient({ dm: 'fail' });
    expect(await send(f.client)).toBe('channel');
    expect(f.sent[0]!.body.allowedMentions).toEqual({ parse: [], users: [USER] });
    expect(String(f.sent[0]!.body.content)).toContain(`<@${USER}>`);
  });
  it('null when neither works, and when there is no client', async () => {
    expect(await send(fakeClient({ dm: 'fail', channel: 'fail' }).client)).toBeNull();
    expect(await send(fakeClient({ dm: 'fail', channel: 'missing' }).client)).toBeNull();
    expect(await discordConfirmPort(() => undefined).send({ userId: USER, channelId: CHAN, token: TOKEN, text: 't' })).toBeNull();
  });
});

describe('attachConfirmListener', () => {
  const interaction = (customId: string, userId = USER, button = true) => {
    const calls: string[] = [];
    return { calls, i: { customId, user: { id: userId }, isButton: () => button, deferUpdate: async () => void calls.push('defer'), editReply: async () => void calls.push('edit'), followUp: async () => void calls.push('follow') } };
  };
  it('ignores everything but lwadmin2 buttons (no other interaction is ever answered)', async () => {
    const f = fakeClient();
    const confirm = { onClick: vi.fn(async () => ({ final: true, text: 'x' })) };
    attachConfirmListener(f.client, confirm, { error() {} });
    for (const [id, btn] of [['card:abc:confirm', true], [`lwadmin2:${TOKEN}`, false], ['', true]] as const) {
      const x = interaction(id, USER, btn);
      f.ee.emit('interactionCreate', x.i);
      await new Promise((r) => setTimeout(r, 5));
      expect(x.calls).toEqual([]);
    }
    expect(confirm.onClick).not.toHaveBeenCalled();
    expect(f.ee.listenerCount('messageCreate')).toBe(0);
  });
  it('acknowledges, passes Discord\'s own user id and token, and edits the message when final', async () => {
    const f = fakeClient();
    const confirm = { onClick: vi.fn(async () => ({ final: true, text: 'done' })) };
    attachConfirmListener(f.client, confirm, { error() {} });
    const x = interaction(`lwadmin2:${TOKEN}`, USER);
    f.ee.emit('interactionCreate', x.i);
    await vi.waitFor(() => expect(x.calls).toEqual(['defer', 'edit']));
    expect(confirm.onClick).toHaveBeenCalledWith({ token: TOKEN, userId: USER });
  });
  it('a non-final answer (wrong user) is an ephemeral follow-up that leaves the button for its owner', async () => {
    const f = fakeClient();
    attachConfirmListener(f.client, { onClick: async () => ({ final: false, text: 'not yours' }) }, { error() {} });
    const x = interaction(`lwadmin2:${TOKEN}`, '900000000000000002');
    f.ee.emit('interactionCreate', x.i);
    await vi.waitFor(() => expect(x.calls).toEqual(['defer', 'follow']));
  });
  it('end to end with the real SecondConfirm: only the right user\'s click runs the card', async () => {
    const f = fakeClient();
    const run = vi.fn(async () => ({ ok: true, lines: ['ok'] }));
    const sc = new SecondConfirm({ port: discordConfirmPort(() => f.client), audit: async () => undefined, log: { error() {} }, token: () => TOKEN });
    attachConfirmListener(f.client, sc, { error() {} });
    expect(await sc.request({ cardId: 'c'.repeat(32), userId: USER, channelId: CHAN, summary: 's', family: 'deploy', run, recheck: async () => null })).toMatchObject({ ok: true, where: 'dm' });
    const other = interaction(`lwadmin2:${TOKEN}`, '900000000000000002');
    f.ee.emit('interactionCreate', other.i);
    await vi.waitFor(() => expect(other.calls).toEqual(['defer', 'follow']));
    expect(run).not.toHaveBeenCalled();
    const mine = interaction(`lwadmin2:${TOKEN}`, USER);
    f.ee.emit('interactionCreate', mine.i);
    await vi.waitFor(() => expect(mine.calls).toEqual(['defer', 'edit']));
    expect(run).toHaveBeenCalledTimes(1);
  });
});
