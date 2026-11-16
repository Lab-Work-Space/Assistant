import Anthropic from '@anthropic-ai/sdk';
import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { callProvider, type CallDeps } from '../agents/call/call.js';
import { IncidentReporter } from '../core/incidents.js';
import { createLogger } from '../core/logger.js';
import { createClaudeProvider } from './claude/index.js';
import { FallbackGate, markFromError } from './fallback-gate.js';
import { alertApiBusy, alertApiOff } from './fallback-text.js';
import type { ChatRequest } from './types.js';

/** G9 (PV-C10, rule 19): a canary planted in the vendor error message must not appear in the REAL emitted log stream, the incident text, the audit rows or the alert bodies. */
const CANARY = 'ZZCANARY quoted-prompt-words please-do-not-leak';
const req: ChatRequest = { model: 'claude-sonnet-5-5', system: 's', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], tools: [], maxTokens: 10 };

async function run(status: number) {
  const err = new Anthropic.APIError(status, { type: 'error', error: { type: 'invalid_request_error', message: CANARY } }, CANARY, new Headers());
  const stub = { messages: { stream: () => { throw err; } }, beta: { messages: { stream: () => { throw err; } } } };
  const provider = createClaudeProvider('sk-test-fake', { client: stub as never });
  const lines: string[] = [];
  const stream = new Writable({ write(chunk, _e, cb) { lines.push(String(chunk)); cb(); } });
  const log = createLogger('debug', { destination: stream });
  const posts: { title: string; body: string }[] = [];
  const incidents = new IncidentReporter({ port: { post: async (_a, _t, p) => void posts.push({ title: p.title, body: p.body }) }, channelId: 'c', log, secrets: [] });
  const audits: unknown[] = [];
  const deps: CallDeps = {
    budget: { reserve: async () => ({ ok: true, reservationId: 'r1' }), settle: async () => undefined, release: async () => undefined, costOf: () => 0.01 } as unknown as CallDeps['budget'],
    halt: { track: () => () => undefined },
    audit: async (r: unknown) => void audits.push(r),
    log, incidents,
  } as never;
  const o = await callProvider(req, provider, { kind: 'head', dept: 'hq' }, { id: 'T1', title: 'T' } as never, deps);
  await incidents.idle();
  const alerts: string[] = [];
  const gate = new FallbackGate({ heldUntil: () => Date.now() + 1000, now: Date.now, onMark: (e) => { if (e.kind === 'api_off') alerts.push(alertApiOff({ status: e.status, when: 'later' })); if (e.kind === 'api_busy') alerts.push(alertApiBusy({ status: e.status })); } });
  const failed = o.kind === 'done' ? o.failed : undefined;
  const m = markFromError(failed);
  if (m && m.kind !== 'task_400') gate.mark(m);
  return { o, lines, posts, audits, alerts, mark: m };
}

describe('R8 G9: a planted vendor message never leaves the process', () => {
  for (const status of [400, 401, 429, 500]) {
    it(`status ${status}: not in the log stream, the incident posts, the audit rows or the alert bodies`, async () => {
      const r = await run(status);
      expect(r.o.kind).toBe('done');
      expect(r.lines.length).toBeGreaterThan(0); // the failure was really logged
      const all = JSON.stringify([r.lines, r.posts, r.audits, r.alerts]);
      expect(all).not.toContain('CANARY');
      expect(all).not.toContain('quoted-prompt-words');
      expect(r.mark).not.toBeNull();
    });
  }
});
