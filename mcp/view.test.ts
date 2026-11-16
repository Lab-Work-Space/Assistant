import { describe, expect, it } from 'vitest';
import type { McpRow } from '../db/repos/mcp.js';
import { ToolRegistry } from '../tools/registry.js';
import { McpAdmin } from './admin.js';
import { McpHost } from './host.js';
import { StuckLatch } from './sandbox.js';
import { Slots } from './slots.js';
import { buildSnapshot } from './snapshot.js';
import { pinned } from './test-helpers.js';
import { createMcpToolFactory, type McpToolDeps } from './tool.js';

/** R6 MCP-1 BE2 (MC-C7): what `/mcp show` renders is exactly what the registry offers the model (name, description, input schema). */
const IMG = `sha256:${'c'.repeat(64)}`;
const RAW = [
  { name: 'echo', description: 'Echoes the text back.', inputSchema: { type: 'object', properties: { text: { type: 'string', maxLength: 100, description: 'what to echo' }, n: { type: 'integer', minimum: 1, maximum: 5 }, mode: { type: 'string', enum: ['a', 'b'] } }, required: ['text'] } },
  { name: 'add.numbers', description: 'Adds two numbers.', inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'] } },
];

describe('MC-C7: the admin view and specsFor agree', () => {
  for (const cls of ['read', 'write'] as const) {
    it(`${cls} class: every tool of the view deep-equals its registry spec`, async () => {
      const b = buildSnapshot(RAW, { slug: 'srv', toolClass: cls });
      const row = pinned({ id: 7, slug: 'srv', title: 't', imageId: IMG, imageRef: null, command: [], env: {}, toolClass: cls, timeoutMs: 5000, maxCallsPerDay: 50, snapshot: b.raw, snapshotSha256: b.sha256, status: 'active', source: 'admin', releaseId: null, addedBy: '1', addedAt: new Date(), approvedBy: '1', approvedAt: new Date(), quarantineReason: null, quarantinedAt: null, disabledBy: null, disabledAt: null, updatedAt: new Date(), depts: ['software'] } as never);
      const d = {
        host: { entry: () => undefined, refresh: async () => undefined }, repo: { claim: async () => 'ok', quarantine: async () => ({ ok: false }) }, sandbox: { docker: { exec: async () => ({ code: 1, stdout: '', timedOut: false, missing: false }) }, spawn: () => { throw new Error('no'); }, isHalted: () => false, latch: new StuckLatch() },
        slots: new Slots(), enabled: () => true, halted: () => false, tz: () => 'UTC', caps: () => ({ tree: 40, day: 200 }), audit: async () => undefined, secrets: () => [], notify: async () => undefined, log: { error: () => undefined },
      } as unknown as McpToolDeps;
      const host = new McpHost({ repo: { activeRows: async () => [row] }, makeTool: (s, t) => createMcpToolFactory(d)(s, t), secrets: () => [], incident: () => undefined, log: { error: () => undefined } });
      await host.load();
      const reg = new ToolRegistry({ halt: { isHalted: () => false }, external: { get: (n) => host.get(n), names: () => host.names() } });
      const admin = new McpAdmin({ repo: { get: async () => row } as never, docker: { exec: async () => { throw new Error('no'); } }, sandbox: d.sandbox, host: { refresh: async () => undefined }, halted: () => false, deptExists: () => true, audit: async () => undefined, secrets: () => [], log: { error: () => undefined } });
      const shown = await admin.show('srv');
      if (!shown.ok) throw new Error('show failed');
      expect(shown.view.tools.length).toBe(2);
      for (const t of shown.view.tools) {
        const spec = reg.specsFor([t.name])[0]!;
        expect(spec, t.name).toEqual({ name: t.name, description: t.description, inputSchema: t.schema });
      }
    });
  }
});
