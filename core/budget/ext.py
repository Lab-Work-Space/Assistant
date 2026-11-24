"""Extension entry (REQUIRED, spec 10.0): replaces the Noop guard. 018B attaches a notifier via ctx.budget.notifier."""
from core.budget.guard import Guard
from core.interfaces import AppContext


def init(ctx: AppContext) -> None:
    ctx.budget = Guard(ctx)
