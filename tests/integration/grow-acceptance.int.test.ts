import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { App } from '../../app.js';
import type { OutboundPayload } from '../../agents/loop/payload.js';
import type { ActorRef } from '../../company/types.js';
import { AiDigest } from '../../agents/tasks/ai-digest.js';
import { freshDb, type TestDb } from '../../db/test-helpers.js';
import { RetroRepo } from '../../db/repos/grow.js';
import { SkillAiRepo } from '../../db/repos/skill-ai.js';
import type { PostOptions } from '../../discord/port.js';
import { AI_SKILL_JUDGE_SYSTEM } from '../../governance/skill-judge-prompt.js';
import { SKILLS_HEADER } from '../../skills/render.js';
import { ActorProvider, SOFTWARE_WORK, TestPort, boot, gatewayEcho, humanMsg, mentionOf, resetDb, respond, turn } from './helpers.js';

/** The skill classifier and the skill judge are model calls with their own system text; every other call is the per-actor script. */
class JudgingProvider extends ActorProvider {
  judgeCalls = 0;
  verdict: 'approve' | 'escalate' = 'approve';
  override async *chat(req: Parameters<ActorProvider['chat']>[0], signal: AbortSignal) {
    const out = (text: string) => [{ type: 'text' as const, text }, { type: 'usage' as const, inputTokens: 5, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 }, { type: 'stop' as const, reason: 'end_turn' as const }];
    if (req.system === AI_SKILL_JUDGE_SYSTEM) {
      this.judgeCalls++;
      yield* out(JSON.stringify({ decision: this.verdict, reason: 'describes the team workflow' }));
      return;
    }
    if (req.system.includes('JSON object') && !req.system.includes('Team skills')) { yield* out('{"verdict":"allow"}'); return; }
    yield* super.chat(req, signal);
  }
}

class EchoPort extends TestPort {
  app: App | null = null;
  override async post(actor: ActorRef, target: { channelId: string; threadId?: string }, payload: OutboundPayload, opts?: PostOptions): Promise<string> {
    const id = await super.post(actor, target, payload, opts);
    opts?.onSent?.([id]);
    if (this.app && target.threadId) this.historyById.set(target.threadId, [...(this.historyById.get(target.threadId) ?? []), ...gatewayEcho(this.posts.at(-1)!, this.app.services)]);
    return id;
  }
}

let db: TestDb;
let app: App | null = null;
beforeAll(async () => { db = await freshDb(); });
afterEach(async () => {
  await app?.stop();
  app = null;
  await resetDb(db.pool);
  // skill_versions is append-only (cannot be truncated), so every test uses its own skill id
  await db.pool.query('TRUNCATE skill_proposals, retro_runs, lessons CASCADE'); // not in resetDb's list
  await db.pool.query("DELETE FROM config WHERE key LIKE 'skills.%'");
});
afterAll(async () => { await db.close(); });

const WEEK = '2026-W46';
const TASK = '33333333-3333-3333-3333-333333333333';
let SKILL = '';
const proposeOf = () => {
  SKILL = `check-create-task-args-${Math.random().toString(36).slice(2, 8)}`;
  return { name: 'skill_propose', input: { op: 'create', skill: SKILL, title: 'Check create_task arguments', instructions: 'Before calling create_task, confirm title, description and deptId are all filled and valid.', reason: 'repeated create_task errors this week' } };
};
const msgText = (req: { messages: unknown }) => JSON.stringify(req.messages);
const waitFor = async (fn: () => Promise<boolean>) => { for (let i = 0; i < 100; i++) { if (await fn()) return; await new Promise((r) => setTimeout(r, 50)); } throw new Error('timeout'); };

async function seedWeek(): Promise<void> {
  // 16 create_task errors and 11 update_task errors by the software head in the window (the owner's evidence), one error of another dept
  for (let i = 0; i < 16; i++) await db.pool.query("INSERT INTO audit_log (actor, action, tool, outcome) VALUES ('head:software','tool','create_task','invalid_input')");
  for (let i = 0; i < 11; i++) await db.pool.query("INSERT INTO audit_log (actor, action, tool, outcome) VALUES ('head:software','tool','update_task','tool_error')");
  await db.pool.query("INSERT INTO audit_log (actor, action, tool, outcome) VALUES ('head:rnd','tool','create_task','invalid_input')");
}

async function runRetro(t: Awaited<ReturnType<typeof boot>>): Promise<void> {
  await new RetroRepo(db.pool).claim('software', WEEK, TASK);
  expect(await t.app.services.scheduler.retroStart({ dept: 'software', week: WEEK, taskId: TASK })).toBe('started');
  await t.app.services.scheduler.idle();
}

describe('GROW-1 acceptance (spec section 5): retro -> proposal -> judge -> next run prompt -> digest', () => {
  it('a seeded week of create_task errors: the retro proposes a skill, the fake judge applies it, the next software run carries it, the digest lists it', async () => {
    const provider = new JudgingProvider({
      'heads/software': [turn(proposeOf()), turn(respond('chat', 'Retro: proposed a skill on create_task arguments.')), turn(respond('chat', 'sw next'))],
    });
    const port = new EchoPort();
    const t = await boot(db.pool, { provider, port, start: false });
    app = t.app;
    port.app = t.app;
    await t.app.start();
    const s = t.app.services;
    await s.cfg.set('skills.ai.enabled', true, 'test');
    await seedWeek();

    await runRetro(t);
    // the retro facts carry the repeated errors of software only
    const facts = msgText(provider.callsOf('heads/software')[0]!);
    expect(facts).toContain('create_task');
    expect(facts).toMatch(/create_task[^"]*16|16[^"]*create_task/);

    // the proposal is applied by the judge (async): wait for the skill to be live
    await waitFor(async () => (await db.pool.query('SELECT 1 FROM skills WHERE id = $1 AND status = $2', [SKILL, 'active'])).rowCount === 1);
    expect(provider.judgeCalls).toBe(1);
    const prop = (await db.pool.query('SELECT status, reviewed_by, tainted FROM skill_proposals')).rows;
    expect(prop).toEqual([{ status: 'applied', reviewed_by: 'system:ai-approver', tainted: false }]);
    expect(s.org.skillsFor({ kind: 'head', dept: 'software' }).map((x) => x.id)).toContain(SKILL);
    expect(s.org.skillsFor({ kind: 'head', dept: 'rnd' }).map((x) => x.id)).not.toContain(SKILL);
    // applied notice in #setting: ids, version, dept; never the skill text
    const notice = port.posts.find((p) => JSON.stringify(p.payload).includes('Skill applied by the AI reviewer'));
    expect(notice).toBeTruthy();
    expect(JSON.stringify(notice!.payload)).toContain(SKILL);
    expect(JSON.stringify(notice!.payload)).not.toContain('confirm title');

    // the next software run's system prompt contains the skill
    await s.scheduler.onMessage(humanMsg(`${mentionOf('software')} status?`, { channelId: SOFTWARE_WORK, mentionedHeads: ['software'] }));
    await s.scheduler.idle();
    const next = provider.callsOf('heads/software').at(-1)!;
    expect(next.system).toContain(SKILLS_HEADER);
    expect(next.system).toContain(`### Skill ${SKILL} v1: Check create_task arguments`);

    // the digest lists it
    const posted: OutboundPayload[] = [];
    const digest = new AiDigest({
      repo: { day: async () => ({ reviews: 0, approvals: [], escalations: [], reasons: [], capHit: false }) as never },
      skills: new SkillAiRepo(db.pool), cfg: s.cfg, now: () => { const d = new Date(); d.setUTCHours(12, 0, 0, 0); return d; }, // 19:00 in Asia/Bangkok
      log: { error: () => undefined }, daily: { claim: async () => true }, post: async (p) => void posted.push(p),
    });
    await digest.tick();
    expect(posted).toHaveLength(1);
    expect((posted[0] as { body: string }).body).toContain(`- ${SKILL} v1 (software)`);
  }, 60000);

  it('switch off (default): the same retro proposes, nothing is judged or applied, the human notice is posted, no skill goes live', async () => {
    const provider = new JudgingProvider({ 'heads/software': [turn(proposeOf()), turn(respond('chat', 'Retro: proposed.'))] });
    const port = new EchoPort();
    const t = await boot(db.pool, { provider, port, start: false });
    app = t.app;
    port.app = t.app;
    await t.app.start();
    expect(t.app.services.cfg.get('skills.ai.enabled')).toBe(false); // GW-C15 default
    await seedWeek();
    await runRetro(t);
    await t.app.services.scheduler.idle();
    await new Promise((r) => setTimeout(r, 300));
    expect(provider.judgeCalls).toBe(0);
    expect((await db.pool.query('SELECT status FROM skill_proposals')).rows).toEqual([{ status: 'open' }]);
    expect((await db.pool.query('SELECT 1 FROM skills WHERE id = $1', [SKILL])).rowCount).toBe(0);
    expect((await db.pool.query("SELECT 1 FROM audit_log WHERE action LIKE 'skill.ai.%'")).rowCount).toBe(0);
    expect(port.posts.some((p) => JSON.stringify(p.payload).includes('Skill proposal'))).toBe(true); // the human notice, as before GROW-1
  }, 60000);

  it('judge escalates: the proposal stays open for a person, no skill, the next run has no skill block', async () => {
    const provider = new JudgingProvider({ 'heads/software': [turn(proposeOf()), turn(respond('chat', 'Retro: proposed.'))] });
    provider.verdict = 'escalate';
    const port = new EchoPort();
    const t = await boot(db.pool, { provider, port, start: false });
    app = t.app;
    port.app = t.app;
    await t.app.start();
    await t.app.services.cfg.set('skills.ai.enabled', true, 'test');
    await seedWeek();
    await runRetro(t);
    await waitFor(async () => provider.judgeCalls === 1);
    await waitFor(async () => (await db.pool.query("SELECT 1 FROM audit_log WHERE action = 'skill.ai.escalate'")).rowCount === 1);
    expect((await db.pool.query('SELECT status FROM skill_proposals')).rows).toEqual([{ status: 'open' }]);
    expect((await db.pool.query('SELECT 1 FROM skills WHERE id = $1', [SKILL])).rowCount).toBe(0);
  }, 60000);
});
