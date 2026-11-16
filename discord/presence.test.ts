import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { HQ_OFFLINE_GRACE_MS, HqPresence } from './presence.js';

describe('HqPresence', () => {
  it('never started: paused once the grace period is over', () => {
    let t = 0;
    const p = new HqPresence(() => t);
    expect(p.paused()).toBe(false);
    t = HQ_OFFLINE_GRACE_MS + 1;
    expect(p.paused()).toBe(true);
  });

  it('disconnect pauses only after more than 60 s; ready again resumes and fires onRecover once', () => {
    let t = 0;
    const p = new HqPresence(() => t);
    const hq = new EventEmitter();
    const recovered = vi.fn();
    p.onRecover(recovered);
    p.watch(hq);
    t = 1000;
    hq.emit('shardDisconnect');
    t = 1000 + HQ_OFFLINE_GRACE_MS;
    expect(p.paused()).toBe(false);
    t += 1;
    expect(p.paused()).toBe(true);
    hq.emit('shardResume');
    expect(p.paused()).toBe(false);
    expect(recovered).toHaveBeenCalledTimes(1);
  });

  it('a short blip does not fire onRecover', () => {
    let t = 0;
    const p = new HqPresence(() => t);
    const hq = new EventEmitter();
    const recovered = vi.fn();
    p.onRecover(recovered);
    p.watch(hq);
    hq.emit('invalidated');
    t = 10;
    hq.emit('shardReady');
    expect(recovered).not.toHaveBeenCalled();
    expect(p.online()).toBe(true);
  });

  it('repeated disconnect events keep the first offline time', () => {
    let t = 0;
    const p = new HqPresence(() => t);
    const hq = new EventEmitter();
    p.watch(hq);
    hq.emit('shardDisconnect');
    t = 50_000;
    hq.emit('shardReconnecting');
    t = HQ_OFFLINE_GRACE_MS + 1;
    expect(p.paused()).toBe(true);
  });
});
