import { describe, expect, it } from 'vitest';
import { alertApiBusy, alertTaskRefused, alertApiOff, alertBackupUnavailable, alertEngage, alertEnd, usageBackupLine, weeklyApiLine, WAITS_TEXT, SEND_AGAIN_TEXT } from './fallback-text.js';

const WHEN = '<t:1700000000:R> (2026-11-16 12:00 Asia/Bangkok)';

describe('R8 alert text builders (A1-A4)', () => {
  it('A1 engage states the cap and the reset, excluding Praw', () => {
    expect(alertEngage({ label: '5-hour', capUsd: 50, when: WHEN })).toBe(`The 5-hour Claude quota is used up. Bots except Praw continue on the Claude API (metered; company cap $50.00/day) until ${WHEN}.`);
  });
  it('A1 variant when the backup cannot run (no key)', () => {
    expect(alertBackupUnavailable({ label: 'Weekly', when: WHEN })).toBe(`The Weekly Claude quota is used up. The Claude API backup is unavailable: no API key. The bots will idle until ${WHEN}.`);
  });
  it('A2 end carries the API spend only when the backup ran', () => {
    expect(alertEnd(null)).toBe('The Claude quota hold is over. Bots are back on the subscription.');
    expect(alertEnd({ usd: 1.234567, calls: 7 })).toBe('The Claude quota hold is over. Bots are back on the subscription. Claude API spend today: $1.23 (7 calls).');
    expect(alertEnd({ usd: 0.5, calls: 1 })).toContain('(1 call)');
  });
  it('A3 and A4 carry a status number only', () => {
    expect(alertApiOff({ status: 401, when: WHEN })).toBe(`The Claude API backup was refused (HTTP 401). Claude-backed bots now wait until ${WHEN}.`);
    expect(alertApiBusy({ status: 529 })).toBe('The Claude API is busy (HTTP 529). Backup work pauses 5 minutes.');
  });
  it('a per-task refusal says only that task waits', () => {
    expect(alertTaskRefused({ status: 400 })).toBe('The Claude API refused one task\'s request (HTTP 400). That task waits until the hold ends; other work continues on the backup.');
    expect(alertTaskRefused({ status: 'CANARY' as never })).not.toContain('CANARY');
  });
  it('a non-numeric status or number is never echoed (G9, builders)', () => {
    const canary = 'CANARY-SECRET-sk-ant-xyz';
    const texts = [
      alertApiOff({ status: canary as never, when: WHEN }), alertApiBusy({ status: canary as never }),
      alertEngage({ label: '5-hour', capUsd: canary as never, when: WHEN }), alertEnd({ usd: canary as never, calls: canary as never }),
      usageBackupLine({ enabled: true, route: 'Claude API', usd: canary as never, capUsd: canary as never }), weeklyApiLine({ usd: canary as never, calls: canary as never }),
    ];
    for (const t of texts) expect(t).not.toContain('CANARY');
  });
  it('the usage and weekly lines are fixed-format numbers and enums', () => {
    expect(usageBackupLine({ enabled: true, route: 'subscription', usd: 0, capUsd: 50 })).toBe('Backup: on · route: subscription · Claude API today $0.00 / company cap $50.00');
    expect(usageBackupLine({ enabled: false, route: 'held', usd: 2.5, capUsd: 50 })).toBe('Backup: off · route: held · Claude API today $2.50 / company cap $50.00');
    expect(weeklyApiLine({ usd: 12.3456, calls: 40 })).toBe('Claude API (metered) last week: $12.35, 40 calls');
  });
  it('fixed waits and send-again texts', () => {
    expect(WAITS_TEXT).toBe('The Claude subscription quota is used up. This work waits and resumes by itself after the quota resets.');
    expect(SEND_AGAIN_TEXT).toBe('The subscription quota just ran out. Send your message again to get a reply on the backup route.');
  });
});
