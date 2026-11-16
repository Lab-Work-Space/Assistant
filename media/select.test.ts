import { describe, expect, it } from 'vitest';
import type { MediaBackend } from './backend.js';
import { selectMediaBackend } from './select.js';

const fake = (name: string): MediaBackend & { name: string } => ({
  name,
  health: async () => ({ check: { ok: true } }),
  startTrack: () => {
    throw new Error('unused');
  },
  decode: async () => Buffer.alloc(0),
});

/** Records which factory ran (and with which socket path); a factory that is not chosen must never be called. */
const rig = () => {
  const calls: string[] = [];
  return {
    calls,
    local: () => {
      calls.push('local');
      return fake('local');
    },
    socket: (p: string) => {
      calls.push(`socket:${p}`);
      return fake('socket');
    },
  };
};
const SOCK = '/run/media-ipc/media.sock';
const container = () => 'running in a container';
const noContainer = () => null;

describe('selectMediaBackend', () => {
  it('selectMediaBackend › container + socket → socket backend', () => {
    const r = rig();
    const out = selectMediaBackend({ mediaSocket: SOCK, inContainer: container, local: r.local, socket: r.socket });
    expect('backend' in out && (out.backend as ReturnType<typeof fake>).name).toBe('socket');
    expect(r.calls).toEqual([`socket:${SOCK}`]);
  });

  it('selectMediaBackend › container + no socket → disabled "media sidecar not configured"', () => {
    const r = rig();
    expect(selectMediaBackend({ inContainer: container, local: r.local, socket: r.socket })).toEqual({ disabled: 'media sidecar not configured' });
    expect(r.calls).toEqual([]); // fail closed: no local fallback is even built
  });

  it('selectMediaBackend › no container + socket → socket backend', () => {
    const r = rig();
    const out = selectMediaBackend({ mediaSocket: SOCK, inContainer: noContainer, local: r.local, socket: r.socket });
    expect('backend' in out && (out.backend as ReturnType<typeof fake>).name).toBe('socket');
    expect(r.calls).toEqual([`socket:${SOCK}`]);
  });

  it('selectMediaBackend › no container + no socket → local backend', () => {
    const r = rig();
    const out = selectMediaBackend({ inContainer: noContainer, local: r.local, socket: r.socket });
    expect('backend' in out && (out.backend as ReturnType<typeof fake>).name).toBe('local');
    expect(r.calls).toEqual(['local']);
  });
});
