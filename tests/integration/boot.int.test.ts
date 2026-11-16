import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { App } from '../../app.js';
import { freshDb, type TestDb } from '../../db/test-helpers.js';
import { GUILD, TestPort, boot, fakeBinaries, resetDb } from './helpers.js';

let db: TestDb;
let app: App | null = null;
beforeAll(async () => {
  db = await freshDb();
});
afterEach(async () => {
  await app?.stop();
  app = null;
  await resetDb(db.pool);
});
afterAll(async () => {
  await db.close();
});

const groupAlerts = (port: TestPort) => port.posts.filter((p) => String(p.payload.title).startsWith('Incident ') && p.payload.body.includes('where: boot · tool groups')); // BOTLOG-1

describe('boot.test.ts', () => {
  it('wrong yt-dlp sha256 disables music with alert (P22); boot continues', async () => {
    const port = new TestPort();
    const t = await boot(db.pool, { port, binaries: fakeBinaries({ ytDlp: 'f'.repeat(64) }) });
    app = t.app;
    const alerts = groupAlerts(port);
    expect(alerts).toHaveLength(1); // one alert for every disabled group (R13)
    expect(alerts[0]!.payload.body).toMatch(/music/);
    expect(alerts[0]!.payload.body).toMatch(/yt-dlp/);
    expect(alerts[0]!.payload.body).not.toMatch(/\bvoice\b/); // voice chat needs only ffmpeg
    expect(t.app.services.healthUrl()).not.toBeNull(); // the app is up
    expect(t.app.services.voice.current()).toBeNull();
  });

  it('matching binaries disable nothing', async () => {
    const port = new TestPort();
    const t = await boot(db.pool, { port });
    app = t.app;
    for (const a of groupAlerts(port)) expect(a.payload.body).not.toMatch(/music|yt-dlp|ffmpeg/);
  });

  it('BOTLOG-1: a second boot with the same disabled tool groups posts nothing about tool groups; a changed set posts again', async () => {
    const off = (id: string, why: string) => () => ({ id, disabled: why });
    const p1 = new TestPort();
    const t1 = await boot(db.pool, { port: p1, groups: [off('zeta', 'ZETA_KEY not set')] });
    expect(groupAlerts(p1)).toHaveLength(1);
    await t1.app.stop();
    const p2 = new TestPort();
    const t2 = await boot(db.pool, { port: p2, groups: [off('zeta', 'ZETA_KEY not set')] });
    app = t2.app;
    expect(groupAlerts(p2)).toHaveLength(0); // unchanged: no per-boot noise
    await t2.app.stop();
    const p3 = new TestPort();
    const t3 = await boot(db.pool, { port: p3, groups: [off('zeta', 'ZETA_KEY not set'), off('omega', 'OMEGA_KEY not set')] });
    app = t3.app;
    expect(groupAlerts(p3)).toHaveLength(1);
    expect(groupAlerts(p3)[0]!.payload.body).toContain('omega');
  });

  it('halt disconnects voice through the app bus', async () => {
    const t = await boot(db.pool, {});
    app = t.app;
    const left: string[] = [];
    t.app.services.voice.onLeave(() => { left.push('cleared'); });
    await t.app.services.halt.halt('owner');
    expect(left).toEqual(['cleared']);
  });

  it('ffmpeg missing → voice join refused with the reason (M6)', async () => {
    const t = await boot(db.pool, { binaries: fakeBinaries({ ffmpeg: 'e'.repeat(64) }) });
    app = t.app;
    await expect(t.app.services.voice.join('1565999999999999555', GUILD)).rejects.toThrow(/Voice is disabled: .*ffmpeg/);
  });

  it('an out-of-band halt (config row, no bus event) and a boot while halted both refuse voice joins (D9)', async () => {
    const t = await boot(db.pool, {});
    const left: string[] = [];
    t.app.services.voice.onLeave(() => { left.push('cleared'); });
    await t.app.services.cfg.set('halted', true, 'another-instance'); // the watch path, not Halt.halt()
    await vi.waitFor(() => expect(left).toEqual(['cleared']));
    await expect(t.app.services.voice.join('1565999999999999555', GUILD)).rejects.toThrow(/halted/i);
    await t.app.stop();
    const t2 = await boot(db.pool, {}); // the halted row survives the restart
    app = t2.app;
    await expect(t2.app.services.voice.join('1565999999999999555', GUILD)).rejects.toThrow(/halted/i);
  });
});
