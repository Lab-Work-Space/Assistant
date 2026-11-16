import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { App } from '../../app.js';
import type { ActorRef } from '../../company/types.js';
import { ADMIN, ADMIN2, newBuild, newForge, newRelease, resetForgeTables } from '../../db/repos/forge-test-helpers.js';
import { freshDb, type TestDb } from '../../db/test-helpers.js';
import type { OutboundPayload } from '../../agents/loop/payload.js';
import type { PostOptions } from '../../discord/port.js';
import { FORGE_BASE_ALERT } from '../../forge/texts.js';
import { BASE_ID, FakeForgeDocker, NEW_ID, helloBuild, removeScratch, scratchRoot } from '../../forge/test-helpers.js';
import { FORGE_HANDOFF_BODY } from '../../releases/targets.js';
import { FakeMcpDocker, fixtureSpawner } from '../../mcp/test-helpers.js';
import { BOT_LOG_CHANNEL, CONFIG_CHANNEL, TestPort, boot, migrateUp, resetDb } from './helpers.js';

/**
 * R7 PLUGIN-FORGE BE2 (spec 3.6, 5.14, FG-AC10, FG-AC12, FG-AC14, FG-AC17, FG-AC21; PF-C11 end to end, PF-C12, PF-C17, PF-C23): the app boot and the whole path through the real wiring: a release card approve
 * enqueues and posts the notice, the tick builds and stages through the real McpAdmin (fake docker and spawner), only /mcp approve activates, the reconcile installs and closes the idea.
 */
let db: TestDb;
let app: App | null = null;
let scratch: ReturnType<typeof scratchRoot> | null = null;
const madeDirs: string[] = [];
beforeAll(async () => { db = await freshDb(); await migrateUp(db.pool); });
afterEach(async () => {
  await app?.stop();
  for (const d of madeDirs.splice(0)) if (d.startsWith(join(tmpdir(), 'forge-images-'))) rmSync(d, { recursive: true, force: true }); // only the directories this file made
  app = null;
  if (scratch) await removeScratch(scratch.parent);
  scratch = null;
  await resetForgeTables(db.pool);
  await resetDb(db.pool);
});
afterAll(async () => { await db.close(); });

const withBase = (id: string | null): string => {
  const d = mkdtempSync(join(tmpdir(), 'forge-images-'));
  madeDirs.push(d);
  mkdirSync(join(d, 'docker', 'forge'), { recursive: true });
  if (id) writeFileSync(join(d, 'docker', 'forge', 'images.json'), JSON.stringify({ base: id }));
  return d;
};
const on = (): Promise<unknown> => db.pool.query("INSERT INTO config (key, value) VALUES ('forge.enabled', 'true') ON CONFLICT (key) DO UPDATE SET value = 'true'");
const auditsOf = async (action: string): Promise<string[]> => (await db.pool.query("SELECT outcome FROM audit_log WHERE action = $1 ORDER BY id", [action])).rows.map((r: { outcome: string }) => r.outcome);

/** Message ids as Discord has them (a snowflake): the release row's CHECK needs one for `released_message_id`. */
class FlakyPort extends TestPort {
  failNotice = false;
  private snow = 0;
  override async post(actor: ActorRef, target: { channelId: string; threadId?: string }, payload: OutboundPayload, opts?: PostOptions): Promise<string> {
    if (this.failNotice && payload.body.includes('code will build plugin')) { this.failNotice = false; throw Object.assign(new Error('Missing Access'), { name: 'DeniedChannelError' }); }
    await super.post(actor, target, payload, opts);
    return String(800000000000001000n + BigInt(++this.snow));
  }
}

describe('FG-AC17 / PF-C17: the forge switch at boot (a read error or off is off)', () => {
  it('off (the default): the forge docker is never touched, no alert, the app is up', async () => {
    const docker = new FakeForgeDocker();
    scratch = scratchRoot();
    const t = await boot(db.pool, { forge: { docker, imagesDir: withBase(BASE_ID), stageRoot: scratch.root, tickMs: 30, gcMs: 30 } });
    app = t.app;
    await new Promise((r) => setTimeout(r, 250));
    expect(docker.calls).toEqual([]);
    expect(t.port.posts.some((p) => p.payload.body === FORGE_BASE_ALERT)).toBe(false);
    expect(t.app.services.healthUrl()).not.toBeNull();
  });
  it('on at start with no usable base file: recover runs in the background, checks the base and posts the one #bot-log alert', async () => {
    await on();
    const docker = new FakeForgeDocker();
    scratch = scratchRoot();
    const t = await boot(db.pool, { forge: { docker, imagesDir: withBase(null), stageRoot: scratch.root, tickMs: 30 } });
    app = t.app;
    await vi.waitFor(() => expect(t.port.posts.filter((p) => p.payload.body === FORGE_BASE_ALERT)).toHaveLength(1), { timeout: 5000 });
    expect(t.port.posts.find((p) => p.payload.body === FORGE_BASE_ALERT)!.target.channelId).toBe(BOT_LOG_CHANNEL);
    await new Promise((r) => setTimeout(r, 200));
    expect(t.port.posts.filter((p) => p.payload.body === FORGE_BASE_ALERT)).toHaveLength(1); // never twice
    expect(docker.verbs().filter((v) => v === 'create' || v === 'commit')).toEqual([]);
  });
  it('turned on at run time: recover runs then (no restart), once; off and on again does not recover twice', async () => {
    const docker = new FakeForgeDocker();
    scratch = scratchRoot();
    const t = await boot(db.pool, { forge: { docker, imagesDir: withBase(BASE_ID), stageRoot: scratch.root, tickMs: 30 } });
    app = t.app;
    expect(docker.calls).toEqual([]);
    await t.app.services.cfg.set('forge.enabled', true, 'test');
    await vi.waitFor(() => expect(docker.verbs()).toContain('ps'), { timeout: 5000 });
    const sweeps = (): number => docker.verbs().filter((v) => v === 'ps').length;
    await t.app.services.cfg.set('forge.enabled', false, 'test');
    await t.app.services.cfg.set('forge.enabled', true, 'test');
    await new Promise((r) => setTimeout(r, 200));
    await new Promise((r) => setTimeout(r, 300));
    expect(sweeps()).toBe(1);
  }, 20_000);
});

describe('the whole path through the real wiring (spec 3.2 steps 6-10)', () => {
  const TOKEN = 'c'.repeat(32);
  const CARD = '800000000000000021';

  async function setup(port: TestPort = new FlakyPort(), gate?: Promise<void>) {
    await on();
    scratch = scratchRoot();
    const docker = new FakeForgeDocker();
    // `gate`: the boot recover's sweep waits for it, and no tick runs before the recover has finished (app.ts), so the test decides when the first tick can happen
    const forgeDocker = gate ? { exec: async (a: readonly string[]) => { if (a[0] === 'ps') await gate; return docker.exec(a); } } : docker;
    const mcpDocker = new FakeMcpDocker();
    mcpDocker.imageId = NEW_ID;
    const t = await boot(db.pool, { port, mcp: { docker: mcpDocker, spawn: fixtureSpawner() }, forge: { docker: forgeDocker as never, imagesDir: withBase(BASE_ID), stageRoot: scratch.root, tickMs: 40, gcMs: 600_000 } });
    app = t.app;
    const f = await newForge(db.pool);
    expect(f.ideaId).toBe(1);
    const hb = helloBuild();
    const rel = await newRelease(db.pool, { forgeId: f.forgeId, projectId: f.projectId, sha: hb.sha256, manifest: hb.manifestSha256, zip: hb.zip, bytes: hb.zip.length, status: 'pending' });
    // root_id is the project's root, as a real request stores it (G2-FG-09: the decide looks the project up by the card's root)
    await db.pool.query("UPDATE releases SET token = $2, channel_id = $3, message_id = $4, source_channel_id = '700000000000000001', source_thread_id = '700000000000000002', root_id = $5 WHERE id = $1", [rel, TOKEN, CONFIG_CHANNEL, CARD, f.root]);
    const approve = (userId: string) => t.app.services.commands.releases!.decide({ token: TOKEN, action: 'approve', userId, channelId: CONFIG_CHANNEL, messageId: CARD });
    return { t, f, rel, docker, mcpDocker, approve, hb };
  }
  const buildOf = async () => (await db.pool.query('SELECT status, decided_by AS "decidedBy", image_id AS "imageId", code FROM plugin_builds ORDER BY id')).rows as { status: string; decidedBy: string; imageId: string | null; code: string | null }[];

  it('approve enqueues and posts the notice (as the software head, with the nonce and no handles); the tick builds and stages; the alert names /mcp approve; only /mcp approve activates; the reconcile installs and closes the idea with the approver', async () => {
    const s = await setup();
    const res = await s.approve(ADMIN);
    expect(res).toMatchObject({ ok: true, result: 'released' });
    const notice = s.t.port.posts.find((p) => p.payload.body === FORGE_HANDOFF_BODY({ id: s.rel, pluginSlug: 'hello', sha256: s.hb.sha256 }));
    expect(notice).toBeDefined();
    expect(notice!.actor).toEqual({ kind: 'head', dept: 'software' });
    expect(notice!.target).toMatchObject({ channelId: '700000000000000001', threadId: '700000000000000002' });
    expect(notice!.opts).toMatchObject({ nonce: `rel-${s.rel}-${s.hb.sha256.slice(0, 8)}` });
    expect((await db.pool.query('SELECT status FROM releases WHERE id = $1', [s.rel])).rows[0].status).toBe('released');

    await vi.waitFor(async () => expect((await buildOf())[0]?.status).toBe('staged'), { timeout: 10_000 });
    const srv = (await db.pool.query('SELECT slug, status, source, release_id AS "releaseId", tool_class AS cls, image_id AS "imageId" FROM mcp_servers')).rows;
    expect(srv).toEqual([{ slug: 'hello', status: 'pending', source: 'release', releaseId: s.rel, cls: 'write', imageId: NEW_ID }]); // a card approve never activates
    const alert = s.t.port.posts.find((p) => /was built by code/.test(p.payload.body) && /\/mcp approve slug:hello hash:[0-9a-f]{12}/.test(p.payload.body));
    expect(alert).toBeDefined();
    expect(alert!.target.channelId).toBe(CONFIG_CHANNEL);
    expect((await auditsOf('forge.build')).map((o) => o.replace(/^#\d+ /, ''))).toEqual(['start', expect.stringMatching(/^staged hello [0-9a-f]{12}$/)]);
    expect((await auditsOf('mcp.add'))[0]).toMatch(/^pending hello [0-9a-f]{12} \d+ release:#\d+$/);
    const cfg12 = /hash:([0-9a-f]{12})/.exec(alert!.payload.body)![1]!;

    // only /mcp approve activates
    expect(await s.t.app.services.commands.mcp!.approve({ slug: 'hello', token: cfg12 }, { kind: 'admin', userId: ADMIN2 })).toMatchObject({ ok: true, slug: 'hello' });
    await vi.waitFor(async () => expect((await db.pool.query('SELECT status FROM plugin_forges')).rows[0].status).toBe('installed'), { timeout: 10_000 });
    expect((await db.pool.query('SELECT status, closed_by AS "closedBy", close_reason AS "closeReason" FROM tool_ideas WHERE id = 1')).rows[0]).toEqual({ status: 'closed', closedBy: ADMIN2, closeReason: 'Installed as MCP server hello.' });
    expect((await auditsOf('forge.install'))[0]).toMatch(/^#\d+ installed hello idea #1$/);
    expect(s.t.port.posts.some((p) => /is installed as MCP server hello/.test(p.payload.body))).toBe(true);
    expect(s.docker.verbs().filter((v) => ['run', 'start', 'exec', 'build', 'pull', 'push', 'tag'].includes(v))).toEqual([]);
  }, 30_000);

  it('PF-C11 end to end: a certain refusal of the notice reverts the release; a second admin approves; the build stages under the SECOND admin (the stage cross-check holds)', async () => {
    const port = new FlakyPort();
    const s = await setup(port);
    port.failNotice = true;
    expect(await s.approve(ADMIN)).toMatchObject({ ok: false, code: 'post_failed' });
    expect((await db.pool.query('SELECT status, decided_by FROM releases WHERE id = $1', [s.rel])).rows[0]).toEqual({ status: 'pending', decided_by: null });
    expect(await buildOf()).toEqual([expect.objectContaining({ status: 'queued', decidedBy: ADMIN })]); // the inert row, with the first admin
    await new Promise((r) => setTimeout(r, 200));
    expect((await buildOf())[0]!.status).toBe('queued'); // the release is not released: the builder never takes it
    expect(s.docker.verbs().filter((v) => v === 'create')).toEqual([]);

    expect(await s.approve(ADMIN2)).toMatchObject({ ok: true, result: 'released' });
    expect((await buildOf())[0]).toMatchObject({ decidedBy: ADMIN2 });
    await vi.waitFor(async () => expect((await buildOf())[0]!.status).toBe('staged'), { timeout: 10_000 });
    expect((await db.pool.query('SELECT status, added_by AS "addedBy" FROM mcp_servers')).rows).toEqual([{ status: 'pending', addedBy: ADMIN2 }]);
  }, 30_000);

  it('the forge switched off after the approve: the queued build waits (nothing is built), and builds when it is switched on again', async () => {
    const s = await setup();
    await s.t.app.services.cfg.set('forge.enabled', false, 'test');
    await s.approve(ADMIN).catch(() => undefined);
    expect((await db.pool.query('SELECT status FROM releases WHERE id = $1', [s.rel])).rows[0].status).toBe('pending'); // decide refuses while off: `off`, the row stays pending
    expect(await buildOf()).toEqual([]);
    await s.t.app.services.cfg.set('forge.enabled', true, 'test');
    expect(await s.approve(ADMIN)).toMatchObject({ ok: true });
    await vi.waitFor(async () => expect((await buildOf())[0]?.status).toBe('staged'), { timeout: 10_000 });
  }, 30_000);

  it('a project cancelled before the build ran cancels the queued build and the forge (reconcile), and nothing is built', async () => {
    // Root cause of the old flake: the reconcile commits the forge `cancelled` in its per-forge transaction and cancels the queued builds in a LATER statement, and the old test polled only the forge row
    // (and let the 40 ms tick run while it arranged the state: a tick before the approve cancelled the forge first). Now the first tick is held by the gate until the state is arranged, and one waitFor
    // checks the forge and the build together.
    let open: () => void = () => undefined;
    const s = await setup(new FlakyPort(), new Promise<void>((r) => { open = r; }));
    await db.pool.query("UPDATE plugin_forges SET status = 'live' WHERE id = $1", [s.f.forgeId]);
    expect(await s.approve(ADMIN)).toMatchObject({ ok: true, result: 'released' }); // enqueues the build while the forge is live and the project active
    expect((await buildOf())[0]!.status).toBe('queued');
    await db.pool.query("UPDATE projects SET status = 'done', closed_by = $2, closed_at = now() WHERE id = $1", [s.f.projectId, ADMIN]);
    open(); // the recover finishes, then the first tick: nothing to claim (the project is not active), the reconcile cancels the forge and then the queued build
    await vi.waitFor(async () => {
      expect((await db.pool.query('SELECT status, close_reason FROM plugin_forges')).rows[0]).toEqual({ status: 'cancelled', close_reason: 'project_closed' });
      expect((await buildOf())[0]!.status).toBe('cancelled');
    }, { timeout: 10_000 });
    expect((await buildOf())[0]!.code).toBe('forge_cancelled');
    expect(s.docker.verbs().filter((v) => v === 'create')).toEqual([]);
  }, 30_000);

  it('G2-FG-09 through the real wiring: approving the card of a forge cancelled meanwhile is refused `not_forge`; the release stays pending, nothing is enqueued, nothing is built', async () => {
    const s = await setup();
    await db.pool.query("UPDATE plugin_forges SET status = 'cancelled', closed_at = now(), close_reason = 'admin_cancel' WHERE id = $1", [s.f.forgeId]);
    expect(await s.approve(ADMIN)).toMatchObject({ ok: false, code: 'not_forge' });
    expect((await db.pool.query('SELECT status, decided_by FROM releases WHERE id = $1', [s.rel])).rows[0]).toEqual({ status: 'pending', decided_by: null });
    expect(await buildOf()).toEqual([]);
    expect(s.docker.verbs().filter((v) => v === 'create')).toEqual([]);
  }, 30_000);

  it('the tick never runs before the recover: with a released build already queued at boot, the first docker call is the recover sweep and no build starts before it', async () => {
    await on();
    scratch = scratchRoot();
    const docker = new FakeForgeDocker();
    const mcpDocker = new FakeMcpDocker();
    mcpDocker.imageId = NEW_ID;
    const f = await newForge(db.pool);
    const hb = helloBuild();
    const rel = await newRelease(db.pool, { forgeId: f.forgeId, projectId: f.projectId, sha: hb.sha256, manifest: hb.manifestSha256, zip: hb.zip, bytes: hb.zip.length, status: 'released' });
    await newBuild(db.pool, { forgeId: f.forgeId, releaseId: rel, sha: hb.sha256, manifest: hb.manifestSha256, zip: hb.zip });
    // the recover's sweep is slow (300 ms): a tick that did not wait for the recover would claim and build meanwhile
    const slowSweep = { exec: async (a: readonly string[]) => { if (a[0] === 'ps') await new Promise((r) => setTimeout(r, 300)); return docker.exec(a); } };
    const t = await boot(db.pool, { port: new FlakyPort(), mcp: { docker: mcpDocker, spawn: fixtureSpawner() }, forge: { docker: slowSweep as never, imagesDir: withBase(BASE_ID), stageRoot: scratch.root, tickMs: 5, gcMs: 600_000 } });
    app = t.app;
    await vi.waitFor(async () => expect((await buildOf())[0]?.status).toBe('staged'), { timeout: 10_000 });
    const v = docker.verbs();
    expect(v[0]).toBe('ps'); // the recover's sweep, before the base check and before any create
    expect(v.indexOf('ps')).toBeLessThan(v.indexOf('create'));
    expect((await auditsOf('forge.build')).map((o) => o.replace(/^#\d+ /, ''))).toEqual(['start', expect.stringMatching(/^staged hello /)]); // one start: nothing was requeued under a running build
  }, 30_000);
});
