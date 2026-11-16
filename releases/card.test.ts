import { describe, expect, it } from 'vitest';
import type { Message } from 'discord.js';
import type { DeptId } from '../core/index.js';
import type { Department } from '../db/repos/index.js';
import { toPayload } from '../agents/loop/payload.js';
import { RELEASE_CARD_ID, releaseCardRow } from '../discord/embeds/approval.js';
import { buildMessage } from '../discord/embeds/index.js';
import { createDiscordPort } from '../discord/port.js';
import { WebhookSender, type WebhookRepo } from '../discord/webhooks.js';
import { fakeChannel, fakeRestClient } from '../tests/fakes/discordClient.js';
import { ReleaseService, type ReleaseDeps } from './service.js';

const TOKEN = 'cd'.repeat(16);
const CTX = { deptColor: 1, adminRoleId: 'a', dept: 'software' } as never;

describe('R5 card plumbing: releaseCardId', () => {
  it('toPayload drops releaseCardId (and never lets a model produce the buttons)', () => {
    const out = toPayload({ type: 'approval', body: 'hi', releaseCardId: TOKEN, origin: 'governance' });
    expect(out).toEqual({ type: 'chat', body: 'hi' });
    expect(JSON.stringify(out)).not.toContain(TOKEN);
  });
  it('the custom id is anchored: exactly 32 lowercase hex and approve or reject', () => {
    expect(RELEASE_CARD_ID.exec(`relcard:${TOKEN}:approve`)?.[1]).toBe(TOKEN);
    for (const bad of [`relcard:${TOKEN}:approve:x`, `x relcard:${TOKEN}:approve`, `relcard:${TOKEN}:APPROVE`, `relcard:${'A'.repeat(32)}:approve`, `relcard:${'a'.repeat(31)}:approve`, `relcard:${TOKEN}:approve\n`, `relcard:${TOKEN}:delete`])
      expect(RELEASE_CARD_ID.test(bad)).toBe(false);
  });
  it('the row has Approve release and Reject with the token', () => {
    const row = releaseCardRow(TOKEN) as unknown as { components: { custom_id: string; label: string }[] };
    expect(row.components.map((c) => [c.custom_id, c.label])).toEqual([[`relcard:${TOKEN}:approve`, 'Approve release'], [`relcard:${TOKEN}:reject`, 'Reject']]);
  });
  it('buildMessage puts the row on the last message of an approval card with releaseCardId, and on nothing else', () => {
    const msgs = buildMessage({ type: 'approval', origin: 'governance', title: 'Release request', body: 'b', releaseCardId: TOKEN }, CTX);
    expect(JSON.stringify(msgs.at(-1)!.components)).toContain(`relcard:${TOKEN}:approve`);
    const plain = buildMessage({ type: 'approval', origin: 'governance', title: 'x', body: 'b' }, CTX);
    expect(JSON.stringify(plain.at(-1)!.components)).not.toContain('relcard');
  });
});

describe('RL-C8(d): the maximum release card is exactly one message', () => {
  it('the real service builds the worst case (escape-doubling title, summary, project title; 3 runs; every optional line) and buildMessage yields 1 message with the buttons', async () => {
    const ZIP = Buffer.from('z');
    const cards: Record<string, unknown>[] = [];
    const run = (n: number) => ({ verb: 'test' as const, result: 'timeout', at: `2026-11-12T0${n}:00:00.000000Z` });
    const deps = {
      repo: {
        openCounts: async () => ({ tree: 0, dept: 0, total: 0, today: 0 }), window: async () => ({ since: '2026-01-01T00:00:00.000000Z', until: '2026-01-02T00:00:00.000000Z' }),
        evidence: async () => ({ runs: [run(3), run(2), run(1)], writesAfterLastRun: true }), create: async () => ({ ok: true as const, id: 9_999_999_999, expiresAt: new Date('2026-12-01T00:00:00Z') }), setCard: async () => true,
      },
      ws: { export: async () => ({ zip: ZIP, files: 2000, sha256: 'f'.repeat(64), skipped: 100000 }) },
      projects: { byRoot: async () => ({ id: 99999, title: '*'.repeat(60), status: 'active' }) },
      enabled: () => true, wsEnabled: () => true, halted: () => false, tz: () => 'Asia/Bangkok', audit: async () => {}, secrets: [], configChannelId: '1565682159375749161', catalogDigest: 'd'.repeat(64),
      postCard: async (p: Record<string, unknown>) => { cards.push(p); return '800000000000000021'; }, postFile: async () => '800000000000000020', provenance: { record: async () => {} },
      closeCard: async () => {}, notifyHead: async () => {}, log: { error() {} }, newToken: () => TOKEN,
    } as unknown as ReleaseDeps;
    const res = await new ReleaseService(deps).request({ kind: 'head', dept: 'software' }, { tainted: true, task: { id: '1'.repeat(8) + '-1111-1111-1111-111111111111', rootId: 'abcdef01-2222-2222-2222-222222222222', tainted: true }, ownsTask: true, source: { channelId: '700000000000000001', threadId: null } },
      { slug: 'b'.repeat(40), title: '*'.repeat(100), summary: '*'.repeat(600) });
    expect(res.ok).toBe(true);
    const payload = cards[0] as never;
    const msgs = buildMessage(payload, CTX);
    expect(msgs).toHaveLength(1);
    expect(JSON.stringify(msgs[0]!.components)).toContain(`relcard:${TOKEN}:approve`);
    const embeds = msgs[0]!.embeds as { title?: string; description?: string; fields?: { name: string; value: string }[] }[];
    expect(embeds.length).toBeLessThanOrEqual(10);
    const fields = embeds.flatMap((e) => e.fields ?? []);
    expect(fields).toHaveLength(2);
    for (const e of embeds) expect((e.description ?? '').length).toBeLessThanOrEqual(4096);
    for (const f of fields) { expect(f.value.length).toBeLessThanOrEqual(1024); expect(f.name.length).toBeLessThanOrEqual(256); }
    const total = embeds.reduce((n, e) => n + (e.title ?? '').length + (e.description ?? '').length + (e.fields ?? []).reduce((m, f) => m + f.name.length + f.value.length, 0), 0);
    expect(total).toBeLessThanOrEqual(6000);
  });
});

describe('port: a release card returns the id of the message that carries the buttons', () => {
  it('post() with releaseCardId returns the LAST message id, like the other button cards', async () => {
    const sw: Department = { id: 'software', name: 'Software', categoryNamePattern: 'soft', workChannelId: 'ch-sw', color: 1, model: null, provider: null, enabled: true };
    const ch = fakeChannel('ch-sw');
    const client = fakeRestClient('app-hq', [ch]);
    const repo: WebhookRepo = { getByChannel: async () => null, getByWebhookId: async () => null, upsert: async () => {} };
    const port = createDiscordPort({ client: (d: DeptId) => (d === 'hq' ? client : undefined) }, new WebhookSender(repo), { dept: () => ({ ...sw, id: 'hq' }), persona: () => null }, {
      guildId: '1565649426943442944', adminRoleId: '1565000000000000001', inbound: async (m: Message) => ({ id: m.id }) as never, secrets: [],
    });
    const id = await port.post({ kind: 'head', dept: 'hq' }, { channelId: 'ch-sw' }, { type: 'approval', origin: 'governance', title: 'Release request', body: 'long '.repeat(3000), releaseCardId: TOKEN });
    expect(ch.sent.length).toBeGreaterThan(1);
    expect(id).toBe(`cm-ch-sw-${ch.sent.length}`);
    expect(JSON.stringify(ch.sent.at(-1)!.components)).toContain(`relcard:${TOKEN}:approve`);
    expect(JSON.stringify(ch.sent[0]!.components ?? [])).not.toContain('relcard');
  });
});
