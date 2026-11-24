"""Growth wiring (R29): ctx.growth = Growth(overlays, lessons, staff). Loaded after approvals, before tasks."""
from dataclasses import dataclass
from typing import Any

from core.growth.lessons import LessonService
from core.growth.overlays import OverlayService


@dataclass
class Growth:
    overlays: OverlayService
    lessons: LessonService
    staff: Any = None


def init(ctx) -> None:
    for need in ("settings", "approvals", "db"):
        if getattr(ctx, need, None) is None:
            raise RuntimeError(f"growth_requires_{need}")
    overlays = OverlayService(ctx.db, ctx.settings, ctx.log)
    staff = None
    try:  # T4 module; staff exists only with a runtime registry
        from core.growth.personas import RuntimePersonaRegistry, StaffService
        if isinstance(ctx.personas, RuntimePersonaRegistry):
            staff = StaffService(ctx)
    except ImportError:
        pass
    ctx.growth = Growth(overlays, LessonService(ctx, overlays), staff)
