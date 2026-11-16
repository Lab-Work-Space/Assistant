import type { SecondRequest } from './confirm.js';
import type { ApplyResult, ExecutorService } from './service.js';

/** Test double of LW Admin's second confirmation: records the prompts; `click` plays the Bot Admin's click on LW Admin's own button. */
export function fakeConfirm() {
  const queue: SecondRequest[] = [];
  return {
    queue,
    confirm: { request: async (r: SecondRequest) => (queue.push(r), { ok: true as const, where: 'dm' as const, ttlMinutes: 5 }) },
    click: async (): Promise<ApplyResult> => {
      const q = queue.shift();
      if (!q) throw new Error('no second confirmation is waiting');
      const why = await q.recheck(q.userId);
      if (why) return { kind: 'refused', why };
      const out = await q.run();
      if (out.refused) return { kind: 'refused', why: out.lines[0]!.replace(/^Refused: /, '') };
      return { kind: 'done', ok: out.ok, lines: out.lines, applied: out.applied ?? (out.ok ? 1 : 0), total: out.total ?? 1 };
    },
  };
}

/** Makes `svc.apply` behave as before the second confirmation existed: an "awaiting" answer is followed by the click. */
export function autoClick(svc: ExecutorService, fc: ReturnType<typeof fakeConfirm>): void {
  const orig = svc.apply.bind(svc);
  svc.apply = async (id: string) => {
    const r = await orig(id);
    return r.kind === 'awaiting' ? fc.click() : r;
  };
}
