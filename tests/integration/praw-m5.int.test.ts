import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { App } from '../../app.js';
import { seed } from '../../company/index.js';
import { SocketMediaBackend } from '../../media/client.js';
import { startMediaServer, type MediaServer } from '../../media/server.js';
import { ChannelMapRepo, DepartmentRepo, PersonaRepo } from '../../db/repos/index.js';
import { freshDb, type TestDb } from '../../db/test-helpers.js';
import { cmd, text } from '../../discord/commands/test-helpers.js';
import { handlePrawInteraction } from '../../discord/praw/index.js';
import { PROMPTS_DIR, loadPrompts } from '../../prompts/index.js';
import { toGeminiRequest } from '../../providers/gemini/convert.js';
import { FakeProvider } from '../../providers/index.js';
import { chunks, silence, tone } from '../../voice/chat/test-helpers.js';
import { clickupRoutes, ddgResultsHtml, fakeFetch, githubRoutes } from '../fakes/http.js';
import { fakeResolver, fakeTransport } from '../fakes/net.js';
import { APP_ID, INSTALLATION_ID, KP, PEM, REPO } from '../../tools/plugins/github/test-helpers.js';
import { FakeVoiceSession } from '../fakes/voice.js';
import { ActorProvider, boot, fakeBinaries, humanMsg, mentionOf, migrateUp, resetDb, respond, turn, type BootOptions } from './helpers.js';

/** M5 part 1 (T36, AC12a): /play, /skip and the music tools over fake yt-dlp/ffmpeg and a fake voice session. */
const PRAW_WORK = '1565999999999999001';
const VC = '1565999999999999555';
const HANG = { FAKE_YTDLP_HANG: '/dev/null' };

/** Every outbound connection that is not loopback is recorded and refused for the whole file (the int project has no setup-file guard). */
const external: string[] = [];
const restore: (() => void)[] = [];
const isLoopback = (h: string | undefined) => !h || h === 'localhost' || h === '::1' || /^127\./.test(h) || h === (() => { try { return new URL(process.env.TEST_DATABASE_URL ?? 'postgres://x@127.0.0.1').hostname; } catch { return ''; } })();
function guardNetwork(): void {
  const realFetch = globalThis.fetch;
  globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const host = (() => { try { return new URL(typeof input === 'string' || input instanceof URL ? input : (input as Request).url).hostname; } catch { return 'unknown'; } })();
    if (isLoopback(host)) return realFetch(input, init);
    external.push(`fetch ${host}`);
    return Promise.reject(new Error(`m5: external fetch to ${host}`));
  }) as typeof fetch;
  const realConnect = net.Socket.prototype.connect as (this: net.Socket, ...a: unknown[]) => net.Socket;
  net.Socket.prototype.connect = function (this: net.Socket, ...args: unknown[]): net.Socket {
    const first = Array.isArray(args[0]) ? args[0][0] : args[0];
    const o = typeof first === 'object' && first !== null ? (first as { host?: string; path?: string }) : null;
    const host = o ? (o.path ? undefined : o.host) : typeof first === 'string' ? first : typeof args[1] === 'string' ? args[1] : undefined;
    if (!isLoopback(host)) { external.push(`connect ${host}`); throw new Error(`m5: external connect to ${host}`); }
    return realConnect.apply(this, args);
  } as typeof net.Socket.prototype.connect;
  restore.push(() => { globalThis.fetch = realFetch; net.Socket.prototype.connect = realConnect as typeof net.Socket.prototype.connect; });
}

let db: TestDb;
let app: App | null = null;
beforeAll(async () => { guardNetwork(); db = await freshDb(); });
afterAll(() => { for (const f of restore) f(); });
afterEach(async () => { await app?.stop(); app = null; await resetDb(db.pool); });
afterAll(async () => { await db.close(); });

async function prepare(): Promise<void> {
  await migrateUp(db.pool);
  await seed({ departments: new DepartmentRepo(db.pool), personas: new PersonaRepo(db.pool), channelMap: new ChannelMapRepo(db.pool) }, loadPrompts(PROMPTS_DIR));
  await db.pool.query("UPDATE departments SET provider = 'claude', model = 'claude-sonnet-5-5', work_channel_id = $1 WHERE id = 'praw'", [PRAW_WORK]);
}
const until = async (f: () => boolean, ms = 3000) => { const end = Date.now() + ms; while (!f()) { if (Date.now() > end) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 10)); } };
const slash = (name: string, o: Parameters<typeof cmd>[2] = {}) => cmd(name, null, { channelId: PRAW_WORK, roles: [], userId: 'u1', ...o });

function voiceRig() {
  const sessions: FakeVoiceSession[] = [];
  return {
    sessions,
    voice: { tts: { synthesize: async (t: string) => Buffer.from(`pcm:${t}`) }, createSession: () => { const s = new FakeVoiceSession({ holdPlay: true }); sessions.push(s); return s; }, checkChannel: async () => null, voiceChannelOf: async (u: string) => (u === 'u1' ? VC : null) },
  };
}

/**
 * Spec 5.5: the music flow runs over both backends. `local` is LocalMediaBackend over tests/fakes/bin (musicEnv carries the fakes'
 * switches); `socket` is the real startMediaServer in-process on a short mkdtemp socket over the same fakes, reached through
 * SocketMediaBackend (AppOverrides.media), the production path minus the container boundary.
 */
let sidecar: { srv: MediaServer; dir: string; tracks: number } | null = null;
/** Counts the tracks the app asked the sidecar for, so a socket run proves the music really went over the socket. */
class CountingSocket extends SocketMediaBackend {
  override startTrack(...a: Parameters<SocketMediaBackend['startTrack']>): ReturnType<SocketMediaBackend['startTrack']> {
    if (sidecar) sidecar.tracks++;
    return super.startTrack(...a);
  }
}
afterEach(async () => {
  if (!sidecar) return;
  expect(sidecar.tracks).toBeGreaterThan(0);
  sidecar.srv.killAll('test-end');
  await sidecar.srv.close();
  rmSync(sidecar.dir, { recursive: true, force: true });
  sidecar = null;
});
async function mediaFor(kind: 'local' | 'socket'): Promise<Pick<BootOptions, 'musicEnv' | 'media'>> {
  if (kind === 'local') return { musicEnv: HANG };
  // one sidecar per test: a second boot in the same test (a restart) reconnects to it, like the app container restarting alone
  if (sidecar) return { media: new CountingSocket({ socketPath: join(sidecar.dir, 'media.sock'), log: { warn() {} } }) };
  const dir = mkdtempSync(join(tmpdir(), 'm-'));
  chmodSync(dir, 0o755); // S1: the socket directory must be 0755 (mkdtemp makes 0700)
  const socketPath = join(dir, 'media.sock');
  const bins = fakeBinaries();
  const srv = await startMediaServer({
    socketPath, ytDlp: bins.ytDlp!, ffmpeg: bins.ffmpeg!, jsRuntime: join(dirname(bins.ytDlp!), 'js-runtime'), check: { ok: true },
    versions: { ytDlp: '2026.10.26', ffmpeg: '9.0.2' }, extraEnv: HANG, log: { warn() {}, info() {} },
  });
  sidecar = { srv, dir, tracks: 0 };
  return { media: new CountingSocket({ socketPath, log: { warn() {} } }) };
}

describe.each([['local'], ['socket']] as const)('m5 music (%s backend)', (kind) => {
  it('AC12a › /play <search> (fake yt-dlp/ffmpeg/voice) plays and /skip advances', async () => {
    await prepare();
    const v = voiceRig();
    const t = await boot(db.pool, { provider: new ActorProvider({}), voice: v.voice, ...(await mediaFor(kind)) });
    app = t.app;
    const deps = t.app.services.prawCommands;
    const p1 = slash('play', { strings: { query: 'lofi beats' } });
    expect(text(await handlePrawInteraction(p1, deps))).toMatch(/Playing/);
    expect(text(await handlePrawInteraction(slash('play', { strings: { query: 'second song' } }), deps))).toMatch(/Queued/);
    await until(() => v.sessions[0]?.played.length === 1);
    expect(v.sessions[0]!.calls[0]).toBe(`join:1565649426943442944/${VC}`);
    expect(text(await handlePrawInteraction(slash('skip'), deps))).toMatch(/Skipped; the next track/);
    await until(() => v.sessions[0]!.played.length === 2);
    const q = slash('queue');
    expect(text(await handlePrawInteraction(q, deps))).toMatch(/second song/);
    expect(q.deferred).toEqual({ ephemeral: true });
    const stored = await db.pool.query<{ queue: { query: string }[] }>('SELECT queue FROM music_state');
    expect(stored.rows[0]!.queue.map((x) => x.query)).toEqual(['second song']);
    const away = slash('play', { strings: { query: 'x' }, userId: 'u2' });
    expect(text(await handlePrawInteraction(away, deps))).toMatch(/voice channel/i);
  });

  it('queue › persists and restores after restart (music_state): restored paused, no auto-join', async () => {
    await prepare();
    const v1 = voiceRig();
    const one = await boot(db.pool, { provider: new ActorProvider({}), voice: v1.voice, ...(await mediaFor(kind)) });
    app = one.app;
    await handlePrawInteraction(slash('play', { strings: { query: 'first' } }), one.app.services.prawCommands);
    await handlePrawInteraction(slash('play', { strings: { query: 'second' } }), one.app.services.prawCommands);
    await handlePrawInteraction(slash('volume', { numbers: { percent: 60 } }), one.app.services.prawCommands);
    await until(() => v1.sessions[0]?.played.length === 1);
    await one.app.stop();
    app = null;
    expect((await db.pool.query('SELECT volume, paused, jsonb_array_length(queue) AS n FROM music_state')).rows).toEqual([{ volume: 60, paused: true, n: 2 }]);

    const v2 = voiceRig();
    const two = await boot(db.pool, { provider: new ActorProvider({}), voice: v2.voice, ...(await mediaFor(kind)) });
    app = two.app;
    expect(v2.sessions).toHaveLength(0);
    const q = await handlePrawInteraction(slash('queue'), two.app.services.prawCommands);
    expect(text(q)).toMatch(/Paused[\s\S]*first[\s\S]*second/);
    expect(text(q)).toMatch(/60%/);
  });

  it('music_play reaches Praw through the loop: a direct chat request plays without approval', async () => {
    await prepare();
    const v = voiceRig();
    const provider = new ActorProvider({ 'heads/praw': [turn({ name: 'music_play', input: { query: 'lofi' } }), turn(respond('chat', 'Playing lofi.'))] });
    const t = await boot(db.pool, { provider, voice: v.voice, ...(await mediaFor(kind)) });
    app = t.app;
    await t.app.services.scheduler.onMessage(humanMsg(`${mentionOf('praw')} play lofi`, { channelId: PRAW_WORK, author: { id: 'u1', name: 'u1', kind: 'human' }, mentionedHeads: ['praw'] }));
    await until(() => v.sessions[0]?.played.length === 1);
    expect(provider.callsOf('heads/praw')[0]!.tools.map((x) => x.name)).toEqual(expect.arrayContaining(['music_play', 'music_queue', 'music_skip', 'music_stop', 'music_volume']));
    expect((await db.pool.query("SELECT count(*)::int AS n FROM approvals")).rows[0].n).toBe(0);
  });
});

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('m5', () => {
  it('m5 › full flow with fakes: /voice join, spoken question that triggers web_search, spoken answer, /play during, ducking, /halt leaves', async () => {
    await prepare();
    const v = voiceRig();
    const net = {
      resolver: fakeResolver({ 'html.duckduckgo.com': ['52.142.124.215'] }),
      transport: fakeTransport({ 'https://html.duckduckgo.com/html/': { body: ddgResultsHtml([{ title: 'Node news', url: 'https://nodejs.org/en/blog', snippet: 'release' }]) } }),
    };
    const stt = new FakeProvider(Array.from({ length: 3 }, () => ({ text: 'พราวช่วยค้นข่าว node หน่อย', usage: { inputTokens: 300, outputTokens: 12 } })), 'gemini');
    const provider = new ActorProvider({ 'heads/praw': [turn({ name: 'web_search', input: { query: 'node news' } }), turn(respond('chat', 'ข่าว node ล่าสุดคือ release ใหม่ค่ะ'))] });
    const t = await boot(db.pool, { provider, extraProviders: [stt], voice: v.voice, musicEnv: HANG, net });
    app = t.app;
    const deps = t.app.services.prawCommands;
    const j = await handlePrawInteraction(cmd('voice', 'join', { channelId: PRAW_WORK, roles: [], userId: 'u1' }), deps);
    expect(j?.content).toContain('พราวเข้าห้องเสียงแล้ว');
    const s = v.sessions[0]!;
    expect(text(await handlePrawInteraction(slash('play', { strings: { query: 'lofi beats' } }), deps))).toMatch(/Playing/); // /play during the voice session
    await until(() => s.played.length === 1);
    s.speak('u1', chunks(tone(800), silence(900)));
    await until(() => s.overlays.length === 1);
    // the question really went through web_search (a read tool: voice needs no approval for it), the answer was spoken over the music
    expect(net.transport.requests.map((r) => r.url.href)).toEqual(['https://html.duckduckgo.com/html/']);
    expect(JSON.stringify(provider.callsOf('heads/praw')[1]!.messages)).toContain('nodejs.org/en/blog');
    expect(s.overlays[0]).toMatchObject({ ducked: true }); // ducked while she speaks
    expect(s.overlays[0]!.pcm.toString()).toBe('pcm:ข่าว node ล่าสุดคือ release ใหม่ค่ะ');
    await until(() => s.calls.at(-1) === 'duck:false');
    expect(s.played).toHaveLength(1); // the music track was never replaced or skipped
    expect(s.ducked).toBe(false);
    expect((await db.pool.query('SELECT count(*)::int AS n FROM approvals')).rows[0].n).toBe(0);
    // /halt leaves voice (and stops the music with it) within the 2 s bound
    const t0 = Date.now();
    await t.app.services.halt.halt('owner');
    await until(() => s.calls.includes('leave'), 2000);
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(t.app.services.voice.current()).toBeNull();
    expect(t.app.services.music?.isPlaying()).toBe(false);
  });

  it('m5 › MEDIA_SOCKET selects the sidecar when no test override is given (createApp\'s own selectMediaBackend)', async () => {
    await prepare();
    const m = await mediaFor('socket');
    const socketPath = join(sidecar!.dir, 'media.sock');
    expect(m.media).toBeDefined();
    const v = voiceRig();
    const t = await boot(db.pool, { provider: new ActorProvider({}), voice: v.voice, binaries: null, env: { mediaSocket: socketPath } });
    app = t.app;
    expect(t.app.services.music).not.toBeNull(); // the sidecar's health said ok: music is on
    expect(sidecar!.srv.active().tracks).toBe(0);
    await handlePrawInteraction(slash('play', { strings: { query: 'lofi' } }), t.app.services.prawCommands);
    await until(() => v.sessions[0]?.played.length === 1);
    expect(sidecar!.srv.active().tracks).toBe(1); // the track runs in the sidecar, not in this process
    sidecar!.tracks++; // counted here: the app built its own SocketMediaBackend
  });

  it('m5 › the music idle gate: isPlaying is true while a track runs and false after /stop', async () => {
    await prepare();
    const v = voiceRig();
    const t = await boot(db.pool, { provider: new ActorProvider({}), voice: v.voice, musicEnv: HANG });
    app = t.app;
    const deps = t.app.services.prawCommands;
    expect(t.app.services.music?.isPlaying()).toBe(false);
    await handlePrawInteraction(slash('play', { strings: { query: 'lofi' } }), deps);
    await until(() => v.sessions[0]?.played.length === 1);
    expect(t.app.services.music?.isPlaying()).toBe(true);
    await handlePrawInteraction(slash('stop'), deps);
    await until(() => t.app.services.music?.isPlaying() === false);
  });

  it('m5 › all tool schemas (every plugin) convert for Gemini; tool names unique; praw policy covers all', async () => {
    await prepare();
    const gh = githubRoutes({ appId: APP_ID, installationId: INSTALLATION_ID, publicKey: KP.publicKey, repos: [REPO] });
    const CU = { token: 'pk_12345678_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345', listId: '901800000001' };
    const f = fakeFetch({ ...clickupRoutes({ token: CU.token, listId: CU.listId }), ...gh.routes });
    const env = {
      clickup: { apiToken: CU.token, listId: CU.listId },
      github: { appId: APP_ID, installationId: INSTALLATION_ID, privateKey: PEM }, googleSheets: { url: 'https://script.google.com/macros/s/AKfycbxPLANTEDdeploy_id-9/exec', secret: 'sheets-secret-m5' },
    };
    const v = voiceRig();
    const provider = new ActorProvider({ 'heads/praw': [turn(respond('chat', 'hi'))] });
    const stt = new FakeProvider([], 'gemini');
    const t = await boot(db.pool, { provider, extraProviders: [stt], voice: v.voice, musicEnv: HANG, env, fetch: f });
    app = t.app;
    await t.app.services.scheduler.onMessage(humanMsg(`${mentionOf('praw')} hi`, { channelId: PRAW_WORK, author: { id: 'u1', name: 'u1', kind: 'human' }, mentionedHeads: ['praw'] }));
    await t.app.services.scheduler.idle();
    const req = provider.callsOf('heads/praw')[0]!;
    const names = req.tools.map((x) => x.name);
    expect(new Set(names).size).toBe(names.length); // unique
    // praw's policy ("*") offers every plugin's tools: M2 .. M5 groups all present
    for (const n of ['web_search', 'fetch_page', 'add_reminder', 'write_file', 'pin_message', 'save_lesson', 'clickup_create_task', 'github_create_pull_request', 'ocr_image', 'extract_receipt', 'sheets_append_receipt', 'music_play', 'music_queue', 'music_skip', 'music_stop', 'music_volume']) {
      expect(names, n).toContain(n);
    }
    const g = toGeminiRequest(req);
    expect(g.functionDeclarations).toHaveLength(names.length);
    for (const d of g.functionDeclarations) expect(JSON.stringify(d), d.name).not.toMatch(/additionalProperties|\$schema|\$ref/);
  });

  describe('acceptance matrix (tests/acceptance-matrix.json)', () => {
    type Matrix = { acceptance: Record<string, string[]>; gate1: Record<string, string[]>; notes?: Record<string, string> };
    const matrix: Matrix = JSON.parse(readFileSync(join(ROOT, 'tests', 'acceptance-matrix.json'), 'utf8'));
    const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.name === 'node_modules' || e.name === 'dist' || e.name === '.git' ? [] : e.isDirectory() ? walk(join(d, e.name)) : /\.test\.ts$/.test(e.name) ? [join(d, e.name)] : []));
    const TITLE = /\b(?:it|test)(?:\.\w+)?\(\s*(['"`])((?:\\.|(?!\1)[^\\])*)\1/g;
    const titlesOf = (file: string): Set<string> => {
      const out = new Set<string>();
      for (const m of readFileSync(join(ROOT, file), 'utf8').matchAll(TITLE)) out.add(m[2]!.replace(/\\(['"`\\])/g, '$1'));
      return out;
    };
    const missing = (ids: string[]): string[] => ids.filter((id) => {
      const [file, title] = id.split(' :: ');
      try { return !titlesOf(file!).has(title!); } catch { return true; }
    });

    it('m5 › acceptance matrix covers every P1-P24 test id named in the Gate 1 table', () => {
      expect(Object.keys(matrix.gate1).sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)))).toEqual(Array.from({ length: 24 }, (_, i) => `P${i + 1}`));
      for (const [p, ids] of Object.entries(matrix.gate1)) {
        expect(ids.length, p).toBeGreaterThan(0);
        expect(missing(ids), `${p}: test ids not found in their files`).toEqual([]);
      }
      expect(walk(ROOT).length).toBeGreaterThan(100); // the walker really sees the suite
    });

    it('m5 › coverage list: every acceptance item 1–14 has a test id in the matrix file tests/acceptance-matrix.json (script asserts ids exist)', () => {
      expect(Object.keys(matrix.acceptance).sort((a, b) => Number(a) - Number(b))).toEqual(Array.from({ length: 14 }, (_, i) => String(i + 1)));
      for (const [ac, ids] of Object.entries(matrix.acceptance)) {
        expect(ids.length, `AC${ac}`).toBeGreaterThan(0);
        expect(missing(ids), `AC${ac}: test ids not found in their files`).toEqual([]);
      }
      // the checker bites: an id with a wrong title is reported
      expect(missing(['tests/integration/praw-m5.int.test.ts :: no such title'])).toHaveLength(1);
    });

    it('m5 › no external call in the whole suite (no-network guard active)', async () => {
      // unit project: the setup file blocks fetch and net.connect (tests/no-network.test.ts proves it); the unit config must keep loading it
      expect(readFileSync(join(ROOT, 'vitest.config.ts'), 'utf8')).toMatch(/name: 'unit',\s*setupFiles: \['\.\/vitest\.setup\.no-network\.ts'\]/);
      // int project: this file's own guard recorded every non-loopback attempt made by the m5 tests above
      expect(external).toEqual([]); // nothing reached out during the earlier m5 tests ...
      await expect(fetch('https://example.com/')).rejects.toThrow(/m5: external fetch/);
      expect(external).toEqual(['fetch example.com']); // ... and the guard bites when something does
      external.length = 0;
    });
  });
});
