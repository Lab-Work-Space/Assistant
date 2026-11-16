import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { App } from '../../app.js';
import { seed } from '../../company/index.js';
import { ChannelMapRepo, DepartmentRepo, PersonaRepo } from '../../db/repos/index.js';
import { freshDb, type TestDb } from '../../db/test-helpers.js';
import { handleInteraction } from '../../discord/index.js';
import { interaction } from '../../discord/commands/test-helpers.js';
import { PROMPTS_DIR, loadPrompts } from '../../prompts/index.js';
import { APP_ID, INSTALLATION_ID, KP, PEM, REPO } from '../../tools/plugins/github/test-helpers.js';
import { fakeFetch, githubRoutes } from '../fakes/http.js';
import { ActorProvider, boot, humanMsg, mentionOf, migrateUp, resetDb, respond, turn } from './helpers.js';

/** AC10 end to end: the real github group over a socket-free fake GitHub, the real approvals table and the real /github allow command. */
const PRAW_WORK = '1565999999999999001';
let db: TestDb;
let app: App | null = null;
beforeAll(async () => { db = await freshDb(); });
afterEach(async () => { await app?.stop(); app = null; await resetDb(db.pool); });
afterAll(async () => { await db.close(); });

const FILE = { owner: 'acme', repo: 'widgets', branch: 'praw/fix', path: 'src/a.ts', content: 'one\nTWO\n', message: 'fix: a' };

async function start() {
  await migrateUp(db.pool);
  await seed({ departments: new DepartmentRepo(db.pool), personas: new PersonaRepo(db.pool), channelMap: new ChannelMapRepo(db.pool) }, loadPrompts(PROMPTS_DIR));
  await db.pool.query("UPDATE departments SET provider = 'claude', model = 'claude-sonnet-5-5', work_channel_id = $1 WHERE id = 'praw'", [PRAW_WORK]);
  const gh = githubRoutes({ appId: APP_ID, installationId: INSTALLATION_ID, publicKey: KP.publicKey, repos: [{ ...REPO, branches: { main: 'a'.repeat(40), 'praw/fix': 'b'.repeat(40) }, files: { 'praw/fix:src/a.ts': 'one\ntwo\n' } }] });
  const f = fakeFetch(gh.routes);
  const provider = new ActorProvider({ 'heads/praw': [turn({ name: 'github_create_or_update_file', input: FILE }), turn(respond('chat', 'waiting for approval')), turn(respond('chat', 'done')), turn(respond('chat', 'done'))] });
  const t = await boot(db.pool, { provider, env: { github: { appId: APP_ID, installationId: INSTALLATION_ID, privateKey: PEM } }, fetch: f });
  app = t.app;
  const allowCmd = (action: string) => handleInteraction(interaction({ commandName: 'github', subcommand: 'allow', strings: { action, repo: 'acme/widgets' }, userId: 'admin1' }), t.app.services.commands);
  return { t, gh, f, allowCmd };
}
const pending = async () => (await db.pool.query<{ id: number; reason: string }>("SELECT id, reason FROM approvals WHERE status = 'pending'")).rows;

describe('praw github writes (AC10)', () => {
  it('allowlisted by /github allow, the write waits for approval, the stored call runs once', async () => {
    const { t, gh, allowCmd } = await start();
    await allowCmd('add');
    expect(t.app.services.cfg.get('github.repoAllowlist')).toEqual([{ id: 777, fullName: 'acme/widgets' }]);
    await t.app.services.scheduler.onMessage(humanMsg(`${mentionOf('praw')} fix a.ts`, { mentionedHeads: ['praw'] }));
    await t.app.services.scheduler.idle();
    expect(gh.writes).toEqual([]);
    const rows = await pending();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.reason).toMatch(/^tool github_create_or_update_file on acme\/widgets#777: branch praw\/fix, path src\/a\.ts: update existing file at blob [0-9a-f]{7} \(2 -> 2 lines, \+1 -1/);
    expect((await t.app.services.approvals.decide(rows[0]!.id, 'approved', { id: 'admin1', isAdmin: true })).ok).toBe(true);
    await t.app.services.scheduler.idle();
    expect(gh.writes.map((w) => `${w.method} ${w.path}`)).toEqual(['PUT contents/src/a.ts']);
    expect((await t.app.services.approvals.decide(rows[0]!.id, 'approved', { id: 'admin1', isAdmin: true })).ok).toBe(false); // single use
    await t.app.services.scheduler.idle();
    expect(gh.writes).toHaveLength(1);
  });

  it('removing the repo from the allowlist between approval request and decision refuses the approved call', async () => {
    const { t, gh, allowCmd } = await start();
    await allowCmd('add');
    await t.app.services.scheduler.onMessage(humanMsg(`${mentionOf('praw')} fix a.ts`, { mentionedHeads: ['praw'] }));
    await t.app.services.scheduler.idle();
    const rows = await pending();
    expect(rows).toHaveLength(1);
    await allowCmd('remove');
    expect(t.app.services.cfg.get('github.repoAllowlist')).toEqual([]);
    expect((await t.app.services.approvals.decide(rows[0]!.id, 'approved', { id: 'admin1', isAdmin: true })).ok).toBe(true);
    await t.app.services.scheduler.idle();
    expect(gh.writes).toEqual([]);
    const audit = (await db.pool.query<{ action: string; tool: string | null; outcome: string }>("SELECT action, tool, outcome FROM audit_log WHERE tool = 'github_create_or_update_file' ORDER BY id")).rows;
    expect(audit.map((a) => a.outcome)).toEqual(['awaiting_approval', 'refused']);
  });

  it('the pinned blob sha is part of the approved digest: a tampered stored input does not run', async () => {
    const { t, gh, allowCmd } = await start();
    await allowCmd('add');
    await t.app.services.scheduler.onMessage(humanMsg(`${mentionOf('praw')} fix a.ts`, { mentionedHeads: ['praw'] }));
    await t.app.services.scheduler.idle();
    const rows = await pending();
    expect(rows).toHaveLength(1);
    const stored = (await db.pool.query<{ tool_input: Record<string, unknown> }>('SELECT tool_input FROM approvals WHERE id = $1', [rows[0]!.id])).rows[0]!.tool_input;
    expect(stored['base_sha']).toMatch(/^[0-9a-f]{40}$/);
    await db.pool.query(`UPDATE approvals SET tool_input = jsonb_set(tool_input, '{base_sha}', to_jsonb($2::text)) WHERE id = $1`, [rows[0]!.id, 'e'.repeat(40)]);
    expect((await t.app.services.approvals.decide(rows[0]!.id, 'approved', { id: 'admin1', isAdmin: true })).ok).toBe(true);
    await t.app.services.scheduler.idle();
    expect(gh.writes).toEqual([]);
  });

  it('a repo that is not on the allowlist is refused before any approval row exists', async () => {
    const { t, gh } = await start();
    await t.app.services.scheduler.onMessage(humanMsg(`${mentionOf('praw')} fix a.ts`, { mentionedHeads: ['praw'] }));
    await t.app.services.scheduler.idle();
    expect(await pending()).toEqual([]);
    expect(gh.writes).toEqual([]);
  });
});
