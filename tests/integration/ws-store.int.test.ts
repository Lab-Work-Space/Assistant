import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { App } from '../../app.js';
import { freshDb, type TestDb } from '../../db/test-helpers.js';
import { createLogger } from '../../core/index.js';
import { FakeDocker } from '../../workspaces/test-helpers.js';
import { ActorProvider, boot, humanMsg, mentionOf, resetDb, respond, SOFTWARE_WORK, turn } from './helpers.js';

let db: TestDb;
let app: App | null = null;
let base: string;
beforeAll(async () => { db = await freshDb(); });
beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'ws-int-')));
  imagesDir = join(base, 'img');
  mkdirSync(join(imagesDir, 'docker', 'ws'), { recursive: true });
  writeFileSync(join(imagesDir, 'docker', 'ws', 'images.json'), JSON.stringify({ runner: RUNNER, proxy: RUNNER }));
});
afterEach(async () => { await app?.stop(); app = null; await resetDb(db.pool); await db.pool.query('DELETE FROM workspaces'); rmSync(base, { recursive: true, force: true }); });
afterAll(async () => { await db.close(); });

// The workspace boot calls Docker (version, image id, sweep): these tests inject a scripted one so they never touch the real daemon.
const RUNNER = `sha256:${'9'.repeat(64)}`;
let imagesDir: string;
const wsDocker = () => { const d = new FakeDocker(); d.imageId = RUNNER; return { docker: d, imagesDir }; };
const MANIFEST = '{"manifest_version":3,"name":"SECRET-MARKER-77"}';
const ask = (text: string) => humanMsg(`${mentionOf('software')} ${text}`, { mentionedHeads: ['software'] });
const wsNames = (a: App) => a.services.org.toolsFor({ kind: 'head', dept: 'software' }).filter((n) => n.startsWith('ws_')).sort();

describe('WS-1 store through the app (BE1)', () => {
  it('the software head creates a workspace, writes and lists files through the real registry: no approval card, audit rows without content, list output wrapped as untrusted', async () => {
    const root = join(base, 'ws-root');
    const provider = new ActorProvider({
      'heads/software': [
        turn(
          { name: 'ws_create', input: { slug: 'mv3-kit', title: 'Chrome MV3 starter' } },
          { name: 'ws_write', input: { slug: 'mv3-kit', path: 'manifest.json', content: MANIFEST } },
          { name: 'ws_list', input: { slug: 'mv3-kit' } },
        ),
        turn(respond('chat', 'Workspace ready.')),
      ],
    });
    const lines: string[] = [];
    const logger = createLogger('debug', { destination: { write: (x: string) => void lines.push(x) } });
    const t = await boot(db.pool, { provider, logger, env: { wsRoot: root } as never, ws: wsDocker() });
    app = t.app;
    await t.app.services.cfg.set('ws.enabled', true, 'test');
    expect(wsNames(t.app)).toEqual(['ws_create', 'ws_delete', 'ws_export', 'ws_list', 'ws_read', 'ws_run', 'ws_write']);
    await t.app.services.scheduler.onMessage(ask('start the MV3 starter kit workspace'));
    await t.app.services.scheduler.idle();
    expect(readFileSync(join(root, 'mv3-kit', 'manifest.json'), 'utf8')).toContain('manifest_version');
    expect(lstatSync(join(root, 'mv3-kit')).mode & 0o777).toBe(0o700);
    expect(lstatSync(root).mode & 0o777).toBe(0o700);
    expect((await db.pool.query("SELECT slug, status, created_by FROM workspaces")).rows).toEqual([{ slug: 'mv3-kit', status: 'active', created_by: 'head:software' }]);
    expect((await db.pool.query('SELECT count(*)::int AS n FROM approvals')).rows[0].n).toBe(0);
    const audit = (await db.pool.query("SELECT action, tool, outcome FROM audit_log WHERE action LIKE 'ws.%' ORDER BY id")).rows;
    expect(audit).toEqual([
      { action: 'ws.create', tool: 'ws_create', outcome: 'mv3-kit' },
      { action: 'ws.write', tool: 'ws_write', outcome: `mv3-kit:manifest.json:${MANIFEST.length}` },
    ]);
    expect(JSON.stringify((await db.pool.query('SELECT * FROM audit_log')).rows)).not.toContain('SECRET-MARKER-77');
    // WS-C17: the content marker is in no log line, no posted message (incident alerts go to bot-log) and no audit row
    expect(lines.join('\n')).not.toContain('SECRET-MARKER-77');
    expect(JSON.stringify(t.port.posts)).not.toContain('SECRET-MARKER-77');
    const sent = JSON.stringify(provider.callsOf('heads/software')[1]!.messages);
    expect(sent).toMatch(/untrusted-[0-9a-f]+ source=\\"workspace\\" author=\\"ws_list\\"/); // the list result reached the model wrapped as data
    expect(sent).toContain(`manifest.json (${MANIFEST.length} bytes)`);
  });

  it('ws.enabled defaults to false: every call is refused with the fixed text and nothing is created', async () => {
    const root = join(base, 'ws-root');
    const provider = new ActorProvider({
      'heads/software': [turn({ name: 'ws_create', input: { slug: 'nope', title: 't' } }), turn(respond('chat', 'ok'))],
    });
    const t = await boot(db.pool, { provider, env: { wsRoot: root } as never, ws: wsDocker() });
    app = t.app;
    await t.app.services.scheduler.onMessage(ask('make a workspace'));
    await t.app.services.scheduler.idle();
    expect(JSON.stringify(provider.callsOf('heads/software')[1]!.messages)).toContain('Workspaces are switched off.');
    expect(existsSync(join(root, 'nope'))).toBe(false);
    expect((await db.pool.query('SELECT count(*)::int AS n FROM workspaces')).rows[0].n).toBe(0);
  });

  it('the other departments and Praw never receive a ws tool in their tool list, even with the group on', async () => {
    const provider = new ActorProvider({ 'heads/software': [turn(respond('chat', 'x'))], 'heads/hq': [turn(respond('chat', 'y'))] });
    const t = await boot(db.pool, { provider, env: { wsRoot: join(base, 'ws-root') } as never, ws: wsDocker() });
    app = t.app;
    await t.app.services.scheduler.onMessage(ask('hi'));
    await t.app.services.scheduler.onMessage(humanMsg(`${mentionOf('hq')} hi`, { mentionedHeads: ['hq'], channelId: SOFTWARE_WORK }));
    await t.app.services.scheduler.idle();
    const names = (actor: string) => (provider.callsOf(actor)[0]?.tools ?? []).map((x) => x.name).filter((n) => n.startsWith('ws_')).sort();
    expect(names('heads/software')).toEqual(['ws_create', 'ws_delete', 'ws_export', 'ws_list', 'ws_read', 'ws_run', 'ws_write']);
    expect(provider.callsOf('heads/hq').length ? names('heads/hq') : []).toEqual([]);
  });

  it('an unsafe WS_ROOT (inside the working directory) leaves the group off and creates nothing; the app still boots', async () => {
    const inside = join(process.cwd(), 'ws-int-unsafe-should-not-exist');
    const t = await boot(db.pool, { provider: new ActorProvider({}), env: { wsRoot: inside } as never });
    app = t.app;
    expect(wsNames(t.app)).toEqual([]);
    expect(existsSync(inside)).toBe(false);
  });

  it('with test providers and no WS_ROOT the workspace boot is skipped: the group is off and nothing is created under the home', async () => {
    const t = await boot(db.pool, { provider: new ActorProvider({}) });
    app = t.app;
    expect(wsNames(t.app)).toEqual([]);
  });

  it('a migration-stored tools.byDept without ws names still gets them from migration 040 data (already applied) and the policy keeps them software-only', async () => {
    mkdirSync(join(base, 'x'));
    const t = await boot(db.pool, { provider: new ActorProvider({}), env: { wsRoot: join(base, 'ws-root') } as never, ws: wsDocker() });
    app = t.app;
    await t.app.services.cfg.set('tools.byDept', { marketing: ['web_search', 'ws_run', 'ws_write', 'ws_list'], software: ['web_search', 'ws_write'] } as never, 'test');
    expect(t.app.services.org.toolsFor({ kind: 'head', dept: 'marketing' }).filter((n) => n.startsWith('ws_'))).toEqual([]);
    expect(t.app.services.org.toolsFor({ kind: 'head', dept: 'praw' }).filter((n) => n.startsWith('ws_'))).toEqual([]);
    expect(t.app.services.org.toolsFor({ kind: 'head', dept: 'software' }).filter((n) => n.startsWith('ws_'))).toEqual(['ws_write']);
  });
});
