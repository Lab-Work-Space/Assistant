import { describe, expect, it } from 'vitest';
import { createStreamParser } from './protocol.js';
import { eventRejected, isQuotaRejection, parseRateLimitEvent, type QuotaSnapshot } from './quota.js';
import { quotaHoldUntil } from '../../governance/quota/quota.js';

const SAMPLE = { type: 'rate_limit_event', rate_limit_info: { status: 'allowed_warning', resetsAt: 1794614400, rateLimitType: 'seven_day', utilization: 0.91, overageStatus: 'rejected', surpassedThreshold: 0.75, unifiedWindows: { five_hour: { utilization: 0.22, resetsAt: 1794307800, status: 'allowed' }, seven_day: { utilization: 0.91, resetsAt: 1794614400, status: 'allowed_warning', surpassedThreshold: 0.75 } }, overageEnabled: false }, uuid: 'SECRET-UUID', session_id: 'SECRET-SESSION' };

describe('USAGE-1 parseRateLimitEvent', () => {
  it('accepts the captured sample and keeps only the allowed fields', () => {
    const q = parseRateLimitEvent(SAMPLE);
    expect(q).toEqual({ status: 'allowed_warning', rateLimitType: 'seven_day', windows: { five_hour: { utilization: 0.22, resetsAt: 1794307800, status: 'allowed' }, seven_day: { utilization: 0.91, resetsAt: 1794614400, status: 'allowed_warning' } } });
    expect(JSON.stringify(q)).not.toMatch(/SECRET|uuid|session|overage|surpassed/);
  });
  it('maps an unknown status to unknown and drops a window with a bad utilization or reset', () => {
    const q = parseRateLimitEvent({ rate_limit_info: { status: 'weird', rateLimitType: 'overage', unifiedWindows: { five_hour: { utilization: 0.5, resetsAt: 1794307800, status: 'nope' }, seven_day: { utilization: 9, resetsAt: 1794307800, status: 'allowed' }, seven_day_opus: { utilization: 0.1, resetsAt: -1, status: 'allowed' }, seven_day_sonnet: 'x' } } });
    expect(q).toEqual({ status: 'unknown', rateLimitType: 'unknown', windows: { five_hour: { utilization: 0.5, resetsAt: 1794307800, status: 'unknown' } } });
  });
  it('falls back to the top-level utilization for the named window when unifiedWindows lacks it', () => {
    expect(parseRateLimitEvent({ rate_limit_info: { status: 'allowed', rateLimitType: 'five_hour', resetsAt: 1794307800, utilization: 0.3 } })?.windows).toEqual({ five_hour: { utilization: 0.3, resetsAt: 1794307800, status: 'allowed' } });
  });
  it.each([null, 'x', 7, {}, { rate_limit_info: null }, { rate_limit_info: [] }, { rate_limit_info: { status: 'allowed' } }, { rate_limit_info: { unifiedWindows: 5 } }])('ignores a malformed event %#', (e) => {
    expect(parseRateLimitEvent(e)).toBeNull();
  });
});

describe('USAGE-1 stream parser', () => {
  const result = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: '', structured_output: { blocks: [{ type: 'text', text: 'hi' }], stop: 'end' }, usage: { input_tokens: 1, output_tokens: 1 } });
  it('publishes the snapshot, ignores garbage and a throwing callback, and does not disturb the result path', () => {
    const got: QuotaSnapshot[] = [];
    const p = createStreamParser(new Set(), undefined, (s) => { got.push(s); throw new Error('boom'); });
    p.feed(JSON.stringify(SAMPLE));
    p.feed(JSON.stringify({ type: 'rate_limit_event', rate_limit_info: 'bad' }));
    p.feed(result);
    expect(got).toHaveLength(1);
    expect(got[0]!.windows.seven_day?.utilization).toBe(0.91);
    expect(p.hasResult()).toBe(true);
  });
  it('without a callback the event is ignored', () => {
    const p = createStreamParser(new Set());
    p.feed(JSON.stringify(SAMPLE));
    expect(p.hasResult()).toBe(false);
  });
});

/** OPS-HOLD: a rejection is classified from the structured rate_limit_event (status 'rejected'), never from the CLI's error text. */
const rejectedEvent = (type = 'five_hour') => ({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', rateLimitType: type, resetsAt: 1794307800, utilization: 1, unifiedWindows: { [type]: { utilization: 1, resetsAt: 1794307800, status: 'rejected' } } } });
const errResult = { type: 'result', subtype: 'success', is_error: true, result: 'You have hit your limit', usage: {} };
const feedAll = (p: ReturnType<typeof createStreamParser>, evs: object[]) => { for (const e of evs) p.feed(JSON.stringify(e)); };
describe('OPS-HOLD quota rejection classification', () => {
  it('a rejected event plus an error result is a quota rejection (not retryable), with or without an onQuota callback', () => {
    for (const cb of [undefined, () => {}]) {
      const p = createStreamParser(new Set(['respond']), undefined, cb);
      feedAll(p, [rejectedEvent(), errResult]);
      let err: unknown;
      try { p.finish(); } catch (e) { err = e; }
      expect(isQuotaRejection(err)).toBe(true);
      expect((err as { retryable: boolean }).retryable).toBe(false);
      expect(String((err as Error).message)).not.toMatch(/hit your limit/);
    }
    const p = createStreamParser(new Set(['respond']));
    feedAll(p, [rejectedEvent(), errResult]);
    expect(p.rejected()).toBe(true);
  });
  it('an error result without a rejected event stays a plain error; a rejected event with a good result is not an error', () => {
    const p = createStreamParser(new Set(['respond']));
    feedAll(p, [{ ...SAMPLE }, errResult]);
    expect(p.rejected()).toBe(false);
    expect(() => p.finish()).toThrow(/CLI reported an error/);
    expect(isQuotaRejection(new Error('x'))).toBe(false);
    const ok = createStreamParser(new Set(['respond']));
    feedAll(ok, [rejectedEvent(), { type: 'result', subtype: 'success', is_error: false, structured_output: { text: 'hi' }, usage: {} }]);
    expect(() => ok.finish()).not.toThrow();
  });
  it('an unusable rejected event (no windows) is not a quota rejection: no snapshot, so no hold would follow', () => {
    const p = createStreamParser(new Set(['respond']));
    feedAll(p, [{ type: 'rate_limit_event', rate_limit_info: { status: 'rejected' } }]);
    expect(p.rejected()).toBe(false);
  });
  it('R1-01: classify and hold share one rule: only a per-model window rejected is NOT a quota rejection; five_hour, seven_day or a top-level rejection is', () => {
    const only = (type: string) => ({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', rateLimitType: type, resetsAt: 1794307800, utilization: 1, unifiedWindows: { [type]: { utilization: 1, resetsAt: 1794307800, status: 'rejected' } } } });
    for (const type of ['seven_day_opus', 'seven_day_sonnet']) {
      const p = createStreamParser(new Set(['respond']));
      feedAll(p, [only(type), errResult]);
      expect(p.rejected()).toBe(false);
      expect(() => p.finish()).toThrow(/CLI reported an error/);
      const e = only(type);
      expect(eventRejected(e, parseRateLimitEvent(e))).toBe(false);
      expect(quotaHoldUntil({ snapshot: parseRateLimitEvent(e)!, observedAt: new Date(1794300000000) }, 1794300000000)).toBeNull();
    }
    for (const type of ['five_hour', 'seven_day']) {
      const e = only(type);
      expect(eventRejected(e, parseRateLimitEvent(e))).toBe(true);
      expect(quotaHoldUntil({ snapshot: parseRateLimitEvent(e)!, observedAt: new Date(1794300000000) }, 1794300000000)).not.toBeNull();
    }
    const top = { type: 'rate_limit_event', rate_limit_info: { status: 'rejected', rateLimitType: 'seven_day_opus', resetsAt: 1794307800, utilization: 1, unifiedWindows: { seven_day_opus: { utilization: 1, resetsAt: 1794307800, status: 'rejected' } } } };
    expect(eventRejected(top, parseRateLimitEvent(top))).toBe(true);
    expect(quotaHoldUntil({ snapshot: parseRateLimitEvent(top)!, observedAt: new Date(1794300000000) }, 1794300000000)).not.toBeNull();
  });
});
