import { describe, expect, it } from 'vitest';
import { createKnowledgePanel } from './dashboard.js';

const KEY = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789';
const view = { proposal: { id: 1 } as never, title: `t ${KEY}`, facts: [KEY], diff: KEY, text: KEY, sources: [{ label: 'n', tainted: true, text: KEY }], warnings: [] };

describe('knowledge panel (K18)', () => {
  it('masks secret-shaped text in everything the page lists, and audits the review step without text', async () => {
    const audits: unknown[] = [];
    const panel = createKnowledgePanel({
      service: { view: async () => view } as never,
      proposals: { list: async () => [{ id: 1 }], recent: async () => [], markReviewed: async () => true, finish: async () => true } as never,
      kb: { listAll: async () => [{ id: 1, title: KEY, body: KEY }], versions: async () => [{ title: KEY, body: KEY }] } as never,
      notes: { listAll: async () => [{ id: 1, body: KEY }] } as never,
      lessons: { list: async () => [{ id: 1, text: KEY }] } as never,
      overrides: { refs: async () => [{ ref: 'heads/hq' }], history: async () => [{ body: KEY }] } as never,
      audit: async (e) => void audits.push(e),
    });
    const o = await panel.overview();
    expect(JSON.stringify(o)).not.toContain(KEY);
    expect(await panel.review('900000000000000001', 1)).toBe(true);
    expect(await panel.reject('900000000000000001', 1)).toBe(true);
    expect(JSON.stringify(audits)).toContain('knowledge.review');
    expect(JSON.stringify(audits)).not.toContain(KEY);
  });
});
