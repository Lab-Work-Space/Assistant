# Load order matters: services first, tools next, gate last.
import importlib
import logging

from core.interfaces import AppContext, require_real_budget

EXTENSIONS = [
    "core.budget.ext",
    "core.agents.ext",
    "core.jobs.ext",
    "core.settings.ext",
    "core.approvals.ext",
    "core.growth.ext",
    "core.tasks.ext",
    "core.voice.ext",
    "core.agent_tools.knowledge",
    "core.agent_tools.image",
    "core.agent_tools.task",
    "core.agent_tools.brainstorm",
    "core.agent_tools.approval",
    "core.agent_tools.pull_user",
    "core.gate.ext",
]
REQUIRED = {"core.budget.ext", "core.agents.ext"}
DISCORD_ONLY = {"core.voice.ext", "core.agent_tools.pull_user", "core.gate.ext"}


def init_core(ctx: AppContext) -> list[str]:
    """Shared wiring for Discord and CLI. Each module exposes init(ctx); Discord-only parts go in setup_discord(bot)."""
    loaded: list[str] = []
    for name in EXTENSIONS:
        if ctx.surface == "cli" and name in DISCORD_ONLY:
            continue
        try:
            mod = importlib.import_module(name)
        except ModuleNotFoundError as e:
            # skip only when the missing module is this extension or its own package (never "core", never REQUIRED)
            if name in REQUIRED or not e.name or e.name == "core" or not (name + ".").startswith(e.name + "."):
                raise
            logging.getLogger(__name__).warning("extension.missing %s", name)
            continue
        mod.init(ctx)
        loaded.append(name)
    require_real_budget(ctx)
    return loaded
