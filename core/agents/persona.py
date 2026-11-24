"""Persona loader (spec 5.2). Frontmatter YAML via safe_load; one bad persona is refused, collisions abort."""
import logging
import re
import unicodedata
from pathlib import Path

import yaml

from core.interfaces import Persona

log = logging.getLogger(__name__)

_ID = re.compile(r"^[a-z][a-z0-9_-]{1,31}$")
_MODEL = re.compile(r"^(anthropic|google|gemini)/[A-Za-z0-9._-]{1,64}$")
_TOOL = re.compile(r"^(\*|[a-z][a-z0-9_]{0,62}(_\*)?)$")
_FRAG = re.compile(r"^[a-z][a-z0-9-]{0,31}$")
_COLOR = re.compile(r"^#[0-9A-Fa-f]{6}$")
_ZW = re.compile("[​-‍﻿]")


class PersonaError(Exception):
    """Startup must abort (missing default agent, alias/id collision)."""


def normalise(s: str) -> str:
    return " ".join(_ZW.sub("", unicodedata.normalize("NFC", s)).casefold().split())


def _str_list(v, lo: int, hi: int, item_ok) -> tuple[str, ...]:
    if not isinstance(v, list) or not lo <= len(v) <= hi or not all(isinstance(x, str) and item_ok(x) for x in v):
        raise ValueError("list")
    return tuple(v)


def _parse(path: Path, root: Path, default_cheap: str, known_tools: set[str] | None) -> Persona:
    text = path.read_text(encoding="utf-8")
    m = re.match(r"\A---\r?\n(.*?)\r?\n---\r?\n?(.*)\Z", text, re.S)
    if not m:
        raise ValueError("frontmatter")
    fm = yaml.safe_load(m.group(1))
    if not isinstance(fm, dict):
        raise ValueError("frontmatter")

    def get(k, pred, required=True, default=None):
        v = fm.get(k)
        if v is None and not required:
            return default
        if not isinstance(v, str) or not pred(v):
            raise ValueError(k)
        return v

    pid = get("id", lambda v: _ID.fullmatch(v) and v != "system")  # "system" is the reserved agent:system actor (T031-06)
    name = get("name", lambda v: 1 <= len(v) <= 80 and not re.search("discord|clyde", v, re.I))
    aliases = _str_list(fm.get("aliases"), 1, 10, lambda x: 2 <= len(x) <= 32)
    role = get("role", lambda v: 1 <= len(v) <= 300)
    dept = get("dept", lambda v: _ID.fullmatch(v) and v != "system")
    model = get("model", lambda v: _MODEL.fullmatch(v))
    cheap = get("cheap_model", lambda v: _MODEL.fullmatch(v), False, default_cheap)
    effort = get("effort", lambda v: v in ("low", "medium", "high"))
    tools = _str_list(fm.get("tools"), 0, 10**6, lambda x: _TOOL.fullmatch(x))
    traits = _str_list(fm.get("traits"), 0, 10**6, lambda x: True)
    color = get("color", lambda v: _COLOR.fullmatch(v))
    avatar = get("avatar", lambda v: v.startswith("https://") and len(v) <= 512, False)
    frags = _str_list(fm.get("fragments"), 0, 10**6, lambda x: _FRAG.fullmatch(x))
    for f in frags:
        if not (root / "_fragments" / f"{f}.md").is_file():
            raise ValueError(f"fragment:{f}")
    if known_tools is not None:
        for t in tools:
            if not t.endswith("*") and t not in known_tools:
                log.warning("persona.unknown_tool id=%s tool=%s", pid, t)
    return Persona(id=pid, name=name, aliases=aliases, role=role, dept=dept, model=model, cheap_model=cheap,
                   effort=effort, tools=tools, traits=traits, color=int(color[1:], 16), avatar_url=avatar,
                   fragments=frags, body=m.group(2), path=str(path))


class FilePersonaRegistry:
    """Implements interfaces.PersonaRegistry."""

    def __init__(self, personas: list[Persona]):
        self._by_id = {p.id: p for p in personas}
        self._by_name = {normalise(p.name): p for p in personas}

    def get(self, agent_id: str) -> Persona | None:
        return self._by_id.get(agent_id)

    def all(self) -> list[Persona]:
        return list(self._by_id.values())

    def by_name(self, display_name: str) -> Persona | None:
        return self._by_name.get(normalise(display_name))

    @classmethod
    def load(cls, prompts_dir, default_agent_id: str, default_cheap_model: str,
             known_tools: set[str] | None = None) -> "FilePersonaRegistry":
        root = Path(prompts_dir)
        good: list[Persona] = []
        for path in sorted(root.glob("*/*.md")):
            if path.parent.name.startswith("_") or path.name.startswith("_") or not path.is_file():
                continue
            try:
                good.append(_parse(path, root, default_cheap_model, known_tools))
            except Exception as e:  # any rule failure refuses that persona only; message is a field name, not content
                log.error("persona.refused path=%s reason=%s", path, e if isinstance(e, ValueError) else type(e).__name__)
        ids: set[str] = set()
        seen: dict[str, str] = {}
        for p in good:
            if p.id in ids:
                raise PersonaError(f"duplicate_id:{p.id}")
            ids.add(p.id)
            for n in {normalise(p.name), *map(normalise, p.aliases)}:
                if seen.setdefault(n, p.id) != p.id:
                    raise PersonaError(f"alias_collision:{n}")
        if default_agent_id not in ids:
            raise PersonaError(f"default_agent_missing:{default_agent_id}")
        return cls(good)
