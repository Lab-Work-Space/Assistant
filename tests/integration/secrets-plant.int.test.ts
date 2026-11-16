import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Client } from 'discord.js';
import { createApp, type App } from '../../app.js';
import { PRAW_DEFAULT_MODEL, seed } from '../../company/index.js';
import { createLogger } from '../../core/logger.js';
import { ChannelMapRepo, DepartmentRepo, PersonaRepo } from '../../db/repos/index.js';
import { freshDb, type TestDb } from '../../db/test-helpers.js';
import { PROMPTS_DIR, loadPrompts } from '../../prompts/index.js';
import { createGeminiProvider, GeminiHttpError } from '../../providers/gemini/index.js';
import { ProviderRegistry } from '../../providers/index.js';
import { fakeChannel, fakeClient, fakeGuild, type FakeChannel } from '../fakes/discordClient.js';
import { clickupRoutes, fakeFetch, githubRoutes } from '../fakes/http.js';
import { generateKeyPairSync } from 'node:crypto';
import { fakeGemini, type GeminiAttempt } from '../fakes/gemini.js';
import type { Resolver, Transport } from '../../net/guard.js';
import { fakeResolver, fakeTransport } from '../fakes/net.js';
import { cmd } from '../../discord/commands/test-helpers.js';
import { handlePrawInteraction } from '../../discord/praw/index.js';
import { chunks, silence, tone } from '../../voice/chat/test-helpers.js';
import { FakeVoiceSession } from '../fakes/voice.js';
import { BOT_IDS, fakeBinaries, humanMsg, mentionOf, migrateUp, resetDb, testEnv } from './helpers.js';

// Shaped like the real thing so the output-side patterns apply (the port redacts by pattern, the logger by pattern + literal).
const KEY = 'AIzaSyPlantedKey0123456789abcdefgh';
const TOKEN = 'MTIzNDU2Nzg5MDEyMzQ1Njc4.GabCdE.abcdefghijklmnopqrstuvwxyz0';
const SANDBOX = '1565999999999999777';
const prompts = loadPrompts(PROMPTS_DIR);

let db: TestDb;
let app: App | null = null;
beforeAll(async () => {
  db = await freshDb();
  await migrateUp(db.pool);
});
afterEach(async () => {
  await app?.stop();
  app = null;
  await resetDb(db.pool);
});
afterAll(async () => {
  await db.close();
});

/** Boots the real app with the REAL DiscordPort over fake discord.js clients that capture every sent payload. */
type RunOpts = { script?: GeminiAttempt[]; workspaceDir?: string; text?: string; env?: Record<string, unknown>; clickupFetch?: typeof fetch; attachments?: { name: string; url: string; size: number }[]; net?: { resolver: Resolver; transport: Transport }; after?: (app: App) => Promise<void> };
async function run(o: RunOpts = {}) {
  await seed({ departments: new DepartmentRepo(db.pool), personas: new PersonaRepo(db.pool), channelMap: new ChannelMapRepo(db.pool) }, prompts);
  await db.pool.query("UPDATE departments SET work_channel_id = $1 WHERE id = 'praw'", [SANDBOX]);
  await db.pool.query("INSERT INTO config (key, value) VALUES ('provider.default', $1)", [JSON.stringify({ provider: 'gemini', model: PRAW_DEFAULT_MODEL })]);
  const channels = new Map<string, FakeChannel>();
  const chan = (id: string) => channels.get(id) ?? (channels.set(id, fakeChannel(id)), channels.get(id)!);
  const createClient = (d: keyof typeof BOT_IDS): Client => fakeClient({ userId: BOT_IDS[d], guild: fakeGuild(), channelFetch: async (id) => chan(id) });

  const lines: string[] = [];
  const sink = new Writable({ write(chunk, _e, cb) { lines.push(String(chunk)); cb(); } });
  const logger = createLogger('trace', { secrets: [KEY, TOKEN], destination: sink });
  const echo = `my key is ${KEY} and token ${TOKEN}`;
  const gemini = fakeGemini(o.script ?? [
    // the model calls a tool whose name carries the key (hostile/injected), then answers with both secrets in the text
    { chunks: [{ functionCalls: [{ name: `leak_${KEY}`, args: { v: TOKEN } }], usage: { promptTokens: 10, candidatesTokens: 5 } }] },
    { chunks: [{ functionCalls: [{ name: 'respond', args: { type: 'chat', body: `ok ${echo}` } }], usage: { promptTokens: 10, candidatesTokens: 5 } }] },
    { reject: new GeminiHttpError(503, `HTTP 503 https://generativelanguage.googleapis.com/x?key=${KEY} Bot ${TOKEN}`) },
  ]);
  const providers = new ProviderRegistry();
  providers.register(createGeminiProvider({ client: gemini, sleep: async () => undefined, random: () => 0 }));
  const env = { ...testEnv(['hq', 'praw']), geminiApiKey: KEY, botTokens: { hq: 'token-hq', praw: TOKEN }, ...(o.workspaceDir ? { prawWorkspaceDir: o.workspaceDir } : {}), ...o.env };
  app = await createApp(env, { pool: db.pool, providers, createClient, healthPort: 0, logger, binaries: fakeBinaries(), ...(o.clickupFetch ? { fetch: o.clickupFetch } : {}), ...(o.net ? { net: o.net } : {}) });
  await app.start();
  await app.services.scheduler.onMessage(humanMsg(`${mentionOf('praw')} ${o.text ?? echo}`, { channelId: SANDBOX, mentionedHeads: ['praw'], ...(o.attachments ? { attachments: o.attachments } : {}) }));
  await app.services.scheduler.idle();
  await o.after?.(app);
  if (o.script) return { sent: JSON.stringify([...channels.values()].flatMap((c) => c.sent)), audit: JSON.stringify((await db.pool.query('SELECT * FROM audit_log')).rows), logs: lines.join(''), gemini };
  // a second turn that fails upstream with the key in the error text
  await app.services.scheduler.onMessage(humanMsg(`${mentionOf('praw')} again`, { channelId: SANDBOX, mentionedHeads: ['praw'] }));
  await app.services.scheduler.idle();
  const sent = JSON.stringify([...channels.values()].flatMap((c) => c.sent));
  const audit = JSON.stringify((await db.pool.query('SELECT * FROM audit_log')).rows);
  return { sent, audit, logs: lines.join(''), gemini };
}

describe('secrets plant (P24)', () => {
  it('planted GEMINI_API_KEY and BOT_TOKEN_PRAW are absent from audit rows, captured logs and embeds', async () => {
    const r = await run();
    expect(r.gemini.calls).toBeGreaterThanOrEqual(2);
    // the planted values did travel through the pipeline and were masked on the way out
    expect(r.sent).toContain('ok ');
    expect(r.sent).toContain('[REDACTED]');
    expect(r.logs.length).toBeGreaterThan(0);
    for (const [where, text] of [['embeds', r.sent], ['audit', r.audit], ['logs', r.logs]] as const) {
      expect(text, where).not.toContain(KEY);
      expect(text, where).not.toContain(TOKEN);
      expect(text, where).not.toContain('AIzaSyPlanted');
    }
  });
});

describe('secrets plant, M2 (P24)', () => {
  it('M2 keys planted (incl. workspace paths) absent from audit rows, logs, embeds', async () => {
    const wsDir = join(mkdtempSync(join(tmpdir(), 'plant-')), 'PLANTED-WORKSPACE-DIR-7f3a9c');
    const usage = { promptTokens: 10, candidatesTokens: 5 };
    const fcs = (...f: { name: string; args: Record<string, unknown> }[]): GeminiAttempt => ({ chunks: [{ functionCalls: f, usage }] });
    try {
      const r = await run({
        workspaceDir: wsDir,
        text: `remember this: ${KEY}`,
        script: [
          // secrets travel as tool arguments (reminder/lesson/file text, an absolute host path, a hostile URL) and come back in errors
          fcs(
            { name: 'add_reminder', args: { text: `call me, key ${KEY}`, when: { inMinutes: 5 } } },
            { name: 'save_lesson', args: { text: `token ${TOKEN}` } },
            { name: 'write_file', args: { path: 'notes.txt', content: `key ${KEY}` } },
            { name: 'write_file', args: { path: `${wsDir}/abs.txt`, content: 'x' } },
            { name: 'write_file', args: { path: '../../PLANTED-WORKSPACE-DIR-7f3a9c/up.txt', content: 'x' } },
            { name: 'read_file', args: { path: 'missing.txt' } },
            { name: 'fetch_page', args: { url: `http://127.0.0.1/?key=${KEY}` } },
          ),
          fcs({ name: 'respond', args: { type: 'chat', body: 'done' } }),
        ],
      });
      expect(r.gemini.calls).toBeGreaterThanOrEqual(2);
      expect(r.audit).toContain('write_file'); // the M2 tools really ran and were audited
      // positive control: the planted path really reached the pipeline's input (the tool arguments above), so its absence below means something
      expect(JSON.stringify(r.gemini.requests)).toContain('PLANTED-WORKSPACE-DIR');
      for (const [where, text] of [['embeds', r.sent], ['audit', r.audit], ['logs', r.logs]] as const) {
        expect(text, where).not.toContain(KEY);
        expect(text, where).not.toContain(TOKEN);
        expect(text, `${where} workspace path`).not.toContain('PLANTED-WORKSPACE-DIR');
      }
    } finally {
      rmSync(join(wsDir, '..'), { recursive: true, force: true });
    }
  });
});

describe('secrets plant, M3 (P24)', () => {
  it('secrets-plant › CLICKUP_API_TOKEN absent from audit rows, logs, embeds', async () => {
    const PK = 'pk_98765432_ZYXWVUTSRQPONMLKJIHGFEDCBA987654';
    const usage = { promptTokens: 10, candidatesTokens: 5 };
    // the fake ClickUp echoes the Authorization header in an error body; the tool result must not carry it
    const f = fakeFetch({
      'https://api.clickup.com/api/v2/list/901800000001': { status: 500, body: { err: `boom ${PK}` } },
      'https://api.clickup.com/api/v2/list/901800000001/task': (r) => ({ status: 200, body: { tasks: [{ id: 'a1', name: `task ${r.headers['authorization']}`, status: { status: 'open', type: 'open' } }], last_page: true } }),
    });
    const r = await run({
      env: { clickup: { apiToken: PK, listId: '901800000001' } },
      clickupFetch: f,
      text: 'list my clickup tasks',
      script: [
        { chunks: [{ functionCalls: [{ name: 'clickup_list_projects', args: {} }, { name: 'clickup_list_open_tasks', args: {} }, { name: 'clickup_get_task_detail', args: { task_id: `../${PK}` } }], usage }] },
        { chunks: [{ functionCalls: [{ name: 'respond', args: { type: 'chat', body: `done, token ${PK}` } }], usage }] },
      ],
    });
    expect(r.audit).toContain('clickup_list_projects'); // the tools really ran and were audited
    expect(f.requests.length).toBeGreaterThan(0);
    expect(f.requests.every((q) => q.headers['authorization'] === PK)).toBe(true);
    expect(r.sent).toContain('[REDACTED]'); // the model's echo of the token was masked on the way out
    for (const [where, text] of [['embeds', r.sent], ['audit', r.audit], ['logs', r.logs], ['tool results fed back to the model', JSON.stringify(r.gemini.requests).split(`../${PK}`).join('')]] as const) {
      expect(text, where).not.toContain(PK);
      expect(text, where).not.toContain('pk_98765432');
    }
  });
});

describe('secrets plant, M3 github (P24)', () => {
  const kp = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const PEM = kp.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
  const body = PEM.split('\n')[1]!;
  const usage = { promptTokens: 10, candidatesTokens: 5 };
  const call = (name: string, args: Record<string, unknown>) => ({ chunks: [{ functionCalls: [{ name, args }], usage }] });

  it('secrets-plant › PEM, JWT and installation tokens absent from audit rows, logs, embeds', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ghplant-'));
    try {
      const path = join(dir, 'app.pem');
      writeFileSync(path, PEM);
      chmodSync(path, 0o600);
      const { routes, mints } = githubRoutes({ appId: '123456', installationId: '987654', publicKey: kp.publicKey, repos: [{ owner: 'acme', name: 'widgets', id: 7, issues: [{ number: 1, title: 'ghs_PlantedInstallationToken0123456789abcdefghij', state: 'open', user: { login: 'a' } }] }] });
      const f = fakeFetch(routes);
      const r = await run({
        env: { github: { appId: '123456', installationId: '987654', privateKeyPath: path } },
        clickupFetch: f,
        text: 'look at github',
        script: [
          { chunks: [{ functionCalls: [{ name: 'github_get_repository_info', args: { owner: 'acme', repo: 'widgets' } }, { name: 'github_list_repository_issues', args: { owner: 'acme', repo: 'widgets' } }, { name: 'github_get_issue', args: { owner: 'acme', repo: '../../x' } }], usage }] },
          call('respond', { type: 'chat', body: `done ghs_PlantedInstallationToken0123456789abcdefghij` }),
        ],
      });
      expect(r.audit).toContain('github_get_repository_info');
      expect(mints.length).toBeGreaterThan(0);
      const jwts = f.requests.filter((q) => q.url.includes('/access_tokens')).map((q) => q.headers['authorization']!.slice(7));
      for (const [where, text] of [['embeds', r.sent], ['audit', r.audit], ['logs', r.logs], ['tool results fed back to the model', JSON.stringify(r.gemini.requests)]] as const) {
        expect(text, where).not.toContain(body);
        expect(text, where).not.toContain('PRIVATE KEY');
        expect(text, where).not.toContain('PlantedInstallationToken');
        for (const j of jwts) expect(text, where).not.toContain(j);
        for (const m of mints) expect(text, where).not.toContain(m.token);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('secrets-plant › PEM 0644 refused', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ghplant-'));
    try {
      const path = join(dir, 'app.pem');
      writeFileSync(path, PEM);
      chmodSync(path, 0o644);
      const f = fakeFetch({});
      const r = await run({
        env: { github: { appId: '123456', installationId: '987654', privateKeyPath: path } },
        clickupFetch: f,
        text: 'look at github',
        script: [call('github_get_repository_info', { owner: 'acme', repo: 'widgets' }), call('respond', { type: 'chat', body: 'ok' })],
      });
      expect(f.requests).toHaveLength(0); // the group is off: no token request, no API call
      expect(r.sent + r.audit + r.logs).not.toContain(body);
      expect(r.sent + r.audit + r.logs).not.toContain('PRIVATE KEY');
      expect(r.logs + r.sent).toMatch(/github/i); // the startup alert names the group and the reason
      expect(r.logs + r.sent).toMatch(/0600|mode/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('secrets plant, M3 writes (P24)', () => {
  it('secrets-plant › CLICKUP/GITHUB keys, PEM contents and minted tokens planted together, absent from audit rows, logs, embeds (write path)', async () => {
    const PK = 'pk_98765432_ZYXWVUTSRQPONMLKJIHGFEDCBA987654';
    const kp = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const PEM = kp.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
    const body = PEM.split('\n')[1]!;
    const usage = { promptTokens: 10, candidatesTokens: 5 };
    const call = (name: string, args: Record<string, unknown>) => ({ chunks: [{ functionCalls: [{ name, args }], usage }] });
    const gh = githubRoutes({ appId: '123456', installationId: '987654', publicKey: kp.publicKey, repos: [{ owner: 'acme', name: 'widgets', id: 7 }] });
    const f = fakeFetch({
      ...clickupRoutes({ token: PK, listId: '901800000001' }),
      ...gh.routes,
    });
    const r = await run({
      env: { clickup: { apiToken: PK, listId: '901800000001' }, github: { appId: '123456', installationId: '987654', privateKey: PEM } },
      clickupFetch: f,
      text: 'write things',
      script: [
        { chunks: [{ functionCalls: [
          { name: 'clickup_create_task', args: { name: `t ${PK}`, description: 'd' } },
          { name: 'github_create_branch', args: { owner: 'acme', repo: 'widgets', name: 'x-branch' } },
        ], usage }] },
        call('respond', { type: 'chat', body: `done ${PK}` }),
      ],
    });
    expect(r.audit).toContain('clickup_create_task'); // the write tools really ran and were audited
    for (const [where, text] of [['embeds', r.sent], ['audit', r.audit], ['logs', r.logs]] as const) {
      expect(text, where).not.toContain(PK);
      expect(text, where).not.toContain(body);
      expect(text, where).not.toContain('PRIVATE KEY');
      for (const m of gh.mints) expect(text, where).not.toContain(m.token);
    }
  });
});

describe('secrets plant, M4 sheets (P24)', () => {
  it('secrets-plant › GOOGLE_SHEETS_WEBAPP_SECRET absent from audit rows, logs, embeds and the model input; it only travels in the POST body', async () => {
    const SECRET = 'sheets-secret-PLANTED-Zq81xK_77';
    const SHEETS_URL = 'https://script.google.com/macros/s/AKfycbxPLANTEDdeploy_id-9/exec';
    const CDN = 'https://cdn.discordapp.com/attachments/1/2/r.png?ex=1&hm=2';
    const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('\0\0\0\rIHDR\0\0\0\x10\0\0\0\x10\x08\x02\0\0\0', 'latin1')]);
    const transport = fakeTransport({
      [CDN]: { headers: { 'content-type': 'image/png' }, body: [PNG] },
      [SHEETS_URL]: { status: 302, headers: { location: 'https://script.googleusercontent.com/macros/echo?user_content_key=abc' }, body: '' },
    });
    const net = { resolver: fakeResolver({ 'cdn.discordapp.com': ['162.159.130.233'], 'script.google.com': ['142.250.4.100'] }), transport };
    const usage = { promptTokens: 10, candidatesTokens: 5 };
    const row = { date: '2026-10-30', merchant: 'Cafe Dee', currency: 'THB', total: 155.15 };
    const receipt = JSON.stringify({ ...row, items: [], total: 155.15 });
    const r = await run({
      text: 'read this receipt and add it to the sheet',
      attachments: [{ name: 'r.png', url: CDN, size: PNG.length }],
      env: { googleSheets: { url: SHEETS_URL, secret: SECRET } },
      net,
      script: [
        { chunks: [{ functionCalls: [{ name: 'extract_receipt', args: {} }], usage }] },
        { chunks: [{ text: receipt, usage }] },
        { chunks: [{ functionCalls: [{ name: 'sheets_append_receipt', args: row }], usage }] },
        { chunks: [{ functionCalls: [{ name: 'respond', args: { type: 'chat', body: 'done' } }], usage }] },
      ],
      after: async (a) => {
        const ids = (await db.pool.query<{ id: number }>("SELECT id FROM approvals WHERE status = 'pending'")).rows.map((x) => x.id);
        for (const id of ids) await a.services.approvals.decide(id, 'approved', { id: 'admin1', isAdmin: true });
        await a.services.scheduler.idle();
      },
    });
    const posts = transport.requests.filter((q) => q.url.href === SHEETS_URL);
    expect(posts).toHaveLength(1); // the approved export really ran once
    expect(Buffer.from(posts[0]!.body ?? '').toString('utf8')).toContain(SECRET); // and the secret travelled only in its body
    expect(r.audit).toContain('sheets_append_receipt');
    // The secret is opaque (no recognisable shape), so what keeps it out of embeds is that no tool, prompt or result ever carries it.
    for (const [where, text] of [['embeds', r.sent], ['audit', r.audit], ['logs', r.logs], ['model input', JSON.stringify(r.gemini.requests)]] as const) {
      expect(text, where).not.toContain(SECRET);
      expect(text, where).not.toContain('Zq81xK');
      expect(text, where).not.toContain('AKfycbxPLANTED');
    }
  });
});

describe('secrets plant, M1-M5 together (P24)', () => {
  it('secrets-plant › every env key planted across M1-M5 is absent from audit rows, logs and embeds', async () => {
    // one value per secret env key: Discord token, Gemini, master key (hex and base64), ClickUp, GitHub App PEM, Sheets webapp secret, DB password
    const PK = 'pk_98765432_ZYXWVUTSRQPONMLKJIHGFEDCBA987654';
    const SHEETS = 'sheets-secret-PLANTED-Zq81xK_77';
    const DBPW = 'planted-db-password-Q9v3';
    const MASTER = Buffer.alloc(32, 9);
    const kp = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const PEM = kp.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
    const body = PEM.split('\n')[1]!;
    const secrets = [KEY, TOKEN, PK, SHEETS, DBPW, PEM, MASTER.toString('hex'), MASTER.toString('base64')];
    const echo = secrets.join(' ');
    const usage = { promptTokens: 10, candidatesTokens: 5 };
    const call = (name: string, args: Record<string, unknown>) => ({ chunks: [{ functionCalls: [{ name, args }], usage }] });
    const r = await run({
      text: `echo ${echo}`,
      env: {
        configMasterKey: MASTER, databaseUrl: `postgres://u:${DBPW}@127.0.0.1:5432/x`,
        clickup: { apiToken: PK, listId: '901800000001' },
        github: { appId: '123456', installationId: '987654', privateKey: PEM }, googleSheets: { url: 'https://script.google.com/macros/s/AKfycbxPLANTEDdeploy_id-9/exec', secret: SHEETS },
      },
      script: [call(`leak_${KEY}`, { v: echo }), call('respond', { type: 'chat', body: `ok ${echo}` })],
    });
    for (const [where, text] of [['embeds', r.sent], ['audit', r.audit], ['logs', r.logs]] as const) {
      for (const secret of secrets) expect(text, `${where}: ${secret.slice(0, 12)}`).not.toContain(secret);
      expect(text, where).not.toContain(body); // no line of the PEM survives either
      expect(text, where).not.toContain('PRIVATE KEY');
    }
    expect(r.audit).toContain('llm.call'); // the run really happened and was audited
  });
});

describe('secrets plant, M5 voice TTS (P24)', () => {
  it('secrets-plant › a literal secret in Praw\'s voice reply is masked before TTS and in the text fallback', async () => {
    const SHEETS = 'sheets-secret-PLANTED-Zq81xK_77'; // opaque: only the literal list can mask it
    const VC = '1565999999999999555';
    await seed({ departments: new DepartmentRepo(db.pool), personas: new PersonaRepo(db.pool), channelMap: new ChannelMapRepo(db.pool) }, prompts);
    await db.pool.query("UPDATE departments SET work_channel_id = $1 WHERE id = 'praw'", [SANDBOX]);
    await db.pool.query("INSERT INTO config (key, value) VALUES ('provider.default', $1)", [JSON.stringify({ provider: 'gemini', model: PRAW_DEFAULT_MODEL })]);
    const createClient = (d: keyof typeof BOT_IDS): Client => fakeClient({ userId: BOT_IDS[d], guild: fakeGuild(), channelFetch: async (id) => fakeChannel(id) });
    const usage = { promptTokens: 10, candidatesTokens: 5 };
    const reply = (body: string): GeminiAttempt => ({ chunks: [{ functionCalls: [{ name: 'respond', args: { type: 'chat', body } }], usage }] });
    const gemini = fakeGemini([
      { chunks: [{ text: 'พราวบอกรหัสหน่อย', usage }] }, reply(`รหัสคือ ${SHEETS} ค่ะ`),
      { chunks: [{ text: 'อีกครั้งนะ', usage }] }, reply(`อีกครั้ง ${SHEETS}`),
    ]);
    const providers = new ProviderRegistry();
    providers.register(createGeminiProvider({ client: gemini, sleep: async () => undefined, random: () => 0 }));
    const spoken: string[] = [];
    let ttsFails = false;
    const sessions: FakeVoiceSession[] = [];
    const posted: string[] = [];
    const env = { ...testEnv(['hq', 'praw']), geminiApiKey: KEY, botTokens: { hq: 'token-hq', praw: TOKEN }, googleSheets: { url: 'https://script.google.com/macros/s/AKfycbxPLANTEDdeploy_id-9/exec', secret: SHEETS } };
    app = await createApp(env, {
      pool: db.pool, providers, createClient, healthPort: 0, binaries: fakeBinaries(),
      logger: createLogger('silent', { secrets: [KEY, TOKEN, SHEETS] }),
      voice: {
        createSession: () => { const s = new FakeVoiceSession({ holdPlay: true }); sessions.push(s); return s; }, checkChannel: async () => null,
        voiceChannelOf: async (u: string) => (u === 'u1' ? VC : null),
        tts: { synthesize: async (text: string) => { spoken.push(text); if (ttsFails) throw new Error('edge down'); return Buffer.from('pcm'); } },
      },
    });
    await app.start();
    const port = app.services.port;
    const orig = port.post.bind(port);
    port.post = async (actor, target, payload) => { posted.push(payload.body); return orig(actor, target, payload); };
    const join = await handlePrawInteraction(cmd('voice', 'join', { channelId: SANDBOX, roles: [], userId: 'u1' }), app.services.prawCommands);
    expect(join?.ephemeral).toBe(false);
    const s = sessions[0]!;
    const until = async (f: () => boolean) => { const end = Date.now() + 4000; while (!f()) { if (Date.now() > end) throw new Error('timeout'); await new Promise((x) => setTimeout(x, 10)); } };
    s.speak('u1', chunks(tone(800), silence(900)));
    await until(() => spoken.length === 1);
    expect(spoken[0]).toContain('[REDACTED]'); // positive control: the reply did carry the secret, masked before TTS
    ttsFails = true;
    s.speak('u1', chunks(tone(800), silence(900)));
    await until(() => posted.some((p) => p.includes('อีกครั้ง')));
    for (const [where, text] of [['tts text', spoken.join('\n')], ['announce fallback', posted.join('\n')]] as const) {
      expect(text, where).not.toContain(SHEETS);
      expect(text, where).not.toContain('Zq81xK');
    }
  });
});
