import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { App } from '../../app.js';
import { freshDb, type TestDb } from '../../db/test-helpers.js';
import { FakeProvider, ProviderError } from '../../providers/index.js';
import type { QuotaSnapshot } from '../../providers/claude-code-local/quota.js';
import { BOT_LOG_CHANNEL, boot, humanMsg, migrateUp, resetDb, TestPort } from './helpers.js';

// R8 PROV-FALLBACK acceptance (spec: Acceptance 1, 2, 4, 5, 6) through the real app, with fake providers standing in for the CLI and the API.
let db: TestDb;
let app: App | null = null;
beforeAll(async () => { db = await freshDb(); await migrateUp(db.pool); });
beforeEach(() => { reset = nowS() + 7200 + 10 * ++episode; });
afterEach(async () => { await app?.stop(); app = null; await resetDb(db.pool); });
afterAll(async () => { await db.close(); });

const LOCAL = { provider: 'claude-code-local', model: 'local/claude-sonnet-5-5' };
const nowS = () => Math.floor(Date.now() / 1000);
// The alert claims live in a table `resetDb` does not clear, so every test uses its own reset second (a shared one would find the claim taken).
let episode = 0;
let reset = 0;
const snap = (week: 'allowed' | 'rejected'): QuotaSnapshot => ({ status: week, rateLimitType: 'seven_day', windows: { five_hour: { utilization: 0.1, resetsAt: reset + 1800, status: 'allowed' }, seven_day: { utilization: week === 'rejected' ? 1 : 0.2, resetsAt: reset, status: week } } });
const answers = (text: string) => Array.from({ length: 8 }, () => ({ text, usage: { inputTokens: 1000, outputTokens: 100 } }));
const wait = async (f: () => boolean | Promise<boolean>) => { for (let i = 0; i < 100 && !(await f()); i++) await new Promise((r) => setTimeout(r, 20)); };

async function rig(o: { switchOn?: boolean; claude?: FakeProvider } = {}) {
  const local = new FakeProvider(answers('LOCAL-ANSWER'), 'claude-code-local');
  const claude = o.claude ?? new FakeProvider(answers('API-ANSWER'), 'claude');
  const port = new TestPort();
  const booted = await boot(db.pool, { provider: local, extraProviders: [claude, new FakeProvider([], 'gemini')], port, depts: ['hq', 'software'] });
  app = booted.app;
  await app.services.cfg.set('provider.default', LOCAL, 'test');
  if (o.switchOn !== false) await app.services.cfg.set('provider.fallback.enabled', true, 'test');
  const say = async (text = 'hello') => { await app!.services.scheduler.onMessage(humanMsg(`<@101> ${text}`, { mentionedHeads: ['software'] })); await app!.services.scheduler.idle(); };
  const botLog = () => port.posts.filter((p) => p.target.channelId === BOT_LOG_CHANNEL).map((p) => String(p.payload.body));
  const claudeCalls = async () => (await db.pool.query("SELECT outcome, model FROM audit_log WHERE action = 'llm.call' AND provider = 'claude'")).rows;
  return { local, claude, port, say, botLog, claudeCalls, quota: app.services.quota };
}

describe('R8 PROV-FALLBACK through the app', () => {
  it('acceptance 1: no hold, zero claude llm.call rows, even with the switch on', async () => {
    const r = await rig();
    await r.say();
    expect(r.local.calls).toHaveLength(1);
    expect(await r.claudeCalls()).toEqual([]);
  });

  it('acceptance 2, 6: a hold with the switch on runs non-praw work on the API (metered as provider claude) and the hold end posts A2 with the API spend', async () => {
    const r = await rig();
    r.quota.publish(snap('rejected'));
    await wait(() => r.botLog().some((b) => b.includes('continue on the Claude API')));
    expect(r.botLog().find((b) => b.includes('continue on the Claude API'))).toMatch(/Bots except Praw continue on the Claude API \(metered; company cap \$\d+\.\d\d\/day\) until/);
    await r.say();
    expect(r.local.calls).toHaveLength(0);
    expect(r.claude.calls).toHaveLength(1);
    expect(r.claude.calls[0]).toMatchObject({ model: 'claude-sonnet-5-5', route: 'fallback' });
    expect(await r.claudeCalls()).toHaveLength(1);
    const spend = await db.pool.query("SELECT sum(calls)::int AS calls, sum(spent_usd)::float8 AS usd FROM spend_days WHERE provider = 'claude'");
    expect(spend.rows[0]).toMatchObject({ calls: 1 });
    expect(spend.rows[0].usd).toBeCloseTo((1000 * 2 + 100 * 10) / 1e6, 6);
    r.quota.publish(snap('allowed'));
    await wait(() => r.botLog().some((b) => b.startsWith('The Claude quota hold is over')));
    expect(r.botLog().find((b) => b.startsWith('The Claude quota hold is over'))).toMatch(/^The Claude quota hold is over\. Bots are back on the subscription\. Claude API spend today: \$0\.\d\d \(1 call\)\.$/);
    await r.say('again');
    expect(r.local.calls).toHaveLength(1);
    expect(r.claude.calls).toHaveLength(1);
  });

  it('acceptance 4: switch off, today\'s behaviour: the work waits, nothing is posted by the head, the old A1 text', async () => {
    const r = await rig({ switchOn: false });
    r.quota.publish(snap('rejected'));
    await wait(() => r.botLog().some((b) => b.includes('will idle until')));
    expect(r.botLog().find((b) => b.includes('used up'))).toMatch(/^The Weekly Claude quota is used up\. The bots will idle until /);
    await r.say();
    expect(r.local.calls).toHaveLength(0);
    expect(r.claude.calls).toHaveLength(0);
    r.quota.publish(snap('allowed'));
    await wait(() => r.botLog().some((b) => b.startsWith('The Claude quota hold is over')));
    expect(r.botLog().find((b) => b.startsWith('The Claude quota hold is over'))).toBe('The Claude quota hold is over. Claude-backed work has resumed.');
  });

  it('acceptance 5: a 401 gives held + requeue + one alert; the task waits and a restart-free retry does not call again', async () => {
    const failing = new FakeProvider([], 'claude');
    failing.chat = async function* () { throw new ProviderError('VENDOR-WORDS-CANARY', { retryable: false, status: 401 }); } as never;
    const r = await rig({ claude: failing });
    r.quota.publish(snap('rejected'));
    await wait(() => r.botLog().some((b) => b.includes('continue on the Claude API')));
    await r.say('one');
    await r.say('two');
    await wait(() => r.botLog().some((b) => b.includes('was refused (HTTP 401)')));
    expect(r.botLog().filter((b) => b.includes('was refused (HTTP 401)'))).toHaveLength(1);
    expect(r.botLog().join('\n')).not.toContain('CANARY');
    expect(await db.pool.query("SELECT outcome FROM audit_log WHERE action = 'provider.fallback' ORDER BY id")).toMatchObject({ rows: expect.arrayContaining([{ outcome: 'engaged' }, { outcome: 'api_off:401' }]) });
  });

  it('a task that was cut by the quota mid-run is re-offered once and then runs on the API', async () => {
    const r = await rig();
    const task = await app!.services.tasks.create({ title: 'Build it', deptId: 'software', owner: { kind: 'head', dept: 'software' }, requester: { kind: 'human', userId: '42' }, origin: 'chat' });
    // the CLI call is rejected and the hold starts at that moment
    r.local.chat = async function* () { r.quota.publish(snap('rejected')); throw Object.assign(new ProviderError('quota', { retryable: false, diag: 'quota_rejected' })); } as never;
    await app!.services.scheduler.onTaskReady(task.id);
    await app!.services.scheduler.idle();
    await wait(() => r.claude.calls.length > 0);
    expect(r.claude.calls).toHaveLength(1);
    expect(r.claude.calls[0]).toMatchObject({ model: 'claude-sonnet-5-5' });
  });
});
