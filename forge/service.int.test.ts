import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { migrate } from '../db/migrate.js';
import { ForgeRepo } from '../db/repos/forge.js';
import { ADMIN, ADMIN2, SHA, newBuild, newForge, newRelease, newServer, resetForgeTables } from '../db/repos/forge-test-helpers.js';
import { freshDb, type TestDb } from '../db/test-helpers.js';
import { BASE_ID, BASE_CONFIG, BASE_LAYERS, FakeForgeDocker, NEW_ID, helloBuild, removeScratch, scratchRoot } from './test-helpers.js';
import { ForgeService, loadBaseId, type ForgeNotice, type ForgeServiceDeps } from './service.js';
import { FORGE_BASE_ALERT, FORGE_STUCK_ALERT, NOTICE_STAGED_HQ_ADOPTED, NOTICE_STAGED_SOFTWARE } from './texts.js';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'db', 'migrations');
let db: TestDb;
let repo: ForgeRepo;
let scratch: { root: string; parent: string };
beforeAll(async () => { db = await freshDb(); await migrate(db.pool, dir, 'up'); repo = new ForgeRepo(db.pool); });
afterAll(async () => { await db.close(); });
beforeEach(async () => { await resetForgeTables(db.pool); scratch = scratchRoot(); });
afterEach(async () => { await removeScratch(scratch.parent); });

const audits = async () => (await db.pool.query<{ actor: string; action: string; outcome: string }>('SELECT actor, action, outcome FROM audit_log ORDER BY id')).rows;
const buildRow = async (id: number) => (await repo.build(id))!;

/** The hello plugin, queued behind a released release in a live forge (the idea id is 1 after the reset, as forge.json says). */
async function seed(o: { attempts?: number; status?: 'queued' | 'building'; imageId?: string | null; ideaDept?: string } = {}) {
  const hb = helloBuild();
  const f = await newForge(db.pool, o.ideaDept ? { dept: o.ideaDept } : {});
  expect(f.ideaId).toBe(1);
  const rel = await newRelease(db.pool, { forgeId: f.forgeId, projectId: f.projectId, sha: hb.sha256, manifest: hb.manifestSha256, zip: hb.zip, bytes: hb.zip.length });
  const b = await newBuild(db.pool, { forgeId: f.forgeId, releaseId: rel, status: o.status ?? 'queued', sha: hb.sha256, manifest: hb.manifestSha256, zip: hb.zip, attempts: o.attempts, imageId: o.imageId === undefined ? undefined : o.imageId });
  return { f, rel, b };
}

function mk(over: Partial<ForgeServiceDeps> = {}, dockerSetup?: (d: FakeForgeDocker) => void) {
  const docker = new FakeForgeDocker();
  dockerSetup?.(docker);
  const notices: ForgeNotice[] = [];
  const logs: unknown[] = [];
  const stageCalls: unknown[][] = [];
  let halted = false;
  let enabled = true;
  const stage = vi.fn(async (...a: unknown[]) => {
    stageCalls.push(a);
    const [input, by] = a as [{ slug: string; image: string }, { releaseId: number }];
    await newServer(db.pool, { slug: input.slug, status: 'pending', releaseId: by.releaseId, imageId: input.image });
    return { ok: true as const, slug: input.slug, config12: 'abcdef012345', toolCount: 2 };
  });
  const d: ForgeServiceDeps = {
    repo, docker, stage: stage as never, baseImageId: BASE_ID, stageRoot: scratch.root, isHalted: () => halted, forgeEnabled: () => enabled, tz: () => 'Asia/Bangkok',
    audit: async (e) => { await db.pool.query('INSERT INTO audit_log (actor, action, outcome) VALUES ($1,$2,$3)', [e.actor, e.action, e.outcome ?? null]); },
    notify: async (n) => void notices.push(n), log: { error: (o: unknown) => logs.push(o) }, newSuffix: () => '0123abcd', ...over,
  };
  return { s: new ForgeService(d), d, docker, notices, logs, stage, stageCalls, setHalted: (h: boolean) => { halted = h; }, setEnabled: (e: boolean) => { enabled = e; } };
}

describe('ForgeService.tick: a build end to end (fake docker, real database)', () => {
  it('claims the oldest eligible build, builds, stages, marks build and forge staged, audits, and posts the two notices', async () => {
    const { f, rel, b } = await seed();
    const m = mk();
    await m.s.tick();
    expect(await buildRow(b)).toMatchObject({ status: 'staged', imageId: NEW_ID, baseImageId: BASE_ID, imageBytes: 100_000, attempts: 1 });
    expect((await db.pool.query('SELECT zip FROM plugin_builds WHERE id = $1', [b])).rows[0].zip).toBeNull();
    const forge = (await repo.byId(f.forgeId))!;
    expect(forge.status).toBe('staged');
    expect(forge.serverId).not.toBeNull();
    expect((await audits()).map((a) => a.outcome)).toEqual([`#${b} start`, `#${b} staged hello abcdef012345`]);
    expect(m.notices.map((n) => n.kind)).toEqual(['staged_software', 'staged_hq']);
    expect(m.notices[0]).toMatchObject({ deptId: 'software', text: `Plugin hello (release #${rel}) was built and staged. A Bot Admin must install it with /mcp approve; until then do not say it is installed.` });
    expect(m.notices[1]!.text).toBe(`Forge #${f.forgeId}: plugin hello from release #${rel} was built by code (image ${NEW_ID.slice(7, 19)}) and staged with 2 tool(s). Review: /mcp show slug:hello. Install: /mcp approve slug:hello hash:abcdef012345. Every call will ask a Bot Admin.`);
    expect(m.stageCalls[0]).toEqual([{ slug: 'hello', image: NEW_ID, departments: 'software', title: 'Hello plugin', ref: `forge:release-${rel}` }, { kind: 'release', releaseId: rel, decidedBy: ADMIN }]);
    expect(readdirSync(scratch.root)).toEqual([]);
    expect(m.docker.containers.size).toBe(0);
  });
  it('a failed build leaves the forge live, records the code, removes the image and tells the software head; no other effect', async () => {
    const { f, b } = await seed();
    const m = mk({}, (d) => { d.k.tamper = (img) => { (img.Config as Record<string, unknown>).User = ''; }; });
    await m.s.tick();
    expect(await buildRow(b)).toMatchObject({ status: 'failed', code: 'verify_failed' });
    expect((await repo.byId(f.forgeId))!.status).toBe('live');
    expect(m.docker.images.size).toBe(0);
    expect(m.notices).toEqual([expect.objectContaining({ kind: 'failed_software', text: expect.stringContaining('(verify_failed)') })]);
    expect((await audits()).map((a) => a.outcome)).toEqual([`#${b} start`, `#${b} removed ${NEW_ID.slice(7, 19)}`, `#${b} failed:verify_failed`]);
    expect(await buildRow(b)).toMatchObject({ imageRemovedAt: expect.any(Date) }); // removed and recorded
  });
  it('a halt during the build (after cp) stops at the next step boundary, cleans up, requeues and gives the attempt back; once the halt ends the next tick builds it', async () => {
    const { b } = await seed();
    let halt: (h: boolean) => void = () => undefined;
    const m = mk({}, (d) => { d.k.onExec = (a) => { if (a[0] === 'cp') halt(true); }; });
    halt = m.setHalted;
    await m.s.tick();
    expect(await buildRow(b)).toMatchObject({ status: 'queued', attempts: 0 });
    expect(m.docker.containers.size).toBe(0);
    expect(m.docker.images.size).toBe(0);
    expect(readdirSync(scratch.root)).toEqual([]);
    expect(m.docker.calls.some((c) => c[0] === 'commit')).toBe(false);
    expect((await audits()).map((a) => a.outcome)).toEqual([`#${b} start`, `#${b} requeued:halted`]);
    m.docker.k.onExec = null;
    m.setHalted(false);
    await m.s.tick();
    expect((await buildRow(b)).status).toBe('staged');
  });
  it('halted, or the switch off or throwing: the tick does nothing at all (no claim, no docker call)', async () => {
    const { b } = await seed();
    const m = mk();
    m.setHalted(true);
    await m.s.tick();
    m.setHalted(false);
    m.setEnabled(false);
    await m.s.tick();
    (m.d as { forgeEnabled: () => boolean }).forgeEnabled = () => { throw new Error('x'); };
    await m.s.tick();
    expect(await buildRow(b)).toMatchObject({ status: 'queued', attempts: 0 });
    expect(m.docker.calls).toEqual([]);
  });
  it('an unexpected exception in the build requeues WITHOUT a refund; after 3 attempts the build fails `interrupted`', async () => {
    const { b } = await seed();
    const m = mk(); // a throw through the docker port is a normal failure code; a throw anywhere else (here: the stage closure) is unexpected
    m.stage.mockImplementation(async () => { throw new RangeError('boom'); });
    await m.s.tick();
    expect(await buildRow(b)).toMatchObject({ status: 'queued', attempts: 1 });
    await m.s.tick();
    await m.s.tick();
    expect(await buildRow(b)).toMatchObject({ status: 'failed', code: 'interrupted', attempts: 3 }); // the third failed attempt ends it
    await m.s.tick();
    expect(m.docker.calls.filter((c) => c[0] === 'create')).toHaveLength(3);
    expect(m.docker.images.size).toBe(0);
    expect(JSON.stringify(m.logs)).not.toContain('boom');
  });
  it('the retained-image cap is re-checked at build time: image_cap, nothing built', async () => {
    const { b } = await seed();
    for (let i = 0; i < 8; i++) {
      const g = await newForge(db.pool);
      await newBuild(db.pool, { forgeId: g.forgeId, releaseId: await newRelease(db.pool, { forgeId: g.forgeId }), status: 'failed', imageId: `sha256:${String(i).repeat(64)}` });
    }
    const m = mk();
    await m.s.tick();
    expect(await buildRow(b)).toMatchObject({ status: 'failed', code: 'image_cap' });
    expect(m.docker.calls.filter((c) => c[0] === 'create')).toEqual([]); // only the base check ran
  });
  it('a forge that ended while the build ran: the build ends stage_state, the pending server stays, the image stays', async () => {
    const { f, b } = await seed();
    const m = mk();
    m.stage.mockImplementation(async (...a: unknown[]) => {
      const [input, by] = a as [{ slug: string; image: string }, { releaseId: number }];
      await newServer(db.pool, { slug: input.slug, status: 'pending', releaseId: by.releaseId, imageId: input.image });
      await db.pool.query("UPDATE plugin_forges SET status = 'cancelled', closed_at = now(), close_reason = 'admin_cancel' WHERE id = $1", [f.forgeId]);
      return { ok: true as const, slug: input.slug, config12: 'abcdef012345', toolCount: 2 };
    });
    await m.s.tick();
    expect(await buildRow(b)).toMatchObject({ status: 'failed', code: 'stage_state' });
    expect(m.docker.images.has(NEW_ID)).toBe(true);
    expect((await db.pool.query("SELECT status FROM mcp_servers WHERE slug = 'hello'")).rows).toEqual([{ status: 'pending' }]);
  });
  it('two concurrent ticks build once', async () => {
    const { b } = await seed();
    const m = mk();
    await Promise.all([m.s.tick(), m.s.tick()]);
    expect((await buildRow(b)).attempts).toBe(1);
    expect(m.docker.calls.filter((c) => c[0] === 'create')).toHaveLength(1);
  });
  it('the base missing: no build, one alert (not one per tick), and it recovers when the base is back', async () => {
    const { b } = await seed();
    const m = mk({}, (d) => { d.k.baseId = `sha256:${'8'.repeat(64)}`; });
    await m.s.tick();
    await m.s.tick();
    expect(m.notices).toEqual([{ kind: 'alert', text: FORGE_BASE_ALERT }]);
    expect(await buildRow(b)).toMatchObject({ status: 'queued', attempts: 0 });
    m.docker.k.baseId = BASE_ID;
    await m.s.tick();
    expect((await buildRow(b)).status).toBe('staged');
  });
  it('a missing or unusable base id (null) never builds', async () => {
    const { b } = await seed();
    const m = mk({ baseImageId: null });
    await m.s.tick();
    expect(await buildRow(b)).toMatchObject({ status: 'queued' });
    expect(m.notices).toEqual([{ kind: 'alert', text: FORGE_BASE_ALERT }]);
  });
  it('the reconcile runs on the tick: a server that became active installs the forge and the idea notice goes out; a cancelled forge cancels its queued build', async () => {
    const { f, rel } = await seed({ status: 'queued' });
    await db.pool.query("UPDATE plugin_builds SET status = 'staged', image_id = $2, base_image_id = $3, image_bytes = 1, finished_at = now(), zip = NULL, attempts = 1", [rel, NEW_ID, BASE_ID].slice(1).length ? [rel, NEW_ID, BASE_ID] : []).catch(() => undefined);
    await db.pool.query("UPDATE plugin_builds SET status = 'staged', image_id = $1, base_image_id = $2, image_bytes = 1, finished_at = now(), zip = NULL, attempts = 1", [NEW_ID, BASE_ID]);
    const sid = await newServer(db.pool, { slug: 'hello', status: 'active', releaseId: rel, imageId: NEW_ID, approvedBy: ADMIN2 });
    await db.pool.query("UPDATE plugin_forges SET status = 'staged', server_id = $2 WHERE id = $1", [f.forgeId, sid]);
    const m = mk();
    await m.s.tick();
    expect((await repo.byId(f.forgeId))!.status).toBe('installed');
    expect(m.notices).toEqual([expect.objectContaining({ kind: 'installed', deptId: 'software', text: expect.stringMatching(/^Tool idea #1 \(idea[0-9a-f]+\) is installed as MCP server hello \(1 tool\(s\), names start with mcp_w_hello_\)\. Every call asks a Bot Admin\.$/) })]);
  });
  it('never throws: a failing repository is logged by error name only', async () => {
    const m = mk({ repo: { ...repo, claimNext: async () => { throw new Error('connection secret postgres://u:p@h/db'); } } as never });
    await expect(m.s.tick()).resolves.toBeUndefined();
    expect(JSON.stringify(m.logs)).toBe(JSON.stringify([{ errName: 'Error' }]));
    await expect(mk({ repo: { recover: async () => { throw new Error('x'); } } as never }).s.recover()).resolves.toBeUndefined();
    await expect(mk({ repo: { gcCandidates: async () => { throw new Error('x'); } } as never }).s.gc()).resolves.toBeUndefined();
  });
});

describe('notice recipients: the idea department gets the grant, the software head (the release requester) gets the build notices', () => {
  it('a forge for an idea of the sales department: staged and failed notices go to the release department (software), not to sales', async () => {
    const a = await seed({ ideaDept: 'sales' });
    const m = mk();
    await m.s.tick();
    expect(m.stageCalls[0]![0]).toMatchObject({ departments: 'sales' }); // the grant is the idea department (F9)
    expect(m.notices.filter((n) => n.kind === 'staged_software')).toEqual([expect.objectContaining({ deptId: 'software' })]);
    await resetForgeTables(db.pool);
    const b = await seed({ ideaDept: 'sales' });
    const f = mk({}, (d) => { d.k.tamper = (img) => { (img.Config as Record<string, unknown>).User = ''; }; });
    await f.s.tick();
    expect(f.notices).toEqual([expect.objectContaining({ kind: 'failed_software', deptId: 'software' })]);
    expect(a.b).toBeGreaterThan(0); expect(b.b).toBeGreaterThan(0);
  });
  it('installed: one notice to the idea department and one to the release (software) department; one when they are the same', async () => {
    for (const idea of ['sales', 'software']) {
      await resetForgeTables(db.pool);
      const { f, rel } = await seed({ ideaDept: idea });
      await db.pool.query("UPDATE plugin_builds SET status = 'staged', image_id = $1, base_image_id = $2, image_bytes = 1, finished_at = now(), zip = NULL, attempts = 1", [NEW_ID, BASE_ID]);
      const sid = await newServer(db.pool, { slug: 'hello', status: 'active', releaseId: rel, imageId: NEW_ID, approvedBy: ADMIN2 });
      await db.pool.query("UPDATE plugin_forges SET status = 'staged', server_id = $2 WHERE id = $1", [f.forgeId, sid]);
      const m = mk();
      await m.s.tick();
      const to = m.notices.filter((n) => n.kind === 'installed').map((n) => (n as { deptId: string }).deptId).sort();
      expect(to, idea).toEqual(idea === 'sales' ? ['sales', 'software'] : ['software']);
    }
  });
});

describe('ForgeService.recover (3.6, PF-C3, PF-C5, PF-C6)', () => {
  const mine = (build: number) => ({ Id: NEW_ID, Os: 'linux', Size: 1, Config: { Labels: { 'assistant.forge': '1', 'assistant.forge.build': String(build), 'assistant.forge.sha256': SHA } }, RootFS: { Layers: BASE_LAYERS } });
  it('cleans exactly named stage children, sweeps containers by exact name, removes the image of a building row before requeueing it (no refund), and checks the base', async () => {
    const { b } = await seed({ status: 'building', imageId: NEW_ID });
    mkdirSync(join(scratch.root, 'b-AbC123'));
    mkdirSync(join(scratch.root, 'keep-me'));
    const m = mk({}, (d) => {
      d.images.set(NEW_ID, mine(b));
      for (const n of ['forge-b7-deadbeef', 'myforge-bar', 'xforge-b1-deadbeef']) d.containers.add(n);
    });
    await m.s.recover();
    expect(readdirSync(scratch.root)).toEqual(['keep-me']);
    expect([...m.docker.containers].sort()).toEqual(['myforge-bar', 'xforge-b1-deadbeef']);
    expect(m.docker.images.has(NEW_ID)).toBe(false);
    expect(await buildRow(b)).toMatchObject({ status: 'queued', attempts: 1, imageId: null }); // the removed image is forgotten; the attempt stays used
    expect((await audits()).map((a) => a.outcome)).toEqual([`#${b} removed ${NEW_ID.slice(7, 19)}`, `#${b} requeued:interrupted`]);
    expect(m.notices).toEqual([]);
  });
  it('a building row at 3 attempts fails `interrupted`', async () => {
    const { b } = await seed({ status: 'building', attempts: 3, imageId: null });
    await mk().s.recover();
    expect(await buildRow(b)).toMatchObject({ status: 'failed', code: 'interrupted' });
  });
  it('an image that a pending server holds is NOT removed (the stage had already succeeded); the row is requeued and the next attempt adopts the server', async () => {
    const { f, rel, b } = await seed({ status: 'building', imageId: NEW_ID });
    await newServer(db.pool, { slug: 'hello', status: 'pending', releaseId: rel, imageId: NEW_ID });
    const m = mk({}, (d) => { d.images.set(NEW_ID, {}); });
    await m.s.recover();
    expect(m.docker.images.has(NEW_ID)).toBe(true);
    expect(await buildRow(b)).toMatchObject({ status: 'queued', imageId: NEW_ID });
    await m.s.tick();
    expect(await buildRow(b)).toMatchObject({ status: 'staged', imageId: NEW_ID });
    expect(m.docker.calls.filter((c) => c[0] === 'create')).toHaveLength(0); // adopted, nothing rebuilt
    expect(m.stage).not.toHaveBeenCalled();
    expect((await audits()).at(-1)!.outcome).toBe(`#${b} staged hello adopted`);
    // BE1 note resolved in BE2: an adopted build still alerts #setting (a crash after the stage lost the first alert); with no McpAdmin in reach the text points to /mcp show, which prints the approve token
    expect(m.notices.map((n) => n.kind)).toEqual(['staged_software', 'staged_hq']);
    expect(m.notices[0]).toMatchObject({ kind: 'staged_software', text: NOTICE_STAGED_SOFTWARE('hello', rel) });
    expect(m.notices[1]).toEqual({ kind: 'staged_hq', text: NOTICE_STAGED_HQ_ADOPTED(f.forgeId, 'hello', rel, NEW_ID) });
    expect(NOTICE_STAGED_HQ_ADOPTED(f.forgeId, 'hello', rel, NEW_ID)).toBe(`Forge #${f.forgeId}: plugin hello from release #${rel} was built by code (image ${NEW_ID.slice(7, 19)}) and staged earlier; it waits for a Bot Admin. Review and get the install token: /mcp show slug:hello. Every call will ask a Bot Admin.`);
  });
  it('an image that cannot be removed fails the row `stuck`, latches the service and posts the incident once; later ticks build nothing', async () => {
    const { b } = await seed({ status: 'building', imageId: NEW_ID });
    const m = mk({}, (d) => { d.images.set(NEW_ID, mine(b)); d.k.imageRmFails = true; });
    await m.s.recover();
    expect(await buildRow(b)).toMatchObject({ status: 'failed', code: 'stuck' });
    expect(m.s.latch.stuck).toBe(true);
    expect(m.notices).toEqual([{ kind: 'alert', text: FORGE_STUCK_ALERT }]);
    await newForgeQueued();
    await m.s.tick();
    expect(m.docker.calls.filter((c) => c[0] === 'create')).toHaveLength(0);
    async function newForgeQueued(): Promise<void> { const g = await newForge(db.pool); await newBuild(db.pool, { forgeId: g.forgeId, releaseId: await newRelease(db.pool, { forgeId: g.forgeId }) }); }
  });
  it('G2-FG-13: a DB image id that is not forge-labelled for this build is never removed: the row fails `stuck`, the latch is set, no rm runs', async () => {
    for (const other of [null, 1]) {
      await resetForgeTables(db.pool);
      const { b } = await seed({ status: 'building', imageId: NEW_ID });
      const img = other === null ? {} : mine(b + other);
      const m = mk({}, (d) => { d.images.set(NEW_ID, img); });
      await m.s.recover();
      expect(m.docker.images.has(NEW_ID)).toBe(true);
      expect(m.docker.calls.some((c) => c[0] === 'image' && c[1] === 'rm')).toBe(false);
      expect(await buildRow(b)).toMatchObject({ status: 'failed', code: 'stuck' });
      expect(m.s.latch.stuck).toBe(true);
      expect(m.notices).toEqual([{ kind: 'alert', text: FORGE_STUCK_ALERT }]);
    }
  });
  it('a container that cannot be removed latches the service', async () => {
    const m = mk({}, (d) => { d.containers.add('forge-b9-0123abcd'); d.k.containerRmFails = true; });
    await m.s.recover();
    expect(m.s.latch.stuck).toBe(true);
    expect(m.notices).toContainEqual({ kind: 'alert', text: FORGE_STUCK_ALERT });
  });
  it('an unsafe stage root is reported and nothing in it is touched', async () => {
    mkdirSync(join(scratch.root, 'b-AbC123'));
    const { chmodSync } = await import('node:fs');
    chmodSync(scratch.root, 0o755);
    const m = mk();
    await m.s.recover();
    expect(readdirSync(scratch.root)).toEqual(['b-AbC123']);
    expect(JSON.stringify(m.logs)).toContain('stage_root');
  });
});

describe('ForgeService.gc (3.7, FG-AC15, PF-C5)', () => {
  const labelled = (build: number, over: Record<string, string> = {}) => ({ Id: '', Os: 'linux', Size: 1, Config: { Labels: { 'assistant.forge': '1', 'assistant.forge.build': String(build), 'assistant.forge.sha256': SHA, ...over } }, RootFS: { Layers: [...BASE_LAYERS, `sha256:${'d'.repeat(64)}`] } });
  const put = (d: FakeForgeDocker, id: string, img: Record<string, unknown>): void => { d.images.set(id, { ...img, Id: id }); };
  it('removes a failed build\'s labelled image without -f, records it, audits forge.gc; the base, unlabelled and mislabelled images are untouched', async () => {
    const f = await newForge(db.pool);
    const b = await newBuild(db.pool, { forgeId: f.forgeId, releaseId: await newRelease(db.pool, { forgeId: f.forgeId }), status: 'failed', imageId: NEW_ID });
    const other = `sha256:${'5'.repeat(64)}`;
    const m = mk({}, (d) => {
      put(d, NEW_ID, labelled(b));
      put(d, other, { Os: 'linux', Size: 1, Config: { Labels: null }, RootFS: { Layers: BASE_LAYERS } });
    });
    await m.s.gc();
    expect(m.docker.images.has(NEW_ID)).toBe(false);
    expect(m.docker.images.has(other)).toBe(true);
    expect((await buildRow(b)).imageRemovedAt).not.toBeNull();
    expect((await audits()).at(-1)).toEqual({ actor: 'system:forge', action: 'forge.gc', outcome: `#${b} removed ${NEW_ID.slice(7, 19)}` });
    expect(m.docker.calls.filter((c) => c[0] === 'image' && c[1] === 'rm')).toEqual([['image', 'rm', '--no-prune', NEW_ID]]);
  });
  it('rule (b): a label naming another build, a missing label, or a malformed one: not removed', async () => {
    for (const img of [labelled(999), labelled(0, { 'assistant.forge.build': 'x' }), { Os: 'linux', Size: 1, Config: { Labels: { 'assistant.forge.build': '1' } }, RootFS: { Layers: BASE_LAYERS } }]) {
      await resetForgeTables(db.pool);
      const f = await newForge(db.pool);
      const b = await newBuild(db.pool, { forgeId: f.forgeId, releaseId: await newRelease(db.pool, { forgeId: f.forgeId }), status: 'failed', imageId: NEW_ID });
      const m = mk({}, (d) => { put(d, NEW_ID, img); });
      await m.s.gc();
      expect(m.docker.images.has(NEW_ID)).toBe(true);
      expect((await buildRow(b)).imageRemovedAt).toBeNull();
    }
  });
  it('rule (c): an image a pending, active or quarantined server holds is never removed', async () => {
    for (const st of ['pending', 'active', 'quarantined'] as const) {
      await resetForgeTables(db.pool);
      const f = await newForge(db.pool);
      const rel = await newRelease(db.pool, { forgeId: f.forgeId });
      const b = await newBuild(db.pool, { forgeId: f.forgeId, releaseId: rel, status: 'failed', imageId: NEW_ID });
      await newServer(db.pool, { slug: 'adm', status: st, imageId: NEW_ID });
      const m = mk({}, (d) => { put(d, NEW_ID, labelled(b)); });
      await m.s.gc();
      expect(m.docker.images.has(NEW_ID), st).toBe(true);
    }
  });
  it('rule (d): a disabled server removes its image only after 7 days; a build without a server only after 1 hour', async () => {
    const f = await newForge(db.pool);
    const rel = await newRelease(db.pool, { forgeId: f.forgeId });
    const b = await newBuild(db.pool, { forgeId: f.forgeId, releaseId: rel, status: 'staged', imageId: NEW_ID });
    await newServer(db.pool, { slug: 'hello', status: 'disabled', releaseId: rel, imageId: NEW_ID, disabledDaysAgo: 2 });
    const m = mk({}, (d) => { put(d, NEW_ID, labelled(b)); });
    await m.s.gc();
    expect(m.docker.images.has(NEW_ID)).toBe(true);
    await db.pool.query("UPDATE mcp_servers SET disabled_at = now() - interval '8 days'");
    await m.s.gc();
    expect(m.docker.images.has(NEW_ID)).toBe(false);
  });
  it('a failed removal is audited failed:rm and the image stays recorded', async () => {
    const f = await newForge(db.pool);
    const b = await newBuild(db.pool, { forgeId: f.forgeId, releaseId: await newRelease(db.pool, { forgeId: f.forgeId }), status: 'failed', imageId: NEW_ID });
    const m = mk({}, (d) => { put(d, NEW_ID, labelled(b)); d.k.imageRmFails = true; });
    await m.s.gc();
    expect((await audits()).at(-1)!.outcome).toBe(`#${b} failed:rm`);
    expect((await buildRow(b)).imageRemovedAt).toBeNull();
  });
  it('skipped while halted', async () => {
    const f = await newForge(db.pool);
    const b = await newBuild(db.pool, { forgeId: f.forgeId, releaseId: await newRelease(db.pool, { forgeId: f.forgeId }), status: 'failed', imageId: NEW_ID });
    const m = mk({}, (d) => { put(d, NEW_ID, labelled(b)); });
    m.setHalted(true);
    await m.s.gc();
    expect(m.docker.calls).toEqual([]);
  });
  describe('PF-C5 orphans: a forge-labelled image the daemon lists that no row owns', () => {
    it('removed when its label names a build whose image_id is NULL or different, no server holds it, and the build is not running; audited without a row update', async () => {
      const f = await newForge(db.pool);
      const rel = await newRelease(db.pool, { forgeId: f.forgeId });
      const b = await newBuild(db.pool, { forgeId: f.forgeId, releaseId: rel, status: 'failed', code: 'commit_failed', imageId: null });
      const g = await newForge(db.pool);
      const b2 = await newBuild(db.pool, { forgeId: g.forgeId, releaseId: await newRelease(db.pool, { forgeId: g.forgeId }), status: 'failed', imageId: `sha256:${'6'.repeat(64)}` });
      const o1 = `sha256:${'a'.repeat(64)}`; const o2 = `sha256:${'b'.repeat(64)}`;
      const m = mk({}, (d) => { put(d, o1, labelled(b)); put(d, o2, labelled(b2)); });
      await m.s.gc();
      expect(m.docker.images.has(o1)).toBe(false);
      expect(m.docker.images.has(o2)).toBe(false);
      expect((await audits()).map((a) => a.outcome).sort()).toEqual([`#${b} removed ${o1.slice(7, 19)}`, `#${b2} removed ${o2.slice(7, 19)}`].sort());
    });
    it('G2-FG-06: a foreign image that copies the forge labels is never removed (wrong sha256 label, a server of ANY status holds it, or the layers are not the base plus one)', async () => {
      const mkCase = async (): Promise<{ b: number }> => {
        await resetForgeTables(db.pool);
        const f = await newForge(db.pool);
        const b = await newBuild(db.pool, { forgeId: f.forgeId, releaseId: await newRelease(db.pool, { forgeId: f.forgeId }), status: 'failed', imageId: null });
        return { b };
      };
      const X = `sha256:${'9'.repeat(64)}`;
      const cases: [string, (b: number) => Promise<Record<string, unknown>>][] = [
        ['wrong sha256 label', async (b) => labelled(b, { 'assistant.forge.sha256': 'c'.repeat(64) })],
        ['missing sha256 label', async (b) => { const i = labelled(b) as { Config: { Labels: Record<string, string> } }; delete i.Config.Labels['assistant.forge.sha256']; return i; }],
        ['a disabled admin server holds it', async (b) => { await newServer(db.pool, { slug: 'adm', status: 'disabled', imageId: X, disabledDaysAgo: 30 }); return labelled(b); }],
        ['no extra layer', async (b) => ({ ...labelled(b), RootFS: { Layers: BASE_LAYERS } })],
        ['two extra layers', async (b) => ({ ...labelled(b), RootFS: { Layers: [...BASE_LAYERS, `sha256:${'d'.repeat(64)}`, `sha256:${'e'.repeat(64)}`] } })],
        ['other base layers', async (b) => ({ ...labelled(b), RootFS: { Layers: [`sha256:${'7'.repeat(64)}`, ...BASE_LAYERS.slice(1), `sha256:${'d'.repeat(64)}`] } })],
      ];
      for (const [why, build] of cases) {
        const { b } = await mkCase();
        const img = await build(b);
        const m = mk({}, (d) => { put(d, X, img); });
        await m.s.gc();
        expect(m.docker.images.has(X), why).toBe(true);
        expect(m.docker.calls.filter((c) => c[0] === 'image' && c[1] === 'rm'), why).toEqual([]);
      }
    });
    it('G2-FG-06: no orphan is removed when the base image cannot be inspected', async () => {
      const f = await newForge(db.pool);
      const b = await newBuild(db.pool, { forgeId: f.forgeId, releaseId: await newRelease(db.pool, { forgeId: f.forgeId }), status: 'failed', imageId: null });
      const X = `sha256:${'9'.repeat(64)}`;
      const m = mk({ baseImageId: null }, (d) => { put(d, X, labelled(b)); });
      await m.s.gc();
      expect(m.docker.images.has(X)).toBe(true);
    });
    it('kept when a row owns it, the build is unknown, the build is still building, a server holds it, the label is missing, or it is not forge-labelled', async () => {
      const f = await newForge(db.pool);
      const owned = await newBuild(db.pool, { forgeId: f.forgeId, releaseId: await newRelease(db.pool, { forgeId: f.forgeId }), status: 'staged', imageId: NEW_ID });
      const g = await newForge(db.pool);
      const running = await newBuild(db.pool, { forgeId: g.forgeId, releaseId: await newRelease(db.pool, { forgeId: g.forgeId }), status: 'building', imageId: null });
      const h = await newForge(db.pool);
      const heldB = await newBuild(db.pool, { forgeId: h.forgeId, releaseId: await newRelease(db.pool, { forgeId: h.forgeId }), status: 'failed', imageId: null });
      const ids = ['1', '2', '3', '4', '5'].map((c) => `sha256:${c.repeat(64)}`);
      await newServer(db.pool, { slug: 'adm', status: 'pending', imageId: ids[3]! });
      const m = mk({}, (d) => {
        put(d, NEW_ID, labelled(owned)); // owned by a row (staged, kept)
        put(d, ids[0]!, labelled(424242)); // unknown build
        put(d, ids[1]!, labelled(running)); // build still running
        put(d, ids[2]!, { Os: 'linux', Size: 1, Config: { Labels: null }, RootFS: { Layers: BASE_LAYERS } }); // not labelled
        put(d, ids[3]!, labelled(heldB)); // held by a server
        put(d, ids[4]!, { Os: 'linux', Size: 1, Config: { Labels: { 'assistant.forge': '1' } }, RootFS: { Layers: BASE_LAYERS } }); // no build label
      });
      const before = new Set(m.docker.images.keys());
      await m.s.gc();
      expect(new Set(m.docker.images.keys())).toEqual(before);
    });
  });
});

describe('G2-FG-11: a stale `building` row while the switch is off does not block /forge cancel forever', () => {
  const stale = async (imageId: string | null) => {
    const { f, b } = await seed({ status: 'building', imageId });
    return { f, b };
  };
  it('switch off, no build running here, the stale row has no image: it is requeued (no Docker, no refund) and the cancel goes through; the build ends cancelled', async () => {
    const { f, b } = await stale(null);
    const m = mk();
    m.setEnabled(false);
    expect(await m.s.cancel({ id: f.forgeId, userId: ADMIN })).toMatchObject({ ok: true });
    expect((await repo.byId(f.forgeId))!.status).toBe('cancelled');
    expect(await buildRow(b)).toMatchObject({ status: 'cancelled', code: 'forge_cancelled' });
    expect(m.docker.calls).toEqual([]);
  });
  it('switch on: still `busy` (the recover owns the row); a stale row WITH an image id: still `busy` while off (removing it needs Docker)', async () => {
    const a = await stale(null);
    const on = mk();
    expect(await on.s.cancel({ id: a.f.forgeId, userId: ADMIN })).toEqual({ ok: false, code: 'busy' });
    expect((await buildRow(a.b)).status).toBe('building');
    await resetForgeTables(db.pool);
    const c = await stale(NEW_ID);
    const off = mk();
    off.setEnabled(false);
    expect(await off.s.cancel({ id: c.f.forgeId, userId: ADMIN })).toEqual({ ok: false, code: 'busy' });
    expect((await buildRow(c.b)).status).toBe('building');
    expect(off.docker.calls).toEqual([]);
  });
  it('cancelling a forge that has no building row never requeues another forge\'s stale row (at most one build is `building` at a time)', async () => {
    const a = await stale(null);
    const g = await newForge(db.pool);
    const m = mk();
    m.setEnabled(false);
    expect(await m.s.cancel({ id: g.forgeId, userId: ADMIN })).toMatchObject({ ok: true });
    expect((await buildRow(a.b)).status).toBe('building');
  });
  it('a switch that cannot be read counts as off', async () => {
    const { f, b } = await stale(null);
    const m = mk({ forgeEnabled: () => { throw new Error('x'); } });
    expect(await m.s.cancel({ id: f.forgeId, userId: ADMIN })).toMatchObject({ ok: true });
    expect((await buildRow(b)).status).toBe('cancelled');
  });
});

describe('loadBaseId', () => {
  const file = (text: string): string => { const d = mkdtempSync(join(scratch.parent, 'img-')); const p = join(d, 'images.json'); writeFileSync(p, text); return p; };
  it('reads {"base":"sha256:..."} and nothing else', () => {
    expect(loadBaseId(file(`{"base":"${BASE_ID}"}\n`))).toBe(BASE_ID);
    expect(loadBaseId(file('{"base":"latest"}'))).toBeNull();
    expect(loadBaseId(file('{"base":1}'))).toBeNull();
    expect(loadBaseId(file('{}'))).toBeNull();
    expect(loadBaseId(file('[]'))).toBeNull();
    expect(loadBaseId(file('null'))).toBeNull();
    expect(loadBaseId(file('not json'))).toBeNull();
    expect(loadBaseId(file(`{"__proto__":{"x":1},"base":"${BASE_ID}"}`))).toBeNull();
    expect(loadBaseId(file(`{"base":"${BASE_ID}","pad":"${'x'.repeat(2000)}"}`))).toBeNull();
    expect(loadBaseId(join(scratch.parent, 'missing.json'))).toBeNull();
  });
});

void BASE_CONFIG; void ADMIN2;
