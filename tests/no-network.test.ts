import net from 'node:net';
import { describe, expect, it } from 'vitest';

describe('no-network', () => {
  it('fetch and net.connect throw in unit tests (setup file active)', async () => {
    await expect(fetch('https://example.com/')).rejects.toThrow(/no-network/);
    await expect(fetch('http://127.0.0.1:9/')).rejects.toThrow(/no-network/);
    expect(() => net.connect({ host: '127.0.0.1', port: 9 })).toThrow(/no-network/);
    expect(() => net.connect({ host: 'example.com', port: 443 })).toThrow(/no-network/);
  });
});
