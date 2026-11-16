import { ephemeral, type Handler } from './types.js';

/** LEARN-1 (D4a, LL-C7): the fixed reply texts of `/retro run`. Nothing the caller typed is echoed. */
export const RETRO_TEXT = {
  halted: 'The company is halted. No retro was queued.',
  off: 'Retros are switched off (grow.retro.enabled). No retro was queued.',
  unknown: 'Unknown department.',
  failed: 'Retro request failed. Nothing was queued.',
  queued: (d: string) => `${d}: queued; it starts within a few minutes on a workday.`,
  exists: (d: string) => `${d}: a retro already ran or is queued today.`,
  skipped: (d: string) => `${d}: skipped (Praw or disabled).`,
  footer: 'A queued retro that cannot start within 24 hours is dropped.',
} as const;
const NO_RETRO = ephemeral('Retros are not available in this process.');

/**
 * `/retro run [dept]`: queue an extra retro for one department or every eligible one. Reached only through COMMAND_TABLE after `decide()` (guild, #setting, live Bot Admin
 * role). The department name is validated inside `WeeklyRetro.request` (`^[a-z_]{1,32}$` and a real department); the request is audited there with `user:<id>`.
 */
export const retroRun: Handler = async (i, deps) => {
  if (!deps.retro) return NO_RETRO;
  const raw = (i.options.string('dept') ?? '').trim();
  let r: Awaited<ReturnType<NonNullable<typeof deps.retro>['request']>>;
  try {
    r = await deps.retro.request(raw === '' ? null : raw, `user:${i.userId}`);
  } catch (err) {
    deps.log.error({ errName: err instanceof Error ? err.name : 'error' }, 'retro request failed');
    return ephemeral(RETRO_TEXT.failed);
  }
  if (r === 'halted' || r === 'off' || r === 'unknown') return ephemeral(RETRO_TEXT[r]);
  const lines = r.map((x) => (x.result === 'queued' ? RETRO_TEXT.queued(x.dept) : x.result === 'exists' ? RETRO_TEXT.exists(x.dept) : RETRO_TEXT.skipped(x.dept)));
  return ephemeral([...lines, RETRO_TEXT.footer].join('\n'));
};
