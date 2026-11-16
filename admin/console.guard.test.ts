import { describe, expect, it } from 'vitest';
import { ADMIN_FORBIDDEN_CMD_KEYS } from '../discord/commands/types.js';
import { AdminConsole } from './console.js';

describe('G2-RL-09: the AdminConsole refuses a CommandDeps that carries the release closures', () => {
  it('throws at construction when `cmd` has a releases key (even undefined), and builds without it', () => {
    expect(() => new AdminConsole({ cmd: { releases: { list: async () => [] } } } as never)).toThrow(/must not carry/);
    expect(() => new AdminConsole({ cmd: { releases: undefined } } as never)).toThrow(/must not carry/);
    expect(() => new AdminConsole({ cmd: {} } as never)).not.toThrow();
  });
});

describe('G2-MCP-04: the same guard covers every key of the reviewed forbidden list', () => {
  it('the list names releases, mcp and forge (PF-C13); each key throws at construction, even undefined', () => {
    expect([...ADMIN_FORBIDDEN_CMD_KEYS].sort()).toEqual(['forge', 'mcp', 'releases']);
    for (const k of ADMIN_FORBIDDEN_CMD_KEYS) {
      expect(() => new AdminConsole({ cmd: { [k]: { list: async () => [] } } } as never), k).toThrow(/must not carry/);
      expect(() => new AdminConsole({ cmd: { [k]: undefined } } as never), k).toThrow(/must not carry/);
    }
    expect(() => new AdminConsole({ cmd: { guildId: 'g' } } as never)).not.toThrow();
  });
});
