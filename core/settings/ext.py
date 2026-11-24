"""Extension entry: builds ctx.settings. Loaded before core.approvals.ext."""
from core.settings.service import SettingsService


def init(ctx) -> None:
    ctx.settings = SettingsService(ctx.db, ctx.config, ctx.log, ctx.personas)
