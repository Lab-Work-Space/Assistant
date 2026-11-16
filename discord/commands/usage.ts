import { QUOTA_TITLE, quotaLines } from '../../governance/quota/quota.js';
import { configReply, ephemeral, type Handler } from './types.js';

const isoDay = (d: Date) => d.toISOString().slice(0, 10);
const usd = (n: number) => `$${n.toFixed(4)}`;

const tzOf = (deps: Parameters<Handler>[1]): string => {
  try {
    return deps.cfg.get('schedule.timezone');
  } catch {
    return 'UTC';
  }
};
const nowMs = (deps: Parameters<Handler>[1]): number => (deps.now ?? (() => new Date()))().getTime();
const num = (n: number): string => n.toLocaleString('en-US');
const FIELD_MAX = 1000;

export const usageCmd: Handler = async (i, deps) => {
  // SPEND-1: the trend view (a Bot Admin configReply like every /usage answer, Gate 1 S16). Its clock is schedule.timezone; today|week below stay UTC days.
  if (i.options.string('range') === 'trend') {
    if (!deps.spend) return ephemeral('The spend trend is not available in this process.');
    const by = i.options.string('by');
    const r = await deps.spend.report(by === 'provider' || by === 'tool' ? by : 'dept');
    return configReply('Spend trend', r.body, { fields: r.fields });
  }
  if (i.options.string('range') === 'quota') {
    if (!deps.quota) return ephemeral('The Claude quota is not available in this process.');
    const lines = quotaLines(deps.quota.latest(), tzOf(deps), nowMs(deps));
    try {
      const backup = await deps.fallback?.line(); // R8: a failing line never fails the answer
      if (backup) lines.push(backup);
    } catch {
      deps.log.error({ stage: 'usage.backup' }, 'usage: backup line failed');
    }
    return configReply(QUOTA_TITLE, lines.join('\n'));
  }
  const span = i.options.string('range') === 'week' ? 7 : 1;
  const now = (deps.now ?? (() => new Date()))();
  const totals = new Map<string, { spent: number; reserved: number }>();
  let localCalls = 0;
  for (let n = 0; n < span; n++) {
    for (const r of await deps.budget.usage(isoDay(new Date(now.getTime() - n * 86_400_000)))) {
      if (r.scope === 'task') continue;
      if (r.scope === 'local') {
        localCalls += Number(r.calls ?? 0);
        continue;
      }
      const k = r.scope === 'company' ? 'company' : `${r.scope}: ${r.scopeId}`;
      const t = totals.get(k) ?? { spent: 0, reserved: 0 };
      t.spent += Number(r.spentUsd);
      t.reserved += Number(r.reservedUsd);
      totals.set(k, t);
    }
  }
  const head: { name: string; value: string }[] = [];
  if (deps.quota) head.push({ name: QUOTA_TITLE, value: quotaLines(deps.quota.latest(), tzOf(deps), nowMs(deps)).join('\n').slice(0, 1024) });
  const tail: { name: string; value: string }[] = [];
  if (localCalls) tail.push({ name: 'local calls (claude-code-local)', value: String(localCalls) });
  if (deps.llmUsage) {
    // USAGE-1: model calls and tokens per actor (UTC days, like the cost rows above).
    const since = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - (span - 1)));
    let rows: Awaited<ReturnType<NonNullable<typeof deps.llmUsage>['byActor']>> = [];
    try {
      rows = await deps.llmUsage.byActor(since);
    } catch {
      deps.log.error({ stage: 'usage.llm' }, 'usage: model call totals failed');
    }
    const lines = rows.map((r) => `${r.actor.replace(/[^A-Za-z0-9._:@/-]/g, '').slice(0, 64)}: ${num(r.calls)} calls, ${num(r.tokensIn)} in / ${num(r.tokensOut)} out tokens, ${usd(r.costUsd)}`);
    for (let n = 0; lines.length && n < 3; n++) {
      let chunk = '';
      while (lines.length && chunk.length + lines[0]!.length + 1 <= FIELD_MAX) chunk += `${chunk ? '\n' : ''}${lines.shift()}`;
      if (!chunk) chunk = lines.shift()!.slice(0, FIELD_MAX);
      tail.push({ name: n === 0 ? 'Model calls and tokens per bot' : 'Model calls and tokens per bot (cont.)', value: chunk });
    }
  }
  const fields = [
    ...head,
    ...[...totals].slice(0, 25 - head.length - tail.length).map(([name, t]) => ({ name, value: `${usd(t.spent)} spent, ${usd(t.reserved)} reserved` })),
    ...tail,
  ];
  return configReply(span === 1 ? 'Usage today (UTC)' : 'Usage last 7 days (UTC)', fields.length ? 'Cost per scope.' : 'No usage recorded.', { fields });
};
