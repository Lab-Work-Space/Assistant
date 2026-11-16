import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { App } from '../../app.js';
import { seed } from '../../company/index.js';
import { ChannelMapRepo, DepartmentRepo, PersonaRepo } from '../../db/repos/index.js';
import { freshDb, type TestDb } from '../../db/test-helpers.js';
import { cmd } from '../../discord/commands/test-helpers.js';
import { handlePrawInteraction } from '../../discord/praw/index.js';
import { PROMPTS_DIR, loadPrompts } from '../../prompts/index.js';
import { FakeProvider } from '../../providers/index.js';
import { chunks, silence, tone } from '../../voice/chat/test-helpers.js';
import { FakeVoiceSession } from '../fakes/voice.js';
import { ActorProvider, boot, migrateUp, resetDb, respond, turn } from './helpers.js';

/** M5 part 2 (T37, AC13): /voice join → fake speech → STT on the fake Gemini → Praw's run → fake TTS → session overlay. */
const PRAW_WORK = '1565999999999999001';
const VC = '1565999999999999555';
const TRANSCRIPT = 'พราวช่วยเปิดเพลงลอฟายหน่อย';

let db: TestDb;
let app: App | null = null;
beforeAll(async () => { db = await freshDb(); });
afterEach(async () => { await app?.stop(); app = null; await resetDb(db.pool); });
afterAll(async () => { await db.close(); });

async function prepare(): Promise<void> {
  await migrateUp(db.pool);
  await seed({ departments: new DepartmentRepo(db.pool), personas: new PersonaRepo(db.pool), channelMap: new ChannelMapRepo(db.pool) }, loadPrompts(PROMPTS_DIR));
  await db.pool.query("UPDATE departments SET provider = 'claude', model = 'claude-sonnet-5-5', work_channel_id = $1 WHERE id = 'praw'", [PRAW_WORK]);
}
const until = async (f: () => boolean | Promise<boolean>, ms = 4000) => { const end = Date.now() + ms; while (!(await f())) { if (Date.now() > end) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 10)); } };

async function rig(script: Parameters<typeof turn>[0][][] | ReturnType<typeof turn>[]) {
  await prepare();
  const sessions: FakeVoiceSession[] = [];
  const spoken: string[] = [];
  const gemini = new FakeProvider(Array.from({ length: 4 }, () => ({ text: TRANSCRIPT, usage: { inputTokens: 300, outputTokens: 12 } })), 'gemini');
  const provider = new ActorProvider({ 'heads/praw': script as ReturnType<typeof turn>[] });
  const t = await boot(db.pool, {
    provider, extraProviders: [gemini], musicEnv: { FAKE_YTDLP_HANG: '/dev/null' },
    voice: {
      createSession: () => { const s = new FakeVoiceSession({ holdPlay: true }); sessions.push(s); return s; }, checkChannel: async () => null,
      voiceChannelOf: async (u: string) => (u === 'u1' ? VC : null),
      tts: { synthesize: async (text: string) => (spoken.push(text), Buffer.from(`pcm:${text}`)) },
    },
  });
  app = t.app;
  const join = await handlePrawInteraction(cmd('voice', 'join', { channelId: PRAW_WORK, roles: [], userId: 'u1' }), t.app.services.prawCommands);
  return { t, sessions, spoken, gemini, provider, join };
}

describe('AC13', () => {
  it('/voice join then fake speech → fake Gemini reply → fake TTS buffer → session.play (spoken Thai reply)', async () => {
    const r = await rig([turn(respond('chat', 'ได้เลยค่ะ เปิดเพลงให้แล้ว'))]);
    expect(r.join?.ephemeral).toBe(false);
    expect(r.join?.content).toContain('พราวเข้าห้องเสียงแล้ว');
    const s = r.sessions[0]!;
    expect(s.calls[0]).toBe(`join:1565649426943442944/${VC}`);
    s.speak('u1', chunks(tone(800), silence(900)));
    await until(() => s.overlays.length === 1);
    expect(r.gemini.calls[0]!.messages[0]!.content.some((b) => b.type === 'media' && b.mimeType === 'audio/wav')).toBe(true);
    expect(r.spoken).toEqual(['ได้เลยค่ะ เปิดเพลงให้แล้ว']);
    expect(s.overlays[0]!.pcm.toString()).toBe('pcm:ได้เลยค่ะ เปิดเพลงให้แล้ว');
    // the run saw the transcript once, wrapped untrusted with source voice
    const seen = JSON.stringify(r.provider.callsOf('heads/praw')[0]!.messages);
    expect(seen).toMatch(/source=\\"voice\\"/);
    expect(seen).toContain(TRANSCRIPT);
    // STT is metered: an llm.call row on gemini for Praw
    const calls = await db.pool.query("SELECT provider FROM audit_log WHERE action = 'llm.call'");
    expect(calls.rows.map((x) => x.provider)).toContain('gemini');
  });

  it('/halt stops pipeline and leaves the channel', async () => {
    const r = await rig([turn(respond('chat', 'never'))]);
    const s = r.sessions[0]!;
    const t0 = Date.now();
    await r.t.app.services.halt.halt('owner');
    await until(() => s.calls.includes('leave'), 2000);
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(r.t.app.services.voice.current()).toBeNull();
    s.speak('u1', chunks(tone(800), silence(900)));
    await new Promise((x) => setTimeout(x, 100));
    expect(r.gemini.calls).toHaveLength(0);
    expect(r.provider.callsOf('heads/praw')).toHaveLength(0);
  });
});

describe('voice.test.ts', () => {
  it('transcript not in audit rows; origin voice so a write tool awaits approval', async () => {
    const r = await rig([turn({ name: 'music_play', input: { query: 'lofi' } }), turn(respond('chat', 'ขออนุมัติก่อนนะคะ'))]);
    const s = r.sessions[0]!;
    s.speak('u1', chunks(tone(800), silence(900)));
    await until(() => s.overlays.length === 1);
    const approvals = await db.pool.query('SELECT tool_name AS tool FROM approvals');
    expect(approvals.rows.map((x) => x.tool)).toEqual(['music_play']); // voice is never direct (P2)
    expect(s.played).toHaveLength(0); // nothing played before approval
    const tasks = await db.pool.query("SELECT origin FROM tasks WHERE origin = 'voice'");
    expect(tasks.rowCount).toBeGreaterThan(0);
    const rows = await db.pool.query('SELECT * FROM audit_log');
    const dump = JSON.stringify(rows.rows);
    expect(dump).not.toContain(TRANSCRIPT);
    expect(dump).not.toContain('ลอฟาย');
    expect(rows.rows.some((x) => x.action === 'voice.utterance')).toBe(true);
    // P20: the transcript stays in memory: not in the task row, its thread name, the task log or any Discord post
    const stored = JSON.stringify([(await db.pool.query('SELECT * FROM tasks')).rows, (await db.pool.query('SELECT * FROM approvals')).rows]);
    const discord = JSON.stringify([r.t.port.posts, r.t.port.threads, r.t.port.tasks, r.t.port.directs, r.t.port.dms]);
    for (const leak of [TRANSCRIPT, 'ลอฟาย']) {
      expect(stored, leak).not.toContain(leak);
      expect(discord, leak).not.toContain(leak);
    }
    expect(r.t.port.threads.map((x) => x.name).join()).toMatch(/Voice request/);
  });
});
