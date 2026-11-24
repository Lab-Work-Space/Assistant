import logging

from core.approvals.router import make_classifier
from core.approvals.service import PgApprovalService, make_generic_handler

log = logging.getLogger(__name__)


def init(ctx) -> None:
    svc = PgApprovalService(ctx.db, ctx.config, ctx.log, ctx.approver_policy, personas=ctx.personas,
                            settings=ctx.settings, classify=make_classifier(ctx), engine=ctx.engine)
    svc.sinks_fn = lambda: ctx.sinks
    svc.register_handler("generic", make_generic_handler(ctx))
    ctx.approvals = svc  # 013B/025 call ctx.approvals.set_presenter(...)
    try:
        svc.start()
    except RuntimeError:
        log.warning("approvals.sweeper_not_started: no running loop; caller must call ctx.approvals.start()")
