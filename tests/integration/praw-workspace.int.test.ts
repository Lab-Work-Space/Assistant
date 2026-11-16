import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { App } from '../../app.js';
import { PRAW_DEFAULT_MODEL, seed } from '../../company/index.js';
import { ChannelMapRepo, DepartmentRepo, PersonaRepo } from '../../db/repos/index.js';
import { freshDb, type TestDb } from '../../db/test-helpers.js';
import { PROMPTS_DIR, loadPrompts } from '../../prompts/index.js';
import { createGeminiProvider, type GeminiChunk } from '../../providers/gemini/index.js';
import { fakeGemini, type GeminiAttempt } from '../fakes/gemini.js';
import { boot, humanMsg, mentionOf, migrateUp, resetDb } from './helpers.js';

const SANDBOX = '1565999999999999777';
const MSG = '1570000000000000042';
const prompts = loadPrompts(PROMPTS_DIR);
const usage = { promptTokens: 10, candidatesTokens: 5 };
const call = (name: string, args: Record<string, unknown>): GeminiAttempt => ({ chunks: [{ functionCalls: [{ name, args }], usage } satisfies GeminiChunk] });
const say = (body: string) => call('respond', { type: 'chat', body });

let db: TestDb;
let app: App | null = null;
let base: string;
beforeAll(async () => { db = await freshDb(); await migrateUp(db.pool); });
beforeEach(() => { base = mkdtempSync(join(tmpdir(), 'praw-ws-int-')); });
afterEach(async () => { await app?.stop(); app = null; await resetDb(db.pool); rmSync(base, { recursive: true, force: true }); });
afterAll(async () => { await db.close(); });

async function start(script: GeminiAttempt[]) {
  await migrateUp(db.pool);
  await seed({ departments: new DepartmentRepo(db.pool), personas: new PersonaRepo(db.pool), channelMap: new ChannelMapRepo(db.pool) }, prompts);
  await db.pool.query("UPDATE departments SET work_channel_id = $1 WHERE id = 'praw'", [SANDBOX]);
  await db.pool.query("INSERT INTO config (key, value) VALUES ('provider.default', $1)", [JSON.stringify({ provider: 'gemini', model: PRAW_DEFAULT_MODEL })]);
  const fake = fakeGemini(script);
  const root = join(base, 'ws');
  const t = await boot(db.pool, { provider: createGeminiProvider({ client: fake, sleep: async () => undefined, random: () => 0 }), depts: ['hq', 'praw'], env: { prawWorkspaceDir: root } });
  app = t.app;
  t.port.messages.set(MSG, SANDBOX);
  return { ...t, fake, root };
}
const ask = (text: string) => humanMsg(`${mentionOf('praw')} ${text}`, { id: MSG, channelId: SANDBOX, mentionedHeads: ['praw'] });

describe('Praw workspace and pins through the app (AC8, P17, P18)', () => {
  it('a direct chat writes a file in the 0700 workspace and pins the trigger message without approval', async () => {
    const t = await start([call('write_file', { path: 'notes/plan.md', content: '# plan' }), call('pin_message', {}), say('เรียบร้อยค่ะ')]);
    await t.app.services.scheduler.onMessage(ask('save my plan and pin this'));
    await t.app.services.scheduler.idle();
    expect(readFileSync(join(t.root, 'notes', 'plan.md'), 'utf8')).toBe('# plan');
    expect(statSync(t.root).mode & 0o777).toBe(0o700);
    expect(t.port.pins).toEqual([{ actor: { kind: 'head', dept: 'praw' }, channelId: SANDBOX, messageId: MSG }]);
    expect((await db.pool.query("SELECT count(*)::int AS n FROM approvals")).rows[0].n).toBe(0);
  });

  it('a path outside the workspace is refused as invalid input: no file, no approval', async () => {
    const t = await start([call('write_file', { path: '../escape.txt', content: 'x' }), say('ทำไม่ได้ค่ะ')]);
    await t.app.services.scheduler.onMessage(ask('write outside'));
    await t.app.services.scheduler.idle();
    expect(existsSync(join(base, 'escape.txt'))).toBe(false);
    expect(JSON.stringify(t.fake.requests[1]!.contents)).toContain('invalid input for write_file');
    expect((await db.pool.query("SELECT count(*)::int AS n FROM approvals")).rows[0].n).toBe(0);
    const rows = (await db.pool.query("SELECT tool, outcome FROM audit_log WHERE action = 'tool'")).rows;
    expect(rows).toContainEqual({ tool: 'write_file', outcome: 'invalid_input' });
  });
});
