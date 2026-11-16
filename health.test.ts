import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { allowLoopbackForTest } from './vitest.setup.no-network.js';
import { startHealth, type HealthServer } from './health.js';

beforeAll(allowLoopbackForTest);
let server: HealthServer | null = null;
afterEach(async () => {
  await server?.close();
  server = null;
});

describe('health', () => {
  it('GET /healthz is 200 with db ok, online clients and halted', async () => {
    server = await startHealth({ port: 0, check: async () => ({ db: 'ok', clients: ['hq', 'rnd'], halted: false }) });
    expect(server.address().host).toBe('127.0.0.1');
    const r = await fetch(`${server.url()}/healthz`);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ db: 'ok', clients: ['hq', 'rnd'], halted: false });
  });

  it('reports offDay and its reason when the check gives them (no holiday name)', async () => {
    server = await startHealth({ port: 0, check: async () => ({ db: 'ok', clients: [], halted: false, offDay: true, offDayReason: 'holiday' }) });
    expect(await (await fetch(`${server.url()}/healthz`)).json()).toEqual({ db: 'ok', clients: [], halted: false, offDay: true, offDayReason: 'holiday' });
    await server.close();
    server = await startHealth({ port: 0, check: async () => ({ db: 'ok', clients: [], halted: false, offDay: false }) });
    expect(await (await fetch(`${server.url()}/healthz`)).json()).toEqual({ db: 'ok', clients: [], halted: false, offDay: false });
  });

  it('is 503 when the db check fails, and never echoes error text', async () => {
    server = await startHealth({
      port: 0,
      check: async () => {
        throw new Error('password authentication failed for postgres://u:secret@db');
      },
    });
    const r = await fetch(`${server.url()}/healthz`);
    expect(r.status).toBe(503);
    const body = await r.text();
    expect(body).not.toContain('secret');
    expect(JSON.parse(body)).toEqual({ db: 'error' });
  });

  it('is 503 when the check reports db error', async () => {
    server = await startHealth({ port: 0, check: async () => ({ db: 'error', clients: [], halted: true }) });
    expect((await fetch(`${server.url()}/healthz`)).status).toBe(503);
  });

  it('binds the configured host and defaults to loopback', async () => {
    server = await startHealth({ port: 0, host: '0.0.0.0', check: async () => ({ db: 'ok', clients: [], halted: false }) });
    expect(server.address().host).toBe('0.0.0.0');
    expect((await fetch(`http://127.0.0.1:${server.address().port}/healthz`)).status).toBe(200);
  });

  it('other paths are 404', async () => {
    server = await startHealth({ port: 0, check: async () => ({ db: 'ok', clients: [], halted: false }) });
    expect((await fetch(`${server.url()}/other`)).status).toBe(404);
  });
});

describe('health build sha (self-code X18)', () => {
  it('reports the build commit when the check gives one, and omits it otherwise', async () => {
    const sha = 'a'.repeat(40);
    server = await startHealth({ port: 0, check: async () => ({ db: 'ok', clients: ['hq'], halted: false, build: sha }) });
    expect(await (await fetch(`${server.url()}/healthz`)).json()).toEqual({ db: 'ok', clients: ['hq'], halted: false, build: sha });
  });
});
