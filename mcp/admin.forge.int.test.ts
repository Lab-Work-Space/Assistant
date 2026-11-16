import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../db/migrate.js';
import { newBuild, newForge, newRelease, newServer, resetForgeTables } from '../db/repos/forge-test-helpers.js';
import { McpRepo } from '../db/repos/mcp.js';
import { freshDb, type TestDb } from '../db/test-helpers.js';
import { McpAdmin, type McpAdminDeps } from './admin.js';
import { ADMIN_TEXT } from './errors.js';
import { StuckLatch } from './sandbox.js';
import { FakeMcpDocker, fixtureSpawner } from './test-helpers.js';

/** R7 PLUGIN-FORGE BE2 (spec 3.0 F3, PF-C10, FG-AC): `/mcp add` cannot launder a forged image into read class. Every trigger refuses before anything is spawned. */
const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'db', 'migrations');
const ADMIN = '900000000000000001';
const BY = { kind: 'admin', userId: ADMIN } as const;
const IMG = `sha256:${'c'.repeat(64)}`;
const FORGED = `sha256:${'2'.repeat(64)}`;
let db: TestDb;
let repo: McpRepo;
beforeAll(async () => { db = await freshDb(); await migrate(db.pool, dir, 'up'); repo = new McpRepo(db.pool); });
afterAll(async () => { await db.close(); });
beforeEach(async () => { await resetForgeTables(db.pool); for (const t of ['approvals', 'mcp_call_counts', 'mcp_server_depts', 'mcp_servers', 'audit_log']) await db.pool.query(`DELETE FROM ${t}`); });

function mk() {
  const docker = new FakeMcpDocker();
  const sp = fixtureSpawner({});
  const d: McpAdminDeps = {
    repo, docker, sandbox: { docker, spawn: sp, isHalted: () => false, latch: new StuckLatch(), newSuffix: () => 'abcdef01', haltPollMs: 15, clientGraceMs: 40, hardTimeoutMs: 8000 },
    host: { refresh: async () => undefined }, halted: () => false, deptExists: (x) => ['software', 'sales'].includes(x), audit: async (e) => { await db.pool.query('INSERT INTO audit_log (actor, action, tool, outcome) VALUES ($1,$2,$3,$4)', [e.actor, e.action, e.tool ?? null, e.outcome ?? null]); }, secrets: () => [], log: { error: () => undefined },
  };
  return { a: new McpAdmin(d), docker, sp };
}
const input = (o: Record<string, unknown> = {}) => ({ slug: 'srv', image: IMG, departments: 'software', title: 'Demo', ...o });
const spawned = (m: ReturnType<typeof mk>): boolean => m.docker.execs.some((e) => e[0] === 'create' || e[0] === 'run' || e[0] === 'start');

describe('PF-C10: /mcp add refuses class read for anything forged', () => {
  it('an image whose labels carry a key starting assistant.forge', async () => {
    for (const labels of ['{"assistant.forge":"1"}', '{"assistant.forge.build":"7"}', '{"assistant.forgery":"x","other":"y"}']) {
      const m = mk();
      m.docker.labels = labels;
      expect(await m.a.stage(input({ class: 'read' }), BY), labels).toEqual({ ok: false, code: 'E_CLASS', text: ADMIN_TEXT.E_CLASS });
      expect(spawned(m)).toBe(false);
    }
    expect(await repo.get('srv')).toBeNull();
  });
  it('an image id that a plugin build recorded, even with its labels stripped', async () => {
    const f = await newForge(db.pool);
    const rel = await newRelease(db.pool, { forgeId: f.forgeId });
    await newBuild(db.pool, { forgeId: f.forgeId, releaseId: rel, status: 'staged', imageId: FORGED });
    const m = mk();
    m.docker.labels = 'null';
    expect(await m.a.stage(input({ class: 'read', image: FORGED }), BY)).toMatchObject({ ok: false, code: 'E_CLASS' });
    expect(spawned(m)).toBe(false);
  });
  it('a slug whose existing row came from a release (disabled or quarantined)', async () => {
    const f = await newForge(db.pool);
    const rel = await newRelease(db.pool, { forgeId: f.forgeId });
    await newServer(db.pool, { slug: 'srv', status: 'disabled', source: 'release', releaseId: rel });
    const m = mk();
    expect(await m.a.stage(input({ class: 'read' }), BY)).toMatchObject({ ok: false, code: 'E_CLASS' });
    expect(spawned(m)).toBe(false);
  });
  it('an inspect error or output that is not a label object refuses (fail safe), including a forbidden key', async () => {
    for (const set of [(m: ReturnType<typeof mk>) => { m.docker.labelsFail = true; }, (m: ReturnType<typeof mk>) => { m.docker.labels = 'not json'; }, (m: ReturnType<typeof mk>) => { m.docker.labels = '["a"]'; }, (m: ReturnType<typeof mk>) => { m.docker.labels = '{"__proto__":{"x":1}}'; }, (m: ReturnType<typeof mk>) => { m.docker.labels = '{"a":1}'; }]) {
      const m = mk();
      set(m);
      expect(await m.a.stage(input({ class: 'read' }), BY)).toMatchObject({ ok: false, code: 'E_CLASS' });
      expect(spawned(m)).toBe(false);
    }
  });
  it('the refusal is audited as refused:E_CLASS by the admin', async () => {
    const m = mk();
    m.docker.labels = '{"assistant.forge":"1"}';
    await m.a.stage(input({ class: 'read' }), BY);
    expect((await db.pool.query("SELECT actor, action, outcome FROM audit_log WHERE action = 'mcp.add'")).rows).toEqual([{ actor: `user:${ADMIN}`, action: 'mcp.add', outcome: 'refused:E_CLASS' }]);
  });
});

describe('PF-C10: nothing else changes', () => {
  it('a forged image or a release-sourced slug may still be added as write class by an admin', async () => {
    const m = mk();
    m.docker.labels = '{"assistant.forge":"1"}';
    expect(await m.a.stage(input(), BY)).toMatchObject({ ok: true });
    expect((await repo.get('srv'))!.toolClass).toBe('write');
  });
  it('an ordinary image with no labels, unknown to the forge, is still addable as read', async () => {
    const m = mk();
    m.docker.labels = '{"org.example.x":"1"}';
    expect(await m.a.stage(input({ class: 'read' }), BY)).toMatchObject({ ok: true });
    expect((await repo.get('srv'))!.toolClass).toBe('read');
  });
  it('write class never inspects labels (the check costs nothing there)', async () => {
    const m = mk();
    await m.a.stage(input(), BY);
    expect(m.docker.execs.some((e) => e.join(' ').includes('Config.Labels'))).toBe(false);
  });
});
