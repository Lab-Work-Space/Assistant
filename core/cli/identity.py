"""CLI identity and dev-gate checks (spec 10.7.5, 10.7.6, 10.15)."""
import re

from core.config import PROJECT_ROOT, cli_dev_allowed
from core.interfaces import CLI_HUMAN_IDS, Actor

_FLAG = re.compile(r"^\s*(export\s+)?EMP_CLI_DEV\s*=")


class Refusal(Exception):
    pass


def dotenv_guard(root=PROJECT_ROOT) -> None:
    p = root / ".env.local"
    if p.is_file() and any(_FLAG.match(ln) for ln in p.read_text().splitlines()):
        raise Refusal("cli_flag_in_env_file")


def require_dev(config) -> None:
    if not cli_dev_allowed(config):
        raise Refusal("cli_dev_disabled")


def actor_for(name: str) -> Actor:
    if name not in CLI_HUMAN_IDS:
        raise ValueError("invalid_identity")
    return Actor("cli", name)
