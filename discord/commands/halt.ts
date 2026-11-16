import { configReply, type Handler } from './types.js';

export const haltCmd: Handler = async (i, deps) => {
  const n = await deps.halt.halt(i.userId);
  await deps.audit({ actor: `user:${i.userId}`, action: 'halt', outcome: 'ok' });
  return configReply('Halted', `All agent work stopped (${n} in-flight run${n === 1 ? '' : 's'} aborted). Use /resume to continue.`);
};

export const resumeCmd: Handler = async (i, deps) => {
  await deps.halt.resume(i.userId);
  const released = await deps.approvals.resumeApproved();
  await deps.audit({ actor: `user:${i.userId}`, action: 'resume', outcome: 'ok' });
  return configReply('Resumed', `Agents running again. ${released} approved task${released === 1 ? '' : 's'} released.`);
};
