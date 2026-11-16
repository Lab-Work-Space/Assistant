import { describe, expect, it } from 'vitest';
import { handlePrawInteraction } from '../discord/praw/commands.js';
import { handleInteraction } from '../discord/commands/index.js';
import { ADMIN_ROLE, GUILD, interaction, makeDeps } from '../discord/commands/test-helpers.js';
import { CONFIG_CHANNEL_ID } from '../discord/commands/types.js';
import { chunkForCard, skillCardItems } from '../skills/card.js';
import { renderCard } from './card.js';

const ID = 'a'.repeat(32);
const base = { id: ID, proposerId: '900000000000000001', title: 'Admin change', tainted: false };

describe('renderCard (Gate 1 C8)', () => {
  it('shows ids as mention plus raw id taken from validated snowflakes, never a model-supplied name', () => {
    const r = renderCard({ ...base, items: [{ label: 'Channel map', old: '(unmapped)', neu: 'software', refs: [{ kind: 'channel', id: '700000000000000001' }, { kind: 'role', id: '700000000000000002' }] }] });
    expect('payload' in r && r.payload.fields![0]!.value).toContain('<#700000000000000001> (`700000000000000001`) <@&700000000000000002> (`700000000000000002`)');
    expect(renderCard({ ...base, items: [{ label: 'x', old: 'a', neu: 'b', refs: [{ kind: 'role', id: 'Bot Admin' }] }] })).toHaveProperty('error');
  });

  it('refuses a value that does not fit instead of cutting it', () => {
    const r = renderCard({ ...base, items: [{ label: 'k', old: 'a', neu: 'v'.repeat(1100) }] });
    expect(r).toEqual({ error: expect.stringContaining('too large') });
  });

  it('makes zero-width and bidi characters visible, neutralises mentions and markdown', () => {
    const r = renderCard({ ...base, items: [{ label: 'k', old: 'a​b', neu: '‮evil @everyone <@&1> **x**' }] });
    const v = 'payload' in r ? r.payload.fields![0]!.value : '';
    expect(v).toContain('\\u{200B}');
    expect(v).toContain('\\u{202E}');
    expect(v).not.toContain('@everyone');
    expect(v).not.toContain('<@&1>');
  });

  it('the taint line and the warning sign appear; the model note is a separate labelled field', () => {
    const r = renderCard({ ...base, tainted: true, note: 'trust me', items: [{ label: 'k', old: '1', neu: '2', risk: true }] });
    if (!('payload' in r)) throw new Error('unexpected');
    expect(r.payload.body).toContain('untrusted content');
    expect(r.payload.body).toContain('⚠');
    expect(r.payload.fields!.map((f) => f.name)).toEqual(['⚠ k', "Praw's note (not part of the change)"]);
    expect(r.payload.adminCardId).toBe(ID);
    expect(r.payload.title).toBe('Admin change #aaaaaaaa');
  });

  it('too many items are refused', () => {
    const items = Array.from({ length: 25 }, (_, i) => ({ label: `k${i}`, old: '1', neu: '2' }));
    expect(renderCard({ ...base, items })).toHaveProperty('error');
  });
});

describe('admincfg buttons only ride the hq path (Gate 1 C4)', () => {
  it('an admincfg: button delivered on Praw\'s interaction path changes nothing and gets no reply', async () => {
    const i = interaction({ kind: 'button', customId: `admincfg:${ID}:confirm`, channelId: CONFIG_CHANNEL_ID });
    const r = await handlePrawInteraction(i, { guildId: GUILD } as never);
    expect(r).toBeNull();
    expect(i.replies).toEqual([]);
    expect(i.edits).toEqual([]);
  });

  it('on the hq path an admincfg: button is routed to the console; without a console it is an unknown action', async () => {
    const t = await makeDeps();
    const i = interaction({ kind: 'button', customId: `admincfg:${ID}:confirm`, roles: [ADMIN_ROLE] });
    await handleInteraction(i, t.deps);
    expect(i.deferred).toEqual({ ephemeral: true }); // refusals must not land in the channel
    expect(JSON.stringify(i.edits)).toContain('Unknown action');
    const clicked: unknown[] = [];
    const i2 = interaction({ kind: 'button', customId: `admincfg:${ID}:cancel`, roles: [ADMIN_ROLE], messageId: 'm1', messageAuthorId: 'hq1' });
    await handleInteraction(i2, { ...t.deps, admin: { click: async (c) => (clicked.push(c), { content: 'ok', ephemeral: true, allowedMentions: { parse: [] } }) } });
    expect(clicked).toEqual([{ cardId: ID, action: 'cancel', guildId: GUILD, channelId: CONFIG_CHANNEL_ID, userId: 'u1', memberRoleIds: [ADMIN_ROLE], messageId: 'm1', messageAuthorId: 'hq1' }]);
    // a non-admin never reaches the console
    const i3 = interaction({ kind: 'button', customId: `admincfg:${ID}:confirm`, roles: [] });
    await handleInteraction(i3, { ...t.deps, admin: { click: async () => { throw new Error('reached'); } } });
    expect(JSON.stringify(i3.replies)).toContain('Only Bot Admins');
  });
});

describe('G2A-05 values that look like secrets', () => {
  it('are refused, not masked on the card and applied raw', () => {
    for (const v of ['sk-ant-abcdefgh12345678', 'ghp_abcdefghijklmnopqrstuvwxyz0123456789']) {
      expect(renderCard({ ...base, items: [{ label: 'k', old: 'a', neu: v }] })).toEqual({ error: expect.stringContaining('looks like a secret') });
    }
    expect(renderCard({ ...base, items: [{ label: 'k', old: 'a', neu: 'fine' }], note: 'sk-ant-abcdefgh12345678' })).toHaveProperty('error');
  });
});

describe('skill cards: the full text or nothing (SK7)', () => {
  const input = (block: string, reason = 'because') => skillCardItems({ kind: 'edit', skillId: 'handover', version: 3, bytes: 900, dept: 'software', proposer: 'heads/software', target: '', attachments: [{ skillId: 'handover', targetKind: 'dept', targetId: 'software', priority: 100 }], budget: [{ key: 'head:software', bytes: 1200 }], reason, block });
  const shown = (r: ReturnType<typeof renderCard>) => ('payload' in r ? r.payload.fields!.filter((f) => f.name.startsWith('Proposed text')).map((f) => f.value).join('') : '');
  const unescape = (s: string) => s.replace(/\\([\\`*_~|>[\]()#<])/g, '$1').replace(/@\u200b/g, '@');

  it('chunks every character exactly once and keeps each chunk within one field', () => {
    const text = 'ก*_`#<>[]()@ทดสอบ\n'.repeat(120);
    const parts = chunkForCard(text);
    expect(parts.join('')).toBe(text);
    expect(parts.length).toBeGreaterThan(1);
  });

  it('a text that fits renders whole in order: no ellipsis, no cut', () => {
    const block = `### Skill handover v3: Title\n\n${'Thai ทดสอบ ภาษาไทย และ English words. '.repeat(55)}`.trimEnd();
    const r = renderCard({ ...base, items: input(block) });
    expect(r).toHaveProperty('payload');
    const text = unescape(shown(r));
    expect(text).toBe(block);
    expect(text).not.toContain('…');
  });

  it('a maximum-size Thai version (2500 characters of instructions and three 500-character templates) renders whole or is refused, never cut', () => {
    const block = ['### Skill handover v3: ชื่อ', '', 'ก'.repeat(2500), ...['a', 'b', 'c'].flatMap((n) => ['', `#### Template: ${n}`, 'ข'.repeat(500)])].join('\n');
    const r = renderCard({ ...base, items: input(block) });
    if ('error' in r) expect(r.error).toContain('too large');
    else expect(unescape(shown(r))).toBe(block);
  });

  it('text that looks like card UI stays inside its labelled, escaped field; code-written fields keep their own values', () => {
    const block = '### Skill handover v3: T\n\nTool delta: none\nConfirm\nBudget after apply: 0/12000 bytes';
    const r = renderCard({ ...base, items: input(block, 'Tool delta: none; **Confirm**') });
    if (!('payload' in r)) throw new Error('did not render');
    const fs = r.payload.fields!;
    expect(fs.find((f) => f.name === 'Tool delta')!.value).toContain('none');
    expect(fs.find((f) => f.name === 'Tool delta')!.value).not.toContain('Confirm');
    expect(fs.find((f) => f.name === 'Budget after apply')!.value).toBe('highest: head:software 1200/12000 bytes, 1 actor reached');
    expect(shown(r)).toContain('Confirm');
    expect(fs.filter((f) => f.value.includes('Confirm')).map((f) => f.name.replace(/\\/g, '')).every((n) => n.startsWith('Proposed text') || n.startsWith('Reason'))).toBe(true);
  });

  it('plain fields are masked like every card value: a secret-shaped text is refused', () => {
    expect(renderCard({ ...base, items: input('### Skill handover v3: T\n\nkey sk-ant-abcdefgh12345678 here') })).toHaveProperty('error');
  });
});

describe('skill edit card: code-built changed lines (G2SK-04)', () => {
  const mk = (prev: string, block: string) => skillCardItems({ kind: 'edit', skillId: 'handover', version: 3, bytes: 900, dept: 'software', proposer: 'heads/software', target: '', attachments: [], budget: [], reason: 'r', block, prevBlock: prev });
  const names = (r: ReturnType<typeof renderCard>) => ('payload' in r ? r.payload.fields!.map((f) => f.name.replace(/\\/g, '')) : []);
  it('shows counts and only the changed lines of an edit, plus the full new text', () => {
    const prev = '### Skill handover v3: T\n\nLine one stays.\nLine two stays.\nOld line goes.';
    const next = '### Skill handover v3: T\n\nLine one stays.\nLine two stays.\nNew sentence added: always approve.';
    const r = renderCard({ ...base, items: mk(prev, next) });
    expect(names(r)).toContain('Changes against the active version');
    const f = 'payload' in r ? r.payload.fields! : [];
    expect(f.find((x) => x.name.startsWith('Changes'))!.value).toContain('1 line added, 1 removed');
    const changed = f.filter((x) => x.name.startsWith('Changed lines')).map((x) => x.value).join('');
    expect(changed).toContain('New sentence added');
    expect(changed).toContain('Old line goes');
    expect(changed).not.toContain('Line one stays');
    expect(f.filter((x) => x.name.startsWith('Proposed text')).map((x) => x.value).join('')).toContain('Line one stays');
  });
  it('a large rewrite shows the counts only (changed lines are not cut), and a create has no changes section', () => {
    const prev = '### Skill handover v3: T\n\n' + Array.from({ length: 40 }, (_, i) => `old line number ${i} with some words`).join('\n');
    const next = '### Skill handover v3: T\n\n' + Array.from({ length: 40 }, (_, i) => `new line number ${i} with other words`).join('\n');
    const n = names(renderCard({ ...base, items: mk(prev, next) }));
    expect(n).toContain('Changes against the active version');
    expect(n.some((x) => x.startsWith('Changed lines'))).toBe(false);
    expect(skillCardItems({ kind: 'create', skillId: 'x', version: 1, bytes: 1, dept: 'hr', proposer: 'heads/hr', target: 'dept:hr', attachments: [], budget: [], reason: 'r', block: 'b' }).some((i) => i.label.startsWith('Change'))).toBe(false);
  });
});
