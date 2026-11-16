import { describe, expect, it } from 'vitest';
import type { OutboundPayload } from '../agents/loop/payload.js';
import { toPayload } from '../agents/loop/payload.js';
import type { Approval } from '../db/repos/ledger.js';
import { buildMessage, buildPlainMessage, embedSize, isCardPayload } from './embeds/index.js';
import { escapeCardText, toolApprovalPayload } from './embeds/approval.js';

const ctx = { deptColor: 0x123456 };
const msgTotal = (m: { embeds: Parameters<typeof embedSize>[0][] }) => m.embeds.reduce((n, e) => n + embedSize(e), 0);
const total = (e: { title?: string; description?: string; fields?: { name: string; value: string }[]; footer?: { text: string } }) =>
  (e.title?.length ?? 0) + (e.description?.length ?? 0) + (e.footer?.text.length ?? 0) +
  (e.fields ?? []).reduce((n, f) => n + f.name.length + f.value.length, 0);

describe('SPEND-1: the department budget raise card', () => {
  const id = 'c0'.repeat(16);
  const card: OutboundPayload = { type: 'approval', origin: 'governance', title: 'Department budget raise', body: 'b', fields: [{ name: 'Cap', value: '$10.00 -> $12.50' }], spendOverrideId: id };

  it('renders exactly two buttons, spendovr:<id>:approve and :reject, on the last message, and nothing else carries buttons', () => {
    const msgs = buildMessage(card, ctx);
    const comps = msgs.at(-1)!.components as unknown as { components: { custom_id: string; label: string }[] }[];
    expect(comps).toHaveLength(1);
    expect(comps[0]!.components.map((c) => c.custom_id)).toEqual([`spendovr:${id}:approve`, `spendovr:${id}:reject`]);
    expect(comps[0]!.components.every((c) => c.custom_id.length <= 100 && !/\d+\.\d/.test(c.custom_id))).toBe(true); // no amount in the id
    expect(buildMessage({ ...card, spendOverrideId: undefined }, ctx).every((m) => m.components.length === 0)).toBe(true);
    expect(isCardPayload({ type: 'chat', body: 'x', spendOverrideId: id })).toBe(true);
  });

  it('a model cannot produce the card: toPayload drops spendOverrideId (and any button field) from model output', () => {
    const p = toPayload({ type: 'approval', body: 'approve me', spendOverrideId: id, adminCardId: id, buttons: { approvalId: 'x' } });
    expect(p).not.toHaveProperty('spendOverrideId');
    expect(p.type).toBe('chat'); // an approval from a model is plain chat (owner rule 2026-11-05)
    expect(buildMessage(p, ctx).every((m) => m.components.length === 0)).toBe(true);
  });
});

describe('buildMessage', () => {
  it('splits 10000-char body into 3 embeds, each message within 6000 chars', () => {
    const body = ('word '.repeat(2000)).trim();
    const msgs = buildMessage({ type: 'report', title: 'T', body }, ctx);
    const embeds = msgs.flatMap((m) => m.embeds);
    expect(embeds).toHaveLength(3);
    for (const m of msgs) expect(msgTotal(m)).toBeLessThanOrEqual(6000);
    expect(embeds.map((e) => e.description).join('')).toBe(body);
  });

  it.each([1, 4096, 6001, 10000, 50000])('body of %i chars: every message <= 6000 chars and <= 10 embeds', (n) => {
    const body = 'ab cd\n'.repeat(Math.ceil(n / 6)).slice(0, n).trimEnd() || 'x';
    const footer = { model: 'm'.repeat(900), costUsd: 1, ms: 1 };
    const msgs = buildMessage({ type: 'report', title: 'T'.repeat(300), body, footer, fields: [{ name: 'n', value: 'v'.repeat(1500) }] }, { ...ctx, footerLabel: 'L'.repeat(900) });
    for (const m of msgs) {
      expect(msgTotal(m)).toBeLessThanOrEqual(6000);
      expect(m.embeds.length).toBeLessThanOrEqual(10);
      for (const e of m.embeds) expect(embedSize(e)).toBeLessThanOrEqual(6000);
    }
    expect(msgs.flatMap((m) => m.embeds).map((e) => e.description ?? '').join('')).toBe(body);
  });

  it('does not cut a surrogate pair', () => {
    const body = '😀'.repeat(3000);
    const [m] = buildMessage({ type: 'chat', body }, ctx);
    const joined = m!.embeds.map((e) => e.description).join('');
    expect(joined).toBe(body);
    for (const e of m!.embeds) expect(/[\ud800-\udbff]$/.test(e.description!)).toBe(false);
  });

  it('more than 10 embeds spill into a second message', () => {
    const msgs = buildMessage({ type: 'report', body: 'x'.repeat(4096 * 12) }, ctx);
    expect(msgs.length).toBeGreaterThanOrEqual(2);
    for (const m of msgs) {
      expect(m.embeds.length).toBeLessThanOrEqual(10);
      expect(msgTotal(m)).toBeLessThanOrEqual(6000);
    }
    expect(msgs.flatMap((m) => m.embeds)).toHaveLength(12);
  });

  it('more than 10 small embeds (fields) spill at 10 per message', () => {
    const fields = Array.from({ length: 25 }, () => ({ name: 'n', value: 'v'.repeat(1000) }));
    const msgs = buildMessage({ type: 'report', body: 'b', fields }, ctx);
    for (const m of msgs) expect(m.embeds.length).toBeLessThanOrEqual(10);
    expect(msgs.flatMap((m) => m.embeds).flatMap((e) => e.fields ?? [])).toHaveLength(25);
  });

  it('approval has 3 buttons with ids approval:<id>:* on the last message only', () => {
    const msgs = buildMessage({ type: 'approval', body: 'x'.repeat(4096 * 11), buttons: { approvalId: '42' } }, ctx);
    expect(msgs.length).toBeGreaterThan(1);
    for (const m of msgs.slice(0, -1)) expect(m.components).toEqual([]);
    const row = msgs.at(-1)!.components[0] as unknown as { components: { custom_id: string }[] };
    expect(row.components.map((c) => c.custom_id)).toEqual(['approval:42:approve', 'approval:42:reject', 'approval:42:ask']);
  });

  it('task embed color matches status', () => {
    const colors = { todo: 0x95a5a6, doing: 0x3498db, review: 0x9b59b6, done: 0x2ecc71, blocked: 0xe74c3c, awaiting_approval: 0xf1c40f, cancelled: 0x7f8c8d } as const;
    for (const [status, c] of Object.entries(colors)) {
      const [m] = buildMessage({ type: 'task', body: 'b' }, { ...ctx, status: status as keyof typeof colors });
      expect(m!.embeds[0]!.color).toBe(c);
    }
    expect(buildMessage({ type: 'task', body: 'b' }, ctx)[0]!.embeds[0]!.color).toBe(0x123456);
  });

  it('alert and approval colors, chat and report use dept color', () => {
    expect(buildMessage({ type: 'alert', body: 'b' }, ctx)[0]!.embeds[0]!.color).toBe(0xe74c3c);
    expect(buildMessage({ type: 'approval', body: 'b' }, ctx)[0]!.embeds[0]!.color).toBe(0xf1c40f);
    expect(buildMessage({ type: 'chat', body: 'b' }, ctx)[0]!.embeds[0]!.color).toBe(0x123456);
  });

  it('persona footer label is used', () => {
    const p: OutboundPayload = { type: 'chat', body: 'b', footer: { model: 'claude-sonnet-5-5', costUsd: 0.0123, ms: 4200 } };
    const [m] = buildMessage(p, { ...ctx, footerLabel: 'Software · Analyst' });
    const e = m!.embeds.at(-1)!;
    expect(e.footer!.text).toBe('Software · Analyst · claude-sonnet-5-5 · $0.0123 · 4.2s');
    expect(buildMessage(p, ctx)[0]!.embeds.at(-1)!.footer!.text).toBe('claude-sonnet-5-5 · $0.0123 · 4.2s');
  });

  it('a praw chat reply has no model/cost/time footer; task report embeds (any actor) keep it', () => {
    const footer = { model: 'gemini-3.8-flash', costUsd: 0.001, ms: 900 };
    const praw = { ...ctx, dept: 'praw' as const, footerLabel: 'พราว · พราว' };
    expect(buildMessage({ type: 'chat', body: 'b', footer }, praw)[0]!.embeds.at(-1)!.footer).toBeUndefined();
    expect(buildMessage({ type: 'report', body: 'b', footer }, praw)[0]!.embeds.at(-1)!.footer!.text).toContain('$0.0010');
    expect(buildMessage({ type: 'chat', body: 'b', footer }, { ...ctx, dept: 'software' })[0]!.embeds.at(-1)!.footer!.text).toContain('$0.0010');
  });

  it('empty body becomes "(empty)"', () => {
    expect(buildMessage({ type: 'chat', body: '  ' }, ctx)[0]!.embeds[0]!.description).toBe('(empty)');
  });

  it('truncates field name and value, caps at 25 fields', () => {
    const fields = Array.from({ length: 30 }, () => ({ name: 'n'.repeat(300), value: 'v'.repeat(2000) }));
    const [m] = buildMessage({ type: 'report', body: 'b', fields }, ctx);
    const fs = [m!, ...[]].concat(buildMessage({ type: 'report', body: 'b', fields }, ctx).slice(1)).flatMap((x) => x.embeds).flatMap((e) => e.fields ?? []);
    expect(fs).toHaveLength(25);
    expect(fs[0]!.name.length).toBe(256);
    expect(fs[0]!.value.length).toBe(1024);
    expect(fs[0]!.value.endsWith('…')).toBe(true);
    for (const x of buildMessage({ type: 'report', body: 'b', fields }, ctx)) expect(msgTotal(x)).toBeLessThanOrEqual(6000);
  });

  it('config type renders', () => {
    expect(buildMessage({ type: 'config', title: 'Cfg', body: 'halted=false' }, ctx)[0]!.embeds[0]!.title).toBe('Cfg');
  });
});

describe('buildMessage mentions (D11)', () => {
  it('@everyone in body does not ping', () => {
    const msgs = buildMessage({ type: 'chat', body: '@everyone <@&99> hi' }, { ...ctx, adminRoleId: '99' });
    for (const m of msgs) {
      expect(m.allowedMentions).toEqual({ parse: [] });
      expect(m.content).toBeUndefined();
    }
  });

  it('model alert never pings admin role', () => {
    for (const origin of [undefined, 'model' as const]) {
      const [m] = buildMessage({ type: 'alert', body: 'x', origin }, { ...ctx, adminRoleId: '99' });
      expect(m!.allowedMentions).toEqual({ parse: [] });
      expect(m!.content).toBeUndefined();
    }
  });

  it('governance alert pings only the admin role, on the first message', () => {
    const msgs = buildMessage({ type: 'alert', body: 'x'.repeat(4096 * 11), origin: 'governance' }, { ...ctx, adminRoleId: '99' });
    expect(msgs[0]!.content).toBe('<@&99>');
    expect(msgs[0]!.allowedMentions).toEqual({ parse: [], roles: ['99'] });
    expect(msgs[1]!.content).toBeUndefined();
    expect(msgs[1]!.allowedMentions).toEqual({ parse: [] });
  });

  it('governance alert without adminRoleId does not ping; non-alert governance does not ping', () => {
    expect(buildMessage({ type: 'alert', body: 'x', origin: 'governance' }, ctx)[0]!.allowedMentions).toEqual({ parse: [] });
    expect(buildMessage({ type: 'report', body: 'x', origin: 'governance' }, { ...ctx, adminRoleId: '99' })[0]!.allowedMentions).toEqual({ parse: [] });
  });
});

describe('model cannot set origin (D11)', () => {
  it('toPayload drops a model-supplied origin governance', () => {
    const p = toPayload({ type: 'alert', body: 'x', origin: 'governance' });
    expect(p.origin).toBeUndefined();
    expect(buildMessage(p, { ...ctx, adminRoleId: '99' })[0]!.allowedMentions).toEqual({ parse: [] });
  });
});

describe('tool approval card (P3)', () => {
  const base: Approval = {
    id: 9, taskId: 't1', reason: 'delete item', estCostUsd: 0, requestedBy: 'head:praw', status: 'pending', decidedBy: null,
    createdAt: new Date(), decidedAt: null, toolName: 'delete_item', toolInput: { repo: 'org/repo', id: '42', title: 'Old' },
  };
  const all = (a: Approval) => buildMessage(toolApprovalPayload(a), ctx);
  const text = (a: Approval) => JSON.stringify(all(a).flatMap((m) => m.embeds));

  it('literal secrets are masked on the card before markdown escaping (an underscore secret is not turned into a different string) (P24)', () => {
    const SECRET = 'sheets-secret-PLANTED_Zq81xK_77';
    const planted = { ...base, reason: `because ${SECRET}`, requestedBy: `head:${SECRET}`, toolName: `tool_${SECRET}`, toolInput: { repo: `o/${SECRET}`, id: SECRET, note: `n ${SECRET}`, [SECRET]: 'v' } };
    const json = JSON.stringify(buildMessage(toolApprovalPayload(planted, [SECRET]), ctx));
    expect(json).not.toContain('PLANTED');
    expect(json).not.toContain(SECRET.replace(/_/g, '\\\\_'));
    expect(JSON.stringify(buildMessage(toolApprovalPayload(planted), ctx))).toContain('PLANTED'); // without the list the escaped form slips past the port's later literal pass
  });
  it('shows tool name, target, item id and change summary from the validated input', () => {
    const t = text(base);
    for (const s of ['org/repo', '42', 'Old']) expect(t).toContain(s);
    expect(t).toMatch(/delete\\+_item/);
    expect(all(base).at(-1)!.components).toHaveLength(1);
  });
  it('shows the validated input, not model text; D7-escaped, allowedMentions none', () => {
    const evil = { ...base, toolInput: { repo: 'o/r', id: '1', note: '@everyone <@&123> **bold** [x](http://e) `c`' } };
    const msgs = all(evil);
    const t = JSON.stringify(msgs.flatMap((m) => m.embeds));
    expect(t).not.toMatch(/@everyone(?!\u200b)/);
    expect(t).not.toContain('<@&123>');
    expect(t).not.toContain('**bold**');
    for (const m of msgs) expect(m.allowedMentions).toEqual({ parse: [] });
  });
  it('G2-04/05 F1: invisible and format characters are shown as visible \\u{XXXX} escapes, tag-encoded text included', () => {
    const tag = (t: string) => [...t].map((c) => String.fromCodePoint(0xe0000 + c.charCodeAt(0))).join('');
    const hidden = `dns${tag('tok_AbC')}\u200b\u2060\ufeff\u00ad\ufe0f\u{e0100}`;
    const p = toolApprovalPayload({ ...base, toolInput: { repo: 'o/r', note: hidden } });
    const t = JSON.stringify(p);
    expect(/[\u{e0000}-\u{e007f}\u200b-\u200f\u2060-\u2064\ufeff\u00ad\ufe00-\ufe0f\u{e0100}-\u{e01ef}]/u.test(t)).toBe(false);
    const shown = p.fields!.map((f) => f.value).join('\n');
    for (const code of ['E0074', 'E006F', 'E0043', '200B', '2060', 'FEFF', '00AD', 'FE0F', 'E0100']) expect(shown).toContain(`u{${code}}`);
    expect(escapeCardText(`a${tag('x')}b`, 100)).toBe('a\\\\u{E0078}b'); // markdown pass doubles the backslash; Discord shows one
  });
  it('G2-05 F2: the whole web_search query is on the card (dedicated Query fields, JSON-escaped, inert)', () => {
    const query = `${'"'.repeat(200)}\n@everyone <@1> ${'a'.repeat(150)}TAILMARK`;
    expect(query.length).toBeLessThanOrEqual(400);
    const p = toolApprovalPayload({ ...base, toolName: 'web_search', toolInput: { query, count: 3 } });
    const q = p.fields!.filter((f) => f.name.startsWith('Query'));
    expect(q.length).toBeGreaterThan(1);
    for (const f of q) expect(f.value.length).toBeLessThanOrEqual(1024);
    const shown = q.map((f) => f.value).join('');
    expect(shown).toContain('TAILMARK');
    expect(shown).not.toContain('\n'); // JSON-escaped: no raw newline
    expect(shown).not.toMatch(/@everyone(?!\u200b)/);
    expect(shown).not.toContain('<@1>');
    expect(JSON.stringify(p.fields)).not.toMatch(/truncated/i);
    expect(p.fields!.find((f) => f.name === 'Changes')!.value).toContain('count: 3');
    for (const m of buildMessage(p, ctx)) expect(msgTotal(m)).toBeLessThanOrEqual(6000);
  });
  it('G2RF5-01 (RF31): the whole media prompt is on the card (Prompt fields, JSON-escaped), with count/aspect/seconds in Changes', () => {
    const prompt = `${'"'.repeat(200)} a red bicycle ${'ก'.repeat(150)}TAILMARK`;
    expect(prompt.length).toBeLessThanOrEqual(400);
    const p = toolApprovalPayload({ ...base, toolName: 'video_generate', toolInput: { prompt, seconds: 8, aspect: '16:9' } });
    const q = p.fields!.filter((f) => f.name.startsWith('Prompt'));
    expect(q.length).toBeGreaterThan(1);
    for (const f of q) expect(f.value.length).toBeLessThanOrEqual(1024);
    expect(q.map((f) => f.value).join('')).toContain('TAILMARK');
    expect(JSON.stringify(p.fields)).not.toMatch(/truncated/i);
    const changes = p.fields!.find((f) => f.name === 'Changes')!.value;
    expect(changes).toContain('seconds: 8');
    expect(changes).not.toContain('prompt');
    for (const m of buildMessage(p, ctx)) expect(msgTotal(m)).toBeLessThanOrEqual(6000);
  });
  it('R-03: Query chunks split on code points: no lone surrogate on any field, and the pieces rejoin to the whole', () => {
    const query = `${'a'.repeat(247)}${'\u{1F600}'.repeat(60)}` ; // the first emoji straddles the 250 boundary in UTF-16 units
    const p = toolApprovalPayload({ ...base, toolName: 'web_search', toolInput: { query } });
    const q = p.fields!.filter((f) => f.name.startsWith('Query')).map((f) => f.value);
    expect(q.length).toBeGreaterThan(1);
    for (const v of q) expect(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(v)).toBe(false);
    expect(q.join('').replace(/\\/g, '')).toBe(JSON.stringify(query));
  });
  it('redacts secrets by key and by shape', () => {
    const t = text({ ...base, toolInput: { repo: 'o/r', apiKey: 'plain-secret-value', note: 'use sk-ant-abcdefghijkl1234' } });
    expect(t).not.toContain('plain-secret-value');
    expect(t).not.toContain('sk-ant-abcdefghijkl1234');
  });
  it('contract (c): shows a short input_sha256 prefix, and a truncated marker only when values or keys were cut', () => {
    const sha = 'ab12cd34ef56'.padEnd(64, '0');
    const short = toolApprovalPayload({ ...base, inputSha256: sha });
    expect(short.fields).toContainEqual({ name: 'Input sha256', value: 'ab12cd34ef56' });
    expect(JSON.stringify(short.fields)).not.toMatch(/truncated/i);
    const longValue = toolApprovalPayload({ ...base, inputSha256: sha, toolInput: { repo: 'o/r', note: 'x'.repeat(500) } });
    expect(JSON.stringify(longValue.fields)).toMatch(/truncated/i);
    const manyKeys = toolApprovalPayload({ ...base, inputSha256: sha, toolInput: Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`k${i}`, 'v'])) });
    expect(JSON.stringify(manyKeys.fields)).toMatch(/truncated/i);
    const longKey = toolApprovalPayload({ ...base, inputSha256: sha, toolInput: { ['k'.repeat(80)]: 'v' } });
    expect(JSON.stringify(longKey.fields)).toMatch(/truncated/i);
  });
  it('byte cap: huge input and long values stay within Discord limits and the card stays small', () => {
    const big = Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`k${i}`, 'v'.repeat(3000)]));
    const a = { ...base, toolInput: { ...big, repo: 'r'.repeat(5000) }, reason: 'r'.repeat(9000), toolName: 'n'.repeat(500) };
    const msgs = all(a);
    for (const m of msgs) expect(msgTotal(m)).toBeLessThanOrEqual(6000);
    expect(msgs.reduce((n, m) => n + msgTotal(m), 0)).toBeLessThanOrEqual(3000);
  });
});

describe('plain chat answers (owner rule: embeds only for settings and requests)', () => {
  it('only config, approval, governance and button payloads are cards', () => {
    expect(isCardPayload({ type: 'config', body: 'x' })).toBe(true);
    expect(isCardPayload({ type: 'approval', body: 'x' })).toBe(true);
    expect(isCardPayload({ type: 'alert', body: 'x', origin: 'governance' })).toBe(true);
    for (const type of ['chat', 'task', 'report', 'alert'] as const) expect(isCardPayload({ type, body: 'x' })).toBe(false);
  });

  it('renders title, body, fields and footer as content with no embed and no mention parsing', () => {
    const [m, ...rest] = buildPlainMessage({ type: 'report', title: 'Weekly', body: 'all good', fields: [{ name: 'Owner', value: '' }], footer: { model: 'local/x', costUsd: 0, ms: 1200 } }, ctx);
    expect(rest).toEqual([]);
    expect(m!.embeds).toEqual([]);
    expect(m!.content).toBe('**Weekly**\nall good\n**Owner:** -\n-# local/x · $0.0000 · 1.2s');
    expect(m!.allowedMentions).toEqual({ parse: [] });
  });

  it('splits long answers into messages of at most 2000 characters', () => {
    const msgs = buildPlainMessage({ type: 'chat', body: 'word '.repeat(1000) }, { ...ctx, dept: 'praw' });
    expect(msgs.length).toBe(3);
    for (const m of msgs) expect(m.content!.length).toBeLessThanOrEqual(2000);
    expect(msgs.map((m) => m.content).join('')).toBe('word '.repeat(1000).trimEnd());
  });
});
