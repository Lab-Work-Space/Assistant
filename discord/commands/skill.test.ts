import { describe, expect, it } from 'vitest';
import { COMMANDS, CONFIG_CHANNEL_ID, handleInteraction } from './index.js';
import { ADMIN_ROLE, cmd, interaction, makeDeps, text } from './test-helpers.js';
import type { CommandDeps } from './types.js';

const row = { id: 'handover', title: 'Handover checklist', status: 'active' as const, activeVersion: 2, ownerDept: null, instructions: 'Write the handover note before closing a task.', templates: [{ name: 'Note', body: 'Done / Next' }], tools: ['web_search'], bodyBytes: 120, bodySha256: 'a'.repeat(64) };
const fakeSkills = (): NonNullable<CommandDeps['skills']> => ({
  repo: {
    list: async () => [row], attachments: async () => [{ skillId: 'handover', targetKind: 'dept' as const, targetId: 'software', priority: 100 }],
    get: async (id: string) => (id === 'handover' ? row : null), attachmentsOf: async () => [{ skillId: 'handover', targetKind: 'dept' as const, targetId: 'software', priority: 100 }],
    version: async (_id: string, v: number) => (v <= 2 ? { skillId: 'handover', version: v, instructions: row.instructions, templates: row.templates, tools: row.tools, bodyBytes: 120, bodySha256: 'a'.repeat(64), source: 'admin', restoredFrom: null, createdBy: 'user:1', createdAt: new Date() } : null),
    listProposals: async () => [{ id: 7, deptId: 'software', kind: 'create', skillId: 'new-skill', status: 'open', payload: { reason: 'SECRET-REASON-TEXT' } }],
  } as never,
  preview: async () => ({ ok: false, code: 'nothing_to_do' }) as never, run: async () => { throw new Error('not used'); }, rejectProposal: async (id: number) => id === 7,
});
const mk = async () => makeDeps({ skills: fakeSkills(), admin: { click: async () => ({ content: 'x', ephemeral: true, allowedMentions: { parse: [] } }), mintSkillCard: async () => ({ ok: true, cardId: 'c'.repeat(32), text: 'Card posted.' }) } });

describe('/skill is registered (SK16 commands)', () => {
  it('has 13 subcommands (at most 25) with the spec names', () => {
    const c = COMMANDS.find((x) => x.name === 'skill')!;
    const subs = (c.options ?? []).map((o) => o.name);
    expect(subs).toEqual(['list', 'show', 'create', 'edit', 'attach', 'detach', 'tools', 'disable', 'enable', 'rollback', 'proposals', 'review', 'reject']);
    expect(subs.length).toBeLessThanOrEqual(25);
  });
});

describe('/skill replies are ephemeral (SK3)', () => {
  it.each([
    ['list', {}], ['show', { strings: { skill: 'handover' } }], ['proposals', {}], ['review', { numbers: { proposal: 7 } }], ['reject', { numbers: { proposal: 7 } }],
  ] as const)('%s defers privately and replies privately', async (sub, o) => {
    const t = await mk();
    const i = cmd('skill', sub, o as never);
    const r = await handleInteraction(i, t.deps);
    expect(i.deferred).toEqual({ ephemeral: true });
    expect(r?.ephemeral).toBe(true);
    expect(i.edits.every((e) => e.ephemeral)).toBe(true);
  });

  it('list and show carry the skill; proposals list carries ids and slugs but never the proposal reason or text', async () => {
    const t = await mk();
    expect(text(await handleInteraction(cmd('skill', 'list'), t.deps))).toContain('handover v2');
    expect(text(await handleInteraction(cmd('skill', 'show', { strings: { skill: 'handover' } }), t.deps))).toContain('### Skill handover v2: Handover checklist');
    const list = text(await handleInteraction(cmd('skill', 'proposals'), t.deps));
    expect(list).toContain('#7 create new-skill');
    expect(list).not.toContain('SECRET-REASON-TEXT');
  });

  it('a bad skill id, unknown version, or bad target is a short refusal', async () => {
    const t = await mk();
    expect(text(await handleInteraction(cmd('skill', 'show', { strings: { skill: 'Bad Slug' } }), t.deps))).toContain('Unknown skill');
    expect(text(await handleInteraction(cmd('skill', 'show', { strings: { skill: 'handover' }, numbers: { version: 9 } }), t.deps))).toContain('Unknown version');
    expect(text(await handleInteraction(cmd('skill', 'list', { strings: { target: 'nope' } }), t.deps))).toContain('dept:<id> or persona:<id>');
  });
});

describe('/skill access and modals', () => {
  it('only a Bot Admin in #⚙️-setting reaches any skill command', async () => {
    const t = await mk();
    expect(text(await handleInteraction(cmd('skill', 'list', { roles: ['someone'] }), t.deps))).toContain('Only Bot Admins');
    expect(text(await handleInteraction(cmd('skill', 'list', { channelId: '123' }), t.deps))).toContain('#⚙️-setting');
  });

  it('create opens a modal without deferring; edit opens it prefilled with the active version and a strict custom id', async () => {
    const t = await mk();
    const c = cmd('skill', 'create');
    await handleInteraction(c, t.deps);
    expect(c.deferred).toBeNull();
    expect(c.modals[0]!.customId).toBe('skill-create:');
    expect(c.modals[0]!.inputs.map((x) => [x.id, x.maxLength])).toEqual([['id', 40], ['title', 100], ['instructions', 2500], ['templates', 1800]]);
    const e = cmd('skill', 'edit', { strings: { skill: 'handover' } });
    await handleInteraction(e, t.deps);
    expect(e.modals[0]!.customId).toBe('skill-edit:handover:2');
    expect(e.modals[0]!.inputs.find((x) => x.id === 'instructions')!.value).toBe(row.instructions);
    expect(e.modals[0]!.inputs.find((x) => x.id === 'templates')!.value).toBe('## Note\nDone / Next');
  });

  it('a modal submit with a malformed edit custom id or malformed templates is refused before anything runs', async () => {
    const t = await mk();
    const m = (customId: string, fields: Record<string, string>) => interaction({ kind: 'modal', customId, fields, channelId: CONFIG_CHANNEL_ID, roles: [ADMIN_ROLE] });
    for (const bad of ['skill-edit:Bad Slug:2', 'skill-edit:handover:0', 'skill-edit:handover:-1', 'skill-edit:handover:2x', 'skill-edit:handover:', 'skill-edit:handover:2:3']) {
      const i = m(bad, { title: 'T', instructions: 'Some instructions that are long enough.', templates: '' });
      expect(text(await handleInteraction(i, t.deps)), bad).toContain('not valid');
    }
    const badTpl = m('skill-edit:handover:2', { title: 'T', instructions: 'Some instructions that are long enough.', templates: 'text before any heading' });
    expect(text(await handleInteraction(badTpl, t.deps))).toContain('## name');
  });
});
