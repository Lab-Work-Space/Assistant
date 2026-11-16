import { describe, expect, it, vi } from 'vitest';
import { FakeDiscordPort } from '../../../tests/fakes/discordPort.js';
import { WatchPoller } from './poller.js';
import { watchNet } from './test-helpers.js';

describe('watch poller on off days', () => {
  it('claims nothing on an off day (watches stay due) and resumes on the next workday', async () => {
    let off = true;
    const repo = { claimDue: vi.fn(async () => []), get: vi.fn(), saveSnapshot: vi.fn(), recordFailure: vi.fn(), postpone: vi.fn() };
    const p = new WatchPoller({
      repo, port: new FakeDiscordPort(), net: watchNet(), search: { search: vi.fn(async () => []) }, canRun: () => true, clock: () => 0,
      log: { warn: vi.fn(), error: vi.fn() }, offDay: () => off,
    });
    await p.tick();
    expect(repo.claimDue).not.toHaveBeenCalled();
    off = false;
    await p.tick();
    expect(repo.claimDue).toHaveBeenCalledTimes(1);
  });
});
