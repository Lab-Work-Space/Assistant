import type { IpcRequest } from './ipc.js';
import type { ExecutorService } from './service.js';

/** Maps the validated IPC requests to the executor service. Errors become `{ ok: false }` answers; nothing here trusts the caller beyond naming a card id. */
export function ipcHandler(svc: ExecutorService, userId: () => string | undefined) {
  return async (req: IpcRequest): Promise<unknown> => {
    switch (req.op) {
      case 'status': return { ok: true, ready: (await svc.status()).ready, userId: userId() ?? null };
      case 'propose': return svc.propose(req.family, req.ops, { userId: req.userId, namedIds: req.namedIds });
      case 'apply': return { ok: true, result: await svc.apply(req.cardId) };
      case 'read': return svc.read(req.kind, { roleId: req.roleId, joinedAfter: req.joinedAfter });
      case 'deploy_read': return svc.deployRead(req.userId, req.read);
      case 'code_rollback': return svc.codeRollback(req.userId);
      case 'check_tiers': {
        const problem = await svc.checkTierConfig({ managerId: req.managerId, moderatorId: req.moderatorId, modRoomId: req.modRoomId });
        return problem ? { ok: false, error: problem } : { ok: true };
      }
      case 'check_welcome': {
        const problem = await svc.checkWelcome(req.roleIds, req.channelId);
        return problem ? { ok: false, error: problem } : { ok: true };
      }
    }
  };
}
