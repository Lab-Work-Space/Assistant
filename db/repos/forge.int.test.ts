import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../migrate.js';
import { freshDb, type TestDb } from '../test-helpers.js';
import { ForgeRepo } from './forge.js';
import { ADMIN, ADMIN2, BASE, IMG, MAN, SHA, newBuild, newForge, newRelease, newServer, resetForgeTables } from './forge-test-helpers.js';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
let db: TestDb;
let repo: ForgeRepo;
beforeAll(async () => { db = await freshDb(); await migrate(db.pool, dir, 'up'); repo = new ForgeRepo(db.pool); });
afterAll(async () => { await db.close(); });
beforeEach(async () => { await resetForgeTables(db.pool); });
const audits = async () => (await db.pool.query<{ actor: string; action: string; outcome: string }>('SELECT actor, action, outcome FROM audit_log ORDER BY id')).rows;
const build = async (id: number) => (await repo.build(id))!;
const forgeOf = async (id: number) => (await repo.byId(id))!;
const NB = (over: Partial<Parameters<ForgeRepo['enqueue']>[0]> = {}) => ({ releaseId: 1, forgeId: 1, pluginSlug: 'hello', sha256: SHA, bytes: 3, manifestSha256: MAN, decidedBy: ADMIN, zip: Buffer.from('abc'), ...over });

describe('ForgeRepo.enqueue (3.4 step 1, PF-C11)', () => {
  it('inserts an inert queued build once; the same release again is `exists` unless it is the same queued build', async () => {
    const f = await newForge(db.pool);
    const rel = await newRelease(db.pool, { forgeId: f.forgeId });
    expect(await repo.enqueue(NB({ releaseId: rel, forgeId: f.forgeId }))).toEqual({ ok: true });
    expect(await build((await db.pool.query<{ id: number }>('SELECT id FROM plugin_builds')).rows[0]!.id)).toMatchObject({ status: 'queued', attempts: 0, decidedBy: ADMIN, pluginSlug: 'hello', sha256: SHA, manifestSha256: MAN });
    // PF-C11: a re-approve by another admin after a certain revert updates only decided_by
    expect(await repo.enqueue(NB({ releaseId: rel, forgeId: f.forgeId, decidedBy: ADMIN2 }))).toEqual({ ok: true });
    expect((await db.pool.query('SELECT decided_by FROM plugin_builds')).rows).toEqual([{ decided_by: ADMIN2 }]);
    // anything else on a conflict is refused and changes nothing
    for (const over of [{ sha256: 'f'.repeat(64) }, { manifestSha256: 'f'.repeat(64) }, { pluginSlug: 'other' }, { forgeId: f.forgeId + 1 }]) {
      expect(await repo.enqueue(NB({ releaseId: rel, forgeId: f.forgeId, decidedBy: ADMIN, ...over })), JSON.stringify(over)).toEqual({ ok: false, code: 'exists' });
    }
    expect((await db.pool.query('SELECT decided_by FROM plugin_builds')).rows).toEqual([{ decided_by: ADMIN2 }]);
  });
  it('a conflict row that is not queued is never updated', async () => {
    const f = await newForge(db.pool);
    const rel = await newRelease(db.pool, { forgeId: f.forgeId });
    const b = await newBuild(db.pool, { forgeId: f.forgeId, releaseId: rel, status: 'building' });
    expect(await repo.enqueue(NB({ releaseId: rel, forgeId: f.forgeId, decidedBy: ADMIN2 }))).toEqual({ ok: false, code: 'exists' });
    expect((await build(b)).decidedBy).toBe(ADMIN);
  });
  it('the DB refuses a zip whose length differs from bytes', async () => {
    const f = await newForge(db.pool);
    const rel = await newRelease(db.pool, { forgeId: f.forgeId });
    await expect(repo.enqueue(NB({ releaseId: rel, forgeId: f.forgeId, bytes: 99 }))).rejects.toThrow(/plugin_builds_zip/);
  });
});

describe('ForgeRepo.claimNext (single flight, attempts, eligibility)', () => {
  it('claims the oldest queued build whose release is released and forge live: building, attempts + 1, the throwing audit row, the zip and the release hashes', async () => {
    const f = await newForge(db.pool);
    const r1 = await newRelease(db.pool, { forgeId: f.forgeId });
    const b1 = await newBuild(db.pool, { forgeId: f.forgeId, releaseId: r1, createdAgo: '2 minutes', zip: Buffer.from('one') });
    const f2 = await newForge(db.pool);
    const r2 = await newRelease(db.pool, { forgeId: f2.forgeId });
    await newBuild(db.pool, { forgeId: f2.forgeId, releaseId: r2, createdAgo: '1 minute' });
    const c = (await repo.claimNext())!;
    expect(c).toMatchObject({ id: b1, status: 'building', attempts: 1, releaseSha256: SHA, releaseManifestSha256: MAN, ideaId: f.ideaId, deptId: 'software', decidedBy: ADMIN });
    expect(c.zip.toString()).toBe('one');
    expect(await audits()).toEqual([{ actor: 'system:forge', action: 'forge.build', outcome: `#${b1} start` }]);
    expect(await repo.claimNext()).toBeNull(); // one building at a time
    expect((await build(b1)).startedAt).not.toBeNull();
  });
  it('skips a build whose release is not released, whose forge is not live, or that has used 3 attempts; nothing is claimed and no row is written', async () => {
    const f = await newForge(db.pool);
    const rp = await newRelease(db.pool, { forgeId: f.forgeId, status: 'failed' });
    await newBuild(db.pool, { forgeId: f.forgeId, releaseId: rp });
    const g = await newForge(db.pool, { status: 'cancelled' });
    await newBuild(db.pool, { forgeId: g.forgeId, releaseId: await newRelease(db.pool, { forgeId: g.forgeId }) });
    const h = await newForge(db.pool);
    await newBuild(db.pool, { forgeId: h.forgeId, releaseId: await newRelease(db.pool, { forgeId: h.forgeId }), attempts: 3 });
    expect(await repo.claimNext()).toBeNull();
    expect(await audits()).toEqual([]);
  });
  it('the unique index is the single flight: two concurrent claims give one build', async () => {
    for (let i = 0; i < 2; i++) { const f = await newForge(db.pool); await newBuild(db.pool, { forgeId: f.forgeId, releaseId: await newRelease(db.pool, { forgeId: f.forgeId }) }); }
    const rs = await Promise.all([repo.claimNext(), repo.claimNext(), repo.claimNext()]);
    expect(rs.filter((r) => r !== null)).toHaveLength(1);
    expect((await db.pool.query("SELECT count(*)::int AS n FROM plugin_builds WHERE status = 'building'")).rows[0]).toEqual({ n: 1 });
  });
  it('a failing audit insert rolls the claim back', async () => {
    const f = await newForge(db.pool);
    const b = await newBuild(db.pool, { forgeId: f.forgeId, releaseId: await newRelease(db.pool, { forgeId: f.forgeId }) });
    await db.pool.query('ALTER TABLE audit_log ADD CONSTRAINT fail_forge CHECK (action <> \'forge.build\') NOT VALID');
    try { await expect(repo.claimNext()).rejects.toThrow(/fail_forge/); } finally { await db.pool.query('ALTER TABLE audit_log DROP CONSTRAINT fail_forge'); }
    expect(await build(b)).toMatchObject({ status: 'queued', attempts: 0 });
  });
});

describe('ForgeRepo.requeue / fail / recordImage / staged', () => {
  const claimed = async () => {
    const f = await newForge(db.pool);
    const rel = await newRelease(db.pool, { forgeId: f.forgeId });
    await newBuild(db.pool, { forgeId: f.forgeId, releaseId: rel });
    return { f, rel, c: (await repo.claimNext())! };
  };
  it('a halt requeue refunds the attempt; an interrupted requeue does not; at 3 attempts an interrupted build fails with `interrupted`', async () => {
    const { c } = await claimed();
    expect(await repo.requeue(c.id, { why: 'halted', refund: true })).toBe('queued');
    expect(await build(c.id)).toMatchObject({ status: 'queued', attempts: 0, startedAt: null });
    expect(await repo.requeue(c.id, { why: 'halted', refund: true })).toBeNull(); // no longer building
    await repo.claimNext();
    expect(await repo.requeue(c.id, { why: 'interrupted', refund: false })).toBe('queued');
    expect((await build(c.id)).attempts).toBe(1);
    await db.pool.query("UPDATE plugin_builds SET status = 'building', attempts = 3, started_at = now() WHERE id = $1", [c.id]);
    expect(await repo.requeue(c.id, { why: 'interrupted', refund: false })).toBe('failed');
    expect(await build(c.id)).toMatchObject({ status: 'failed', code: 'interrupted' });
    expect((await db.pool.query('SELECT zip FROM plugin_builds WHERE id = $1', [c.id])).rows[0]!.zip).toBeNull();
    expect((await audits()).map((a) => a.outcome)).toEqual([`#${c.id} start`, `#${c.id} requeued:halted`, `#${c.id} start`, `#${c.id} requeued:interrupted`, `#${c.id} failed:interrupted`]);
  });
  it('requeue forgets an image whose removal was recorded (the next attempt records its own) and keeps one that was not removed', async () => {
    const { c } = await claimed();
    await repo.recordImage(c.id, IMG);
    await repo.imageRemoved(c.id, IMG.slice(7, 19));
    expect(await repo.requeue(c.id, { why: 'halted', refund: true })).toBe('queued');
    expect(await build(c.id)).toMatchObject({ imageId: null, imageRemovedAt: null });
    await repo.claimNext();
    expect(await repo.recordImage(c.id, `sha256:${'3'.repeat(64)}`)).toBe(true);
    expect(await repo.requeue(c.id, { why: 'interrupted', refund: false })).toBe('queued');
    expect(await build(c.id)).toMatchObject({ imageId: `sha256:${'3'.repeat(64)}`, imageRemovedAt: null });
  });
  it('fail: a closed code, zip dropped, the image id kept; a terminal row is untouched; a bad code throws', async () => {
    const { c } = await claimed();
    expect(await repo.recordImage(c.id, IMG)).toBe(true);
    expect(await repo.fail(c.id, 'verify_failed')).toBe(true);
    expect(await build(c.id)).toMatchObject({ status: 'failed', code: 'verify_failed', imageId: IMG });
    expect(await repo.fail(c.id, 'stuck')).toBe(false);
    await expect(repo.fail(c.id, 'Bad Code!')).rejects.toThrow();
    const f = await newForge(db.pool);
    const q = await newBuild(db.pool, { forgeId: f.forgeId, releaseId: await newRelease(db.pool, { forgeId: f.forgeId }) });
    expect(await repo.fail(q, 'plugin_invalid')).toBe(true); // a queued build can fail at enqueue
  });
  it('PF-C5 recordImage: one statement, only while building, only once, only a sha256 id', async () => {
    const { c } = await claimed();
    expect(await repo.recordImage(c.id, IMG)).toBe(true);
    expect(await repo.recordImage(c.id, `sha256:${'3'.repeat(64)}`)).toBe(false);
    expect((await build(c.id)).imageId).toBe(IMG);
    await expect(repo.recordImage(c.id, 'latest')).rejects.toThrow();
    const f = await newForge(db.pool);
    const q = await newBuild(db.pool, { forgeId: f.forgeId, releaseId: await newRelease(db.pool, { forgeId: f.forgeId }) });
    expect(await repo.recordImage(q, IMG)).toBe(false);
  });
  it('staged: build and forge change together with the throwing audit row; a forge that is no longer live changes nothing', async () => {
    const { f, c, rel } = await claimed();
    const sid = await newServer(db.pool, { releaseId: rel, status: 'pending' });
    await repo.recordImage(c.id, IMG);
    expect(await repo.staged(c.id, { imageId: IMG, baseImageId: BASE, imageBytes: 1234, serverId: sid, slug: 'hello', cfg12: 'abcdef012345' })).toBe(true);
    expect(await build(c.id)).toMatchObject({ status: 'staged', imageId: IMG, baseImageId: BASE, imageBytes: 1234 });
    expect(await forgeOf(f.forgeId)).toMatchObject({ status: 'staged', serverId: sid });
    expect((await audits()).at(-1)).toEqual({ actor: 'system:forge', action: 'forge.build', outcome: `#${c.id} staged hello abcdef012345` });
    expect((await db.pool.query('SELECT zip FROM plugin_builds WHERE id = $1', [c.id])).rows[0]!.zip).toBeNull();
    // cancelled while it ran
    const g = await newForge(db.pool);
    const r2 = await newRelease(db.pool, { forgeId: g.forgeId });
    const b2 = await newBuild(db.pool, { forgeId: g.forgeId, releaseId: r2, status: 'building' });
    await db.pool.query("UPDATE plugin_forges SET status = 'cancelled', closed_at = now(), close_reason = 'admin_cancel' WHERE id = $1", [g.forgeId]);
    expect(await repo.staged(b2, { imageId: IMG, baseImageId: BASE, imageBytes: 1, serverId: sid, slug: 'x', cfg12: 'abcdef012345' })).toBe(false);
    expect(await build(b2)).toMatchObject({ status: 'building', imageId: null });
  });
  it('recover lists the building rows with their image ids', async () => {
    const { c } = await claimed();
    await repo.recordImage(c.id, IMG);
    expect(await repo.recover()).toEqual([{ id: c.id, forgeId: c.forgeId, imageId: IMG, attempts: 1 }]);
  });
  it('stillLive: forge live and its project active', async () => {
    const f = await newForge(db.pool);
    expect(await repo.stillLive(f.forgeId)).toBe(true);
    await db.pool.query("UPDATE projects SET status = 'done' WHERE id = $1", [f.projectId]);
    expect(await repo.stillLive(f.forgeId)).toBe(false);
  });
});

describe('ForgeRepo.counts and caps (3.3 step 8c, FG-AC16)', () => {
  it('counts non-cancelled builds of the forge, builds created today, and kept images; capCode follows the spec order', async () => {
    const f = await newForge(db.pool);
    const mk = async (over: Parameters<typeof newBuild>[1] extends infer T ? Partial<T> : never) => newBuild(db.pool, { forgeId: f.forgeId, releaseId: await newRelease(db.pool, { forgeId: f.forgeId }), ...over });
    await mk({ status: 'failed', imageId: IMG });
    await mk({ status: 'cancelled' });
    await mk({ status: 'queued', createdAgo: '3 days' });
    expect(await repo.counts(f.forgeId, 'Asia/Bangkok')).toEqual({ forgeBuilds: 2, today: 1, images: 1 });
    expect(ForgeRepo.capCode({ forgeBuilds: 2, today: 2, images: 7 })).toBeNull();
    expect(ForgeRepo.capCode({ forgeBuilds: 3, today: 3, images: 8 })).toBe('forge_attempts');
    expect(ForgeRepo.capCode({ forgeBuilds: 0, today: 3, images: 8 })).toBe('forge_day_cap');
    expect(ForgeRepo.capCode({ forgeBuilds: 0, today: 0, images: 8 })).toBe('image_cap');
    await db.pool.query('UPDATE plugin_builds SET image_removed_at = now() WHERE image_id IS NOT NULL');
    expect((await repo.counts(f.forgeId, 'Asia/Bangkok')).images).toBe(0);
  });
});

describe('ForgeRepo.reconcile (3.2, PF-C12, FG-AC14)', () => {
  const staged = async (o: { serverStatus?: 'pending' | 'active' | 'disabled' | 'quarantined'; source?: 'admin' | 'release'; image?: string; otherForgeRelease?: boolean } = {}) => {
    const f = await newForge(db.pool, { status: 'live' });
    const rel = await newRelease(db.pool, { forgeId: f.forgeId });
    const b = await newBuild(db.pool, { forgeId: f.forgeId, releaseId: rel, status: 'staged', imageId: IMG });
    let relOfServer = rel;
    if (o.otherForgeRelease) { const g = await newForge(db.pool); relOfServer = await newRelease(db.pool, { forgeId: g.forgeId }); }
    const sid = await newServer(db.pool, { releaseId: o.source === 'admin' ? null : relOfServer, status: o.serverStatus ?? 'pending', imageId: o.image ?? IMG, approvedBy: ADMIN2 });
    await db.pool.query("UPDATE plugin_forges SET status = 'staged', server_id = $2 WHERE id = $1", [f.forgeId, sid]);
    return { f, rel, b, sid };
  };
  it('a live forge whose project is done is cancelled project_closed; cancelled after activation: project_closed; cancelled before a root existed: project_cancelled; a proposed project changes nothing', async () => {
    const a = await newForge(db.pool, { projectStatus: 'done' });
    const b = await newForge(db.pool, { projectStatus: 'active' });
    const c = await newForge(db.pool, { projectStatus: 'proposed' });
    await db.pool.query("UPDATE projects SET status = 'cancelled' WHERE id = $1", [b.projectId]); // had a root: closed after the work began
    const d = await newForge(db.pool, { projectStatus: 'proposed' });
    await db.pool.query("UPDATE projects SET status = 'cancelled' WHERE id = $1", [d.projectId]); // never activated: rejected or expired
    const ev = await repo.reconcile();
    expect(ev.filter((e) => e.kind === 'cancelled').map((e) => [e.kind === 'cancelled' ? e.forgeId : 0, e.kind === 'cancelled' ? e.reason : ''])).toEqual([[a.forgeId, 'project_closed'], [b.forgeId, 'project_closed'], [d.forgeId, 'project_cancelled']]);
    expect((await forgeOf(c.forgeId)).status).toBe('live');
    expect(await forgeOf(a.forgeId)).toMatchObject({ status: 'cancelled', closeReason: 'project_closed' });
    expect((await audits()).map((x) => x.outcome)).toEqual([`#${a.forgeId} project_closed`, `#${b.forgeId} project_closed`, `#${d.forgeId} project_cancelled`]);
    expect(await repo.reconcile()).toEqual([]); // nothing more to do
  });
  it('queued builds of a cancelled forge or of a failed, rejected or expired release are cancelled and their zip dropped; an eligible one stays', async () => {
    const f = await newForge(db.pool, { projectStatus: 'done' });
    const q1 = await newBuild(db.pool, { forgeId: f.forgeId, releaseId: await newRelease(db.pool, { forgeId: f.forgeId }) });
    const g = await newForge(db.pool);
    const q2 = await newBuild(db.pool, { forgeId: g.forgeId, releaseId: await newRelease(db.pool, { forgeId: g.forgeId, status: 'failed' }) });
    const k = await newForge(db.pool);
    const q3 = await newBuild(db.pool, { forgeId: k.forgeId, releaseId: await newRelease(db.pool, { forgeId: k.forgeId, status: 'expired' }) });
    const h = await newForge(db.pool);
    const keep = await newBuild(db.pool, { forgeId: h.forgeId, releaseId: await newRelease(db.pool, { forgeId: h.forgeId }) });
    await repo.reconcile();
    expect(await build(q1)).toMatchObject({ status: 'cancelled', code: 'forge_cancelled' });
    expect(await build(q2)).toMatchObject({ status: 'cancelled', code: 'release_failed' });
    expect(await build(q3)).toMatchObject({ status: 'cancelled', code: 'release_expired' });
    expect((await build(keep)).status).toBe('queued');
    expect((await db.pool.query('SELECT zip FROM plugin_builds WHERE id = $1', [q1])).rows[0]!.zip).toBeNull();
  });
  it('a staged forge stays staged while its own server is pending', async () => {
    const s = await staged();
    expect(await repo.reconcile()).toEqual([]);
    expect(await forgeOf(s.f.forgeId)).toMatchObject({ status: 'staged', serverId: s.sid });
  });
  it('installed: the server is active, source release, its release belongs to this forge and its image equals the build image; the idea is closed with the approver by compare-and-set', async () => {
    const s = await staged({ serverStatus: 'active' });
    const ev = await repo.reconcile();
    expect(ev).toEqual([{ kind: 'installed', forgeId: s.f.forgeId, ideaId: s.f.ideaId, ideaName: expect.stringMatching(/^idea/), deptId: 'software', releaseDeptId: 'software', slug: 'hello', approvedBy: ADMIN2, serverId: s.sid, tools: 1, closedIdea: true }]);
    expect(await forgeOf(s.f.forgeId)).toMatchObject({ status: 'installed', closeReason: 'installed' });
    expect((await db.pool.query('SELECT status, closed_by, close_reason FROM tool_ideas WHERE id = $1', [s.f.ideaId])).rows).toEqual([{ status: 'closed', closed_by: ADMIN2, close_reason: 'Installed as MCP server hello.' }]);
    expect((await audits()).at(-1)!.outcome).toBe(`#${s.f.forgeId} installed hello idea #${s.f.ideaId}`);
  });
  it('the idea close is a compare-and-set: an idea already closed is left alone (closedIdea false) but the forge is still installed', async () => {
    const s = await staged({ serverStatus: 'active' });
    await db.pool.query("UPDATE tool_ideas SET status = 'closed', closed_by = $2, closed_at = now(), close_reason = 'other' WHERE id = $1", [s.f.ideaId, ADMIN]);
    const ev = await repo.reconcile();
    expect(ev[0]).toMatchObject({ kind: 'installed', closedIdea: false });
    expect((await db.pool.query('SELECT closed_by, close_reason FROM tool_ideas WHERE id = $1', [s.f.ideaId])).rows).toEqual([{ closed_by: ADMIN, close_reason: 'other' }]);
  });
  it('PF-C12: an active server that is an admin re-add, another forge\'s release row, or has another image never installs the forge; it goes back to live and the idea stays open', async () => {
    const cases: [string, Parameters<typeof staged>[0]][] = [['admin re-add', { serverStatus: 'active', source: 'admin' }], ['other forge release', { serverStatus: 'active', otherForgeRelease: true }], ['other image', { serverStatus: 'active', image: `sha256:${'9'.repeat(64)}` }]];
    for (const [name, o] of cases) {
      await resetForgeTables(db.pool);
      const s = await staged(o);
      const ev = await repo.reconcile();
      expect(ev.map((e) => e.kind), name).toEqual(['live']);
      expect(await forgeOf(s.f.forgeId), name).toMatchObject({ status: 'live', serverId: null });
      expect((await db.pool.query('SELECT status FROM tool_ideas WHERE id = $1', [s.f.ideaId])).rows, name).toEqual([{ status: 'open' }]);
    }
  });
  it('disabled and quarantined servers send the forge back to live', async () => {
    for (const st of ['disabled', 'quarantined'] as const) {
      await resetForgeTables(db.pool);
      const s = await staged({ serverStatus: st });
      expect((await repo.reconcile()).map((e) => e.kind), st).toEqual(['live']);
      expect(await forgeOf(s.f.forgeId)).toMatchObject({ status: 'live', serverId: null });
    }
  });
});

describe('ForgeRepo.expireQueued, GC candidates, imageRemoved, day', () => {
  it('a queued build older than 7 days is cancelled:expired with its zip dropped; a younger one stays', async () => {
    const f = await newForge(db.pool);
    const old = await newBuild(db.pool, { forgeId: f.forgeId, releaseId: await newRelease(db.pool, { forgeId: f.forgeId }), createdAgo: '8 days' });
    const g = await newForge(db.pool);
    const young = await newBuild(db.pool, { forgeId: g.forgeId, releaseId: await newRelease(db.pool, { forgeId: g.forgeId }), createdAgo: '6 days' });
    expect(await repo.expireQueued()).toBe(1);
    expect(await build(old)).toMatchObject({ status: 'cancelled', code: 'expired' });
    expect((await build(young)).status).toBe('queued');
  });
  it('GC candidates (a), (c), (d): failed builds; a server disabled for 7 days; no server row 1 h after finishing; never building, never an image held by a pending, active or quarantined server, never a removed one', async () => {
    const mk = async (o: { status: 'failed' | 'staged' | 'building'; image?: string | null; server?: Parameters<typeof newServer>[1]; ago?: string }) => {
      const f = await newForge(db.pool);
      const rel = await newRelease(db.pool, { forgeId: f.forgeId });
      const image = o.image === undefined ? `sha256:${(Math.floor(Math.random() * 1e9) + '').padStart(64, '7')}` : o.image;
      const b = await newBuild(db.pool, { forgeId: f.forgeId, releaseId: rel, status: o.status, imageId: image });
      if (o.ago) await db.pool.query("UPDATE plugin_builds SET finished_at = now() - $2::interval WHERE id = $1", [b, o.ago]);
      if (o.server) await newServer(db.pool, { releaseId: rel, imageId: image ?? IMG, slug: `s${b}`, ...o.server });
      return b;
    };
    const failed = await mk({ status: 'failed' });
    const failedHeld = await mk({ status: 'failed', image: IMG });
    await newServer(db.pool, { slug: 'held', status: 'active', imageId: IMG }); // an admin row on the same image id (rule c)
    const disabledOld = await mk({ status: 'staged', server: { status: 'disabled', disabledDaysAgo: 8 } });
    const disabledNew = await mk({ status: 'staged', server: { status: 'disabled', disabledDaysAgo: 2 } });
    const pending = await mk({ status: 'staged', server: { status: 'pending' } });
    const activeS = await mk({ status: 'staged', server: { status: 'active' } });
    const quar = await mk({ status: 'staged', server: { status: 'quarantined' } });
    const noServerOld = await mk({ status: 'staged', ago: '2 hours' });
    const noServerNew = await mk({ status: 'staged', ago: '10 minutes' });
    const building = await mk({ status: 'building' });
    const removed = await mk({ status: 'failed' });
    await db.pool.query('UPDATE plugin_builds SET image_removed_at = now() WHERE id = $1', [removed]);
    const got = (await repo.gcCandidates()).map((c) => c.buildId).sort((a, b) => a - b);
    expect(got).toEqual([failed, disabledOld, noServerOld].sort((a, b) => a - b));
    for (const n of [failedHeld, disabledNew, pending, activeS, quar, noServerNew, building, removed]) expect(got).not.toContain(n);
  });
  it('imageRemoved records once with the throwing forge.gc row; imageOwner, imageInUse and imageKept answer the orphan questions', async () => {
    const f = await newForge(db.pool);
    const b = await newBuild(db.pool, { forgeId: f.forgeId, releaseId: await newRelease(db.pool, { forgeId: f.forgeId }), status: 'failed', imageId: IMG });
    expect(await repo.imageKept(IMG)).toBe(true);
    expect(await repo.imageOwner(b)).toEqual({ imageId: IMG, status: 'failed', sha256: 'a'.repeat(64) });
    expect(await repo.imageOwner(b + 100)).toBeNull();
    expect(await repo.imageInUse(IMG)).toBe(false);
    expect(await repo.imageEverHeld(IMG)).toBe(false);
    const srv = await newServer(db.pool, { slug: 'adm', status: 'pending', imageId: IMG });
    expect(await repo.imageInUse(IMG)).toBe(true);
    await db.pool.query("UPDATE mcp_servers SET status = 'disabled', approved_by = NULL, approved_at = NULL, approved_config_sha256 = NULL, disabled_by = $2, disabled_at = now() WHERE id = $1", [srv, ADMIN]);
    expect(await repo.imageInUse(IMG)).toBe(false);
    expect(await repo.imageEverHeld(IMG)).toBe(true); // G2-FG-06: a disabled row still counts
    await db.pool.query('DELETE FROM mcp_servers WHERE id = $1', [srv]);
    await newServer(db.pool, { slug: 'adm', status: 'pending', imageId: IMG });
    expect(await repo.imageRemoved(b, IMG.slice(7, 19))).toBe(true);
    expect(await repo.imageRemoved(b, IMG.slice(7, 19))).toBe(false);
    expect(await repo.imageKept(IMG)).toBe(false);
    expect(await audits()).toEqual([{ actor: 'system:forge', action: 'forge.gc', outcome: `#${b} removed ${IMG.slice(7, 19)}` }]);
  });
  it('day: today counts; waiting is the forges staged now', async () => {
    const f = await newForge(db.pool, { status: 'staged', serverId: await newServer(db.pool, { slug: 'wait' }) });
    await newBuild(db.pool, { forgeId: f.forgeId, releaseId: await newRelease(db.pool, { forgeId: f.forgeId }), status: 'staged' });
    const g = await newForge(db.pool);
    await newBuild(db.pool, { forgeId: g.forgeId, releaseId: await newRelease(db.pool, { forgeId: g.forgeId }), status: 'failed' });
    expect(await repo.day('Asia/Bangkok')).toEqual({ builds: 2, staged: 1, failed: 1, installed: 0, waiting: 1 });
  });
  it('list and byProject read rows', async () => {
    const f = await newForge(db.pool);
    expect((await repo.list()).map((r) => r.id)).toEqual([f.forgeId]);
    expect(await repo.byProject(f.projectId)).toMatchObject({ id: f.forgeId, deptId: 'software', proposer: 'head:hq' });
    expect(await repo.byProject(f.projectId + 99)).toBeNull();
  });
});

describe('boundary: ForgeRepo never writes mcp_servers or releases (spec 5.2)', () => {
  it('no INSERT, UPDATE or DELETE statement names either table', () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'forge.ts'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(src).not.toMatch(/(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+(mcp_servers|releases|mcp_server_depts)\b/i);
  });
});
