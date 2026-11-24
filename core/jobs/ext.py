import asyncio
import logging

from core.interfaces import JobKind
from core.jobs.runner import PgJobRunner

log = logging.getLogger(__name__)


def init(ctx) -> None:
    runner = PgJobRunner(ctx.db, ctx.config)
    if ctx.config.jobs_enable_selftest:
        runner.register_kind(JobKind("selftest_crash", 30))
        runner.register_kind(JobKind("selftest_sleep", 60))
    ctx.jobs = runner
    try:
        runner._start_task = asyncio.get_running_loop().create_task(runner.start())
    except RuntimeError:
        log.warning("jobs.not_started: no running loop; caller must await ctx.jobs.start()")
