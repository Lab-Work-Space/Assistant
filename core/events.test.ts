import { describe, expect, it, vi } from 'vitest';
import { EventBus, type AppEvents } from './events.js';

type E = { ping: number };
const quiet = { error: vi.fn() };

describe('EventBus', () => {
  it('emit awaits all handlers', async () => {
    const bus = new EventBus<E>(quiet);
    const done: number[] = [];
    bus.on('ping', async (n) => {
      await new Promise((r) => setTimeout(r, 20));
      done.push(n);
    });
    bus.on('ping', async (n) => {
      await new Promise((r) => setTimeout(r, 5));
      done.push(n + 1);
    });
    await bus.emit('ping', 1);
    expect(done.sort()).toEqual([1, 2]);
  });

  it('a throwing handler does not prevent others', async () => {
    const logger = { error: vi.fn() };
    const bus = new EventBus<E>(logger);
    const seen = vi.fn();
    bus.on('ping', () => {
      throw new Error('boom');
    });
    bus.on('ping', async () => {
      throw new Error('async boom');
    });
    bus.on('ping', seen);
    await expect(bus.emit('ping', 3)).resolves.toBeUndefined();
    expect(seen).toHaveBeenCalledWith(3);
    expect(logger.error).toHaveBeenCalledTimes(2);
  });

  it('unsubscribe stops delivery', async () => {
    const bus = new EventBus<E>(quiet);
    const fn = vi.fn();
    const off = bus.on('ping', fn);
    await bus.emit('ping', 1);
    off();
    await bus.emit('ping', 2);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('rejects unknown event names at compile time', () => {
    const bus = new EventBus<AppEvents>(quiet);
    // @ts-expect-error typo'd event name must not compile
    void bus.emit('typo.name', 1);
    // @ts-expect-error typo'd event name must not compile
    bus.on('task.creatd', () => {});
    bus.on('task.created', () => {});
  });
});
