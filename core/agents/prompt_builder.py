"""System prompt assembly (spec 3.2 step 3). Never reads env values; refuses if anything in it would be masked."""
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

from core.config import PROJECT_ROOT
from core.functions.logs.masking import mask_secrets
from core.interfaces import AgentRequest, Persona


class PromptError(Exception):
    """code: prompt_contains_secret | fragment_missing"""

    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


def channel_kind(req: AgentRequest) -> str:
    return "cli" if req.origin == "cli" else "dm" if req.guild_id is None else "thread" if req.thread_id else "channel"


def build_system(persona: Persona, roster: list[Persona], config, req: AgentRequest, now: datetime | None = None) -> str:
    root = Path(config.prompts_dir)
    root = root if root.is_absolute() else PROJECT_ROOT / root
    parts = [(root / "_system" / "wrapper.md").read_text(encoding="utf-8"), persona.body]
    for f in persona.fragments:
        p = root / "_fragments" / f"{f}.md"
        if not p.is_file():
            raise PromptError("fragment_missing")
        parts.append(p.read_text(encoding="utf-8"))
    now = now or datetime.now(ZoneInfo(config.app_timezone))
    lines = [f"{p.id} | {p.name} | {p.dept} | {p.role}" for p in roster]
    parts.append("## Runtime\nAgents (id | name | dept | role):\n" + "\n".join(lines)
                 + f"\nNow: {now.strftime('%Y-%m-%d %H:%M')} {config.app_timezone}\nChannel: {channel_kind(req)}")
    if req.system_extra:
        parts.append(req.system_extra)
    text = "\n\n".join(parts)
    if mask_secrets(text) != text:
        raise PromptError("prompt_contains_secret")
    return text
