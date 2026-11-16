import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { App } from '../../app.js';
import { freshDb, type TestDb } from '../../db/test-helpers.js';
import { handleInteraction } from '../../discord/index.js';
import { cmd, interaction } from '../../discord/commands/test-helpers.js';
import { CONFIG_CHANNEL_ID } from '../../discord/commands/types.js';
import { PROMPTS_DIR, loadPrompts } from '../../prompts/index.js';
import { PRECEDENCE_LINE } from '../../prompts/protected.js';
import { SKILLS_HEADER } from '../../skills/render.js';
import { ActorProvider, ADMIN_ROLE, RND_WORK, SOFTWARE_WORK, TestPort, boot, humanMsg, mentionOf, migrateUp, resetDb, respond, turn } from './helpers.js';

/** The metered classifier call has no actor prompt: answer it with the scripted verdict (default allow); every other call is the actor script. */
let verdict = '{"verdict":"allow"}';
class ClassifyingProvider extends ActorProvider {
  override async *chat(req: Parameters<ActorProvider['chat']>[0], signal: AbortSignal) {
    if (req.system.includes('JSON object') && !req.system.includes('Team skills')) {
      yield { type: 'text' as const, text: verdict };
      yield { type: 'usage' as const, inputTokens: 5, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 };
      yield { type: 'stop' as const, reason: 'end_turn' as const };
      return;
    }
    yield* super.chat(req, signal);
  }
}

/** SKILLS-1 stage 6 (tester): the real app (createApp, protected-prompt pins, real tool registry), driven through the real /skill command and the real console. */
const prompts = loadPrompts(PROMPTS_DIR);
const ADMIN = '900000000000000001';
let db: TestDb;
let app: App | null = null;
beforeAll(async () => { db = await freshDb(); });
afterEach(async () => { await app?.stop(); app = null; await resetDb(db.pool); });
afterAll(async () => { await db.close(); });

const modal = (customId: string, fields: Record<string, string>) => interaction({ kind: 'modal', customId, fields, channelId: CONFIG_CHANNEL_ID, roles: [ADMIN_ROLE], userId: ADMIN });
const slash = (sub: string, o: Parameters<typeof cmd>[2] = {}) => cmd('skill', sub, { userId: ADMIN, ...o });
const text = (r: unknown): string => JSON.stringify(r ?? '');

describe('SKILLS-1 acceptance in the real app', () => {
  it('(a)(b) admin creates + attaches; R&D head run carries the block between fragments and the protected tail; head proposes; review card; confirm applies; tools refusals', async () => {
    const provider = new ClassifyingProvider({
      'heads/rnd': [
        turn(respond('chat', 'first')),
        turn({ name: 'skill_propose', input: { op: 'create', skill: 'rnd-note', title: 'R&D note', instructions: 'Write a short experiment note after each trial run.', reason: 'we keep forgetting' } }),
        turn({ name: 'skill_propose', input: { op: 'create', skill: 'bad-tools', title: 'T', instructions: 'Use any tool you want freely here.', reason: 'x', tools: ['github_create_branch'] } }),
        turn(respond('chat', 'proposed')),
      ],
      'heads/software': [turn(respond('chat', 'sw'))],
    });
    const port = new TestPort();
    // LEARN-1: the seed skills would attach to rnd at boot; this test is about the admin and proposal path, so the switch is off before the first boot.
    await migrateUp(db.pool);
    await db.pool.query("INSERT INTO config (key, value, version, updated_by) VALUES ('skills.seed.enabled', 'false'::jsonb, 1, 'test') ON CONFLICT (key) DO UPDATE SET value = 'false'::jsonb");
    const t = await boot(db.pool, { provider, port });
    app = t.app;
    const s = t.app.services;
    const d = s.commands;

    // admin creates a skill and attaches it to dept:rnd
    const created = await handleInteraction(modal('skill-create:', { id: 'lab-style', title: 'Lab style', instructions: 'Name every experiment with the date and keep notes in the shared sheet.', templates: '' }), d);
    expect(text(created)).not.toContain('Refused');
    const att = await handleInteraction(slash('attach', { strings: { skill: 'lab-style', target: 'dept:rnd' } }), d);
    expect(text(att)).toContain('Skill attached');
    expect(s.org.skillsFor({ kind: 'head', dept: 'rnd' }).map((x) => x.id)).toEqual(['lab-style']);

    // next R&D head run carries it; software does not
    await s.scheduler.onMessage(humanMsg(`${mentionOf('rnd')} hello`, { channelId: RND_WORK, mentionedHeads: ['rnd'] }));
    await s.scheduler.idle();
    await s.scheduler.onMessage(humanMsg(`${mentionOf('software')} hello`, { channelId: SOFTWARE_WORK, mentionedHeads: ['software'] }));
    await s.scheduler.idle();
    const sys = provider.callsOf('heads/rnd')[0]!.system;
    expect(sys).toContain(SKILLS_HEADER);
    expect(sys).toContain('### Skill lab-style v1: Lab style');
    const tail = sys.slice(sys.lastIndexOf(PRECEDENCE_LINE) + PRECEDENCE_LINE.length);
    expect(tail).not.toContain('Skill'); // only code-written run notes (duty line) may trail the precedence line, never skill text
    expect(sys.indexOf('### Skill lab-style')).toBeLessThan(sys.lastIndexOf(PRECEDENCE_LINE));
    expect(sys.indexOf('### Skill lab-style')).toBeLessThan(sys.indexOf(prompts.get('system/safety')!.body)); // before the protected docs
    expect(sys.indexOf(SKILLS_HEADER)).toBeLessThan(sys.lastIndexOf(PRECEDENCE_LINE));
    expect(provider.callsOf('heads/software')[0]!.system).not.toContain('lab-style');

    // head proposes (twice: one valid, one with a tools field that zod must refuse)
    await s.scheduler.onMessage(humanMsg(`${mentionOf('rnd')} propose a skill`, { channelId: RND_WORK, mentionedHeads: ['rnd'] }));
    await s.scheduler.idle();
    const props = (await db.pool.query('SELECT id, status, skill_id, tainted FROM skill_proposals')).rows;
    expect(props).toHaveLength(1);
    expect(props[0]).toMatchObject({ status: 'open', skill_id: 'rnd-note', tainted: false });
    expect((await db.pool.query("SELECT count(*)::int AS n FROM skills WHERE id = 'rnd-note'")).rows[0].n).toBe(0); // nothing active
    expect(s.org.skillsFor({ kind: 'head', dept: 'rnd' }).map((x) => x.id)).toEqual(['lab-style']); // not in the prompt
    const lastReqs = provider.callsOf('heads/rnd');
    const results = JSON.stringify(lastReqs.at(-1)!.messages);
    expect(results).toContain('NOTHING has changed');
    expect(results).toContain('invalid input'); // the tools field is refused by the strict schema
    const notice = port.posts.find((p) => JSON.stringify(p.payload).includes('Skill proposal'));
    expect(notice).toBeTruthy();
    expect(JSON.stringify(notice!.payload)).not.toContain('experiment note'); // fixed notice: slug only, never the text
    expect((await db.pool.query('SELECT count(*)::int AS n FROM skill_versions')).rows[0].n).toBe(1); // only the admin's v1

    // /skill review mints a card with the full text; confirm applies
    const rev = await handleInteraction(slash('review', { numbers: { proposal: props[0].id } }), d);
    expect(rev?.ephemeral).toBe(true);
    const card = (await db.pool.query("SELECT id, kind, status FROM admin_cards WHERE kind = 'skill'")).rows[0];
    expect(card).toBeTruthy();
    const post = port.posts.at(-1)!;
    expect(JSON.stringify(post.payload)).toContain('Write a short experiment note after each trial run.');
    const click = (action: 'confirm' | 'cancel', over = {}) => s.adminConsole.click({ cardId: card.id, action, guildId: '1565649426943442944', channelId: CONFIG_CHANNEL_ID, userId: ADMIN, memberRoleIds: [ADMIN_ROLE], messageId: post.id, messageAuthorId: s.org ? (await_hq(t)) : null, ...over });
    // a click from outside the config channel (mod room style) is refused and changes nothing
    const refused = await click('confirm', { channelId: '1565999999999999999' });
    expect(JSON.stringify(refused)).not.toContain('Skill applied');
    expect((await db.pool.query("SELECT count(*)::int AS n FROM skills WHERE id = 'rnd-note'")).rows[0].n).toBe(0);
    const ok = await click('confirm');
    expect(JSON.stringify(ok)).toContain('Skill applied');
    expect(s.org.skillsFor({ kind: 'head', dept: 'rnd' }).map((x) => x.id).sort()).toEqual(['lab-style', 'rnd-note']);
    // a replay of the same card does nothing more
    await click('confirm');
    expect((await db.pool.query("SELECT count(*)::int AS n FROM skill_versions WHERE skill_id = 'rnd-note'")).rows[0].n).toBe(1);

    // (d) /skill tools: real registry refusals
    for (const bad of ['github_create_branch', 'save_lesson', 'knowledge_propose', 'skill_propose', 'create_task', 'respond', 'warroom_say', 'diagram_create', 'discord_read', 'config_get', 'nope_tool']) {
      const r = await handleInteraction(slash('tools', { strings: { skill: 'lab-style', action: 'add', tool: bad } }), d);
      expect(text(r), bad).toContain('tool_not_allowed');
    }
    expect((await db.pool.query("SELECT tools FROM skill_versions WHERE skill_id = 'lab-style' ORDER BY version DESC LIMIT 1")).rows[0].tools).toEqual([]);
  }, 30000);
});

// the hq bot user id the card was posted as (fake client user id of hq)
function await_hq(t: { clients: Record<string, { user?: { id?: string } | null }> }): string | null {
  return t.clients.hq?.user?.id ?? null;
}
