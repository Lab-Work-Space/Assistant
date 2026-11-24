import logging

from core.approvals.router import make_classifier
from core.approvals.service import PgApprovalService, make_generic_handler

log = logging.getLogger(__name__)


def _lesson_aware(ctx, generic):
    """R3: lesson cards go to ctx.growth (resolved at call time); everything else to the generic handler."""
    async def handler(row):
        if (row["payload"] or {}).get("lesson"):
            g = getattr(ctx, "growth", None)
            if g is not None:
                await g.lessons.on_decision(row)
            return
        await generic(row)
    return handler


def init(ctx) -> None:
    svc = PgApprovalService(ctx.db, ctx.config, ctx.log, ctx.approver_policy, personas=ctx.personas,
                            settings=ctx.settings, classify=make_classifier(ctx), engine=ctx.engine)
    svc.sinks_fn = lambda: ctx.sinks
    svc.register_handler("generic", _lesson_aware(ctx, make_generic_handler(ctx)))
    ctx.approvals = svc  # 013B/025 call ctx.approvals.set_presenter(...)
    try:
        svc.start()
    except RuntimeError:
        log.warning("approvals.sweeper_not_started: no running loop; caller must call ctx.approvals.start()")
