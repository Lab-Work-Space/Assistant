"""Runtime personas, staff and departments (TASK-033 R21-R28, Gate 1 G033-08..11).
Logs carry ids, codes and fixed tokens only: never name, alias, role or reason text."""
import asyncio
import dataclasses
import json
import re
import unicodedata
from pathlib import Path

import yaml

from core.agents.persona import _COLOR, _FRAG, normalise
from core.approvals.depts import DEPT_CODES, HQ_ONLY
from core.functions.logs.masking import mask_secrets
from core.growth import GrowthError
from core.interfaces import Persona
from core.settings.service import SettingsError, register_dept

HIRED_TOOLS = ("respond", "knowledge_read_index", "knowledge_read", "knowledge_search", "knowledge_write",
               "task_update", "approval_request")
RESERVED_IDS = {"system", "praw", "admin", "hq", "everyone", "here"}
RESERVED_CODES = {"HQ", "APR", "LSN", "TASK", "SYS", "ALL", "NONE"}
_ID = re.compile(r"^[a-z][a-z0-9_-]{1,31}$")
_NAME_OK = re.compile(r"^[A-Za-z0-9 .'\-ก-๛]+$")
_CODE = re.compile(r"^[A-Z]{2,4}$")
_ROLE_BAD = re.compile(r"[<>|`]")


def _nk(s: str) -> str:
    return normalise(unicodedata.normalize("NFKC", s))


def _suffix(pid: str) -> str:
    from core.discord.client import env_suffix  # lazy: keeps this module free of the Discord import chain
    return env_suffix(pid)


def _clip_free(s: str) -> str:
    return mask_secrets(s or "")[:200]


async def load_departments(db) -> None:
    for r in await db.fetch("SELECT code, slug FROM departments ORDER BY created_at, code"):
        register_dept(r["slug"], r["code"])


class RuntimePersonaRegistry:
    """Implements interfaces.PersonaRegistry; ctx.personas is never reassigned, reload() swaps the dicts."""

    def __init__(self, db, file_registry, prompts_dir, default_cheap_model: str, log):
        self.db, self.files, self.root, self.cheap, self.log = db, file_registry, Path(prompts_dir), default_cheap_model, log
        self.template_ok = False
        self._tpl: dict = {}
        self._by_id: dict[str, Persona] = {}
        self._by_name: dict[str, Persona] = {}
        self._known: set[str] = set()
        self._fired: set[str] = set()
        self._names: dict[str, str] = {}

    @classmethod
    async def load(cls, db, file_registry, prompts_dir, default_cheap_model, log) -> "RuntimePersonaRegistry":
        r = cls(db, file_registry, prompts_dir, default_cheap_model, log)
        r._load_template()
        await r.reload()
        return r

    # -- template ----------------------------------------------------------------------------------------
    def _load_template(self) -> None:
        try:
            text = (self.root / "_system" / "hired-persona.md").read_text(encoding="utf-8")
            m = re.match(r"\A---\r?\n(.*?)\r?\n---\r?\n?(.*)\Z", text, re.S)
            fm = yaml.safe_load(m.group(1))
            tools, frags, traits = fm["tools"], fm["fragments"], fm["traits"]
            ok = (fm["effort"] in ("low", "medium", "high") and _COLOR.fullmatch(fm["color"])
                  and isinstance(tools, list) and all(isinstance(t, str) and "*" not in t and t in HIRED_TOOLS for t in tools)
                  and isinstance(frags, list) and all(isinstance(f, str) and _FRAG.fullmatch(f)
                                                      and (self.root / "_fragments" / f"{f}.md").is_file() for f in frags)
                  and isinstance(traits, list) and all(isinstance(t, str) for t in traits) and m.group(2).strip())
            if not ok:
                raise ValueError("template")
            self._tpl = {"effort": fm["effort"], "tools": tuple(tools), "traits": tuple(traits),
                         "color": int(fm["color"][1:], 16), "fragments": tuple(frags), "body": m.group(2)}
            self.template_ok = True
        except Exception as e:  # any failure disables hiring only; startup continues
            self.template_ok = False
            self.log.write_log("growth", "persona.template_invalid", "ERROR", reason=type(e).__name__)

    def _build(self, row: dict) -> Persona:
        vals = {"name": row["name"], "role": row["role"], "dept": row["dept"]}
        body = re.sub(r"\{(name|role|dept)\}", lambda m: vals[m.group(1)], self._tpl["body"])  # one pass (G033-10)
        t = self._tpl
        return Persona(id=row["id"], name=row["name"], aliases=tuple(json.loads(row["aliases"])), role=row["role"],
                       dept=row["dept"], model=row["model"], cheap_model=self.cheap, effort=t["effort"], tools=t["tools"],
                       traits=t["traits"], color=t["color"], avatar_url=None, fragments=t["fragments"], body=body,
                       path=f"db:personas_runtime/{row['id']}")

    # -- reload ------------------------------------------------------------------------------------------
    async def reload(self) -> None:
        rows = await self.db.fetch("SELECT * FROM personas_runtime ORDER BY created_at, id")
        files = {p.id: p for p in self.files.all()}
        known, fired = set(files), set()
        names: dict[str, str] = {}
        for p in files.values():
            for n in (p.name, *p.aliases):
                names.setdefault(_nk(n), p.id)
        active = dict(files)
        hired: list[Persona] = []
        for r in rows:
            pid = r["id"]
            if pid in files:  # override row (a hired row with a file id is a collision: the file persona wins)
                if r["kind"] != "override":
                    self.log.write_log("growth", "persona.refused", "ERROR", id=pid, reason="id_collision")
                    continue
                if r["status"] == "fired":
                    fired.add(pid)
                    active.pop(pid, None)
                elif r["dept"]:
                    active[pid] = dataclasses.replace(files[pid], dept=r["dept"])
                continue
            if r["kind"] != "hired":
                continue
            known.add(pid)
            keys = {_nk(r["name"]), *(_nk(a) for a in json.loads(r["aliases"])), }
            if any(names.get(k, pid) != pid for k in keys):
                self.log.write_log("growth", "persona.refused", "ERROR", id=pid, reason="name_collision")
                continue
            for k in keys:
                names[k] = pid
            if r["status"] == "fired":
                fired.add(pid)
            elif self.template_ok:
                hired.append(self._build(r))
        for p in hired:
            active[p.id] = p
        self._by_id = active
        self._by_name = {normalise(p.name): p for p in active.values()}
        self._known, self._fired, self._names = known, fired, names

    # -- lookups -----------------------------------------------------------------------------------------
    def get(self, agent_id: str) -> Persona | None:
        return self._by_id.get(agent_id)

    def all(self) -> list[Persona]:
        return list(self._by_id.values())

    def by_name(self, display_name: str) -> Persona | None:
        return self._by_name.get(normalise(display_name))

    def known_ids(self) -> set[str]:
        return set(self._known)

    def is_fired(self, agent_id: str) -> bool:
        return agent_id in self._fired

    def file_models(self) -> set[str]:
        return {m for p in self.files.all() for m in (p.model, p.cheap_model)} | {self.cheap}

    def name_keys(self) -> dict[str, str]:
        """Normalised name/alias -> persona id, fired and file personas included."""
        return dict(self._names)


def resolve_dept(dept: str) -> str:
    """Slug for a slug or a code; GrowthError dept_unknown / dept_hq_only."""
    d = (dept or "").strip()
    slug = d.lower() if d.lower() in DEPT_CODES else next((s for s, c in DEPT_CODES.items() if c == d.upper() and s not in HQ_ONLY), None)
    if slug is None and d.upper() == "HQ":
        slug = "exec"
    if slug is None:
        raise GrowthError("dept_unknown")
    if slug in HQ_ONLY:
        raise GrowthError("dept_hq_only")
    return slug


class StaffService:
    def __init__(self, ctx):
        self.ctx, self._lock = ctx, asyncio.Lock()

    @property
    def reg(self) -> RuntimePersonaRegistry:
        return self.ctx.personas

    def _audit(self, tx, scope, ref, action, field, old, new, actor):
        return tx.execute("INSERT INTO audit_log (scope, ref, action, field, old_value, new_value, actor) "
                          "VALUES (?1,?2,?3,?4,?5,?6,?7)", scope, ref, action, field, old, new, actor.ref)

    # -- R25 ---------------------------------------------------------------------------------------------
    def _check_text(self, s: str, lo: int, hi: int, code: str) -> str:
        s = (s or "").strip()
        if not lo <= len(s) <= hi or not _NAME_OK.fullmatch(s) or re.search("discord|clyde", _nk(s)):
            raise GrowthError(code)
        return s

    async def hire(self, *, pid, name, aliases: str, role, dept, model, actor):
        reg = self.reg
        async with self._lock:
            if not reg.template_ok:
                raise GrowthError("template_invalid")
            known = reg.known_ids()
            if not isinstance(pid, str) or not _ID.fullmatch(pid):
                raise GrowthError("id_invalid")
            if pid in RESERVED_IDS:
                raise GrowthError("id_reserved")
            if pid in known:
                raise GrowthError("id_taken")
            if _suffix(pid) in {"SYSTEM", *(_suffix(k) for k in known)}:
                raise GrowthError("suffix_taken")
            name = self._check_text(name, 1, 80, "name_invalid")
            items = [a.strip() for a in (aliases or "").split(",")]
            if not 1 <= len(items) <= 10:
                raise GrowthError("alias_invalid")
            items = [self._check_text(a, 2, 32, "alias_invalid") for a in items]
            taken = reg.name_keys()
            vocab = set(taken) | known
            for n in dict.fromkeys([name, *items]):
                k = _nk(n)
                if k in taken or any(t in vocab for t in k.split()):
                    raise GrowthError("name_taken")
            role = (role or "").strip()
            if not 1 <= len(role) <= 300 or not role.isprintable() or _ROLE_BAD.search(role) or mask_secrets(role) != role:
                raise GrowthError("role_invalid")
            slug = resolve_dept(dept)
            if model not in reg.file_models():
                raise GrowthError("model_not_allowed")
            aliases_json = json.dumps(items, ensure_ascii=False)
            new = json.dumps({"name": name, "aliases": items, "role": role, "dept": slug, "model": model}, ensure_ascii=False)
            async with self.ctx.db.transaction() as tx:
                await tx.execute("INSERT INTO personas_runtime (id, kind, name, aliases, role, model, dept, updated_by) "
                                 "VALUES (?1,'hired',?2,?3,?4,?5,?6,?7)", pid, name, aliases_json, role, model, slug, actor.ref)
                await self._audit(tx, "persona", pid, "hire", None, None, mask_secrets(new)[:4000], actor)
            await reg.reload()
            self.ctx.log.write_log("growth", "persona.hired", "WARNING", id=pid, dept=slug, by=actor.ref)
            p = reg.get(pid)
            if p is None:  # refused on reload (collision): nothing usable was created
                raise GrowthError("name_taken")
            return p

    # -- R26 / R27 ---------------------------------------------------------------------------------------
    def _target(self, pid: str) -> Persona:
        reg, cfg = self.reg, self.ctx.config
        p = reg.get(pid)
        if p is None:
            raise GrowthError("already_fired" if reg.is_fired(pid) else "persona_unknown")
        if pid in (cfg.intake_persona, cfg.default_agent_id) or p.dept in HQ_ONLY:
            raise GrowthError("persona_protected")
        return p

    async def _clear_head(self, code: str, pid: str, actor) -> None:
        if await self.ctx.settings.head(code) == pid:
            await self.ctx.settings.set(f"approval.head.{code.lower()}", "none", actor.ref)

    async def fire(self, pid, reason, actor):
        async with self._lock:
            p = self._target(pid)
            note = "fired: " + _clip_free(reason)
            async with self.ctx.db.transaction() as tx:
                await tx.execute("INSERT INTO personas_runtime (id, kind, status, updated_by) VALUES (?1,'override','fired',?2) "
                                 "ON CONFLICT(id) DO UPDATE SET status='fired', updated_by=excluded.updated_by, "
                                 "updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')", pid, actor.ref)
                await self._audit(tx, "persona", pid, "fire", "status", "active", note, actor)
            await self.reg.reload()
            await self._clear_head(DEPT_CODES.get(p.dept, "HQ"), pid, actor)
            self.ctx.log.write_log("growth", "persona.fired", "WARNING", id=pid, by=actor.ref)

    async def move(self, pid, dept, head: bool, actor) -> tuple[str, str]:
        async with self._lock:
            return await self._move(pid, dept, head, actor)

    async def _move(self, pid, dept, head, actor) -> tuple[str, str]:
        p = self._target(pid)
        new = resolve_dept(dept)
        if new == p.dept:
            raise GrowthError("same_dept")
        if head and self.ctx.settings.is_disabled(pid):
            raise GrowthError("head_invalid")
        old = p.dept
        async with self.ctx.db.transaction() as tx:
            await tx.execute("INSERT INTO personas_runtime (id, kind, dept, updated_by) VALUES (?1,'override',?2,?3) "
                             "ON CONFLICT(id) DO UPDATE SET dept=excluded.dept, updated_by=excluded.updated_by, "
                             "updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')", pid, new, actor.ref)
            await self._audit(tx, "persona", pid, "move", "dept", old, new, actor)
        await self.reg.reload()
        await self._clear_head(DEPT_CODES.get(old, "HQ"), pid, actor)
        if head:
            try:
                await self.ctx.settings.set(f"approval.head.{DEPT_CODES[new].lower()}", pid, actor.ref)
            except SettingsError:
                raise GrowthError("head_invalid") from None
        self.ctx.log.write_log("growth", "persona.moved", "WARNING", id=pid, dept=new, by=actor.ref)
        return old, new

    # -- R28 ---------------------------------------------------------------------------------------------
    async def add_dept(self, code, name, head, channel, actor) -> str:
        st = self.ctx.settings
        async with self._lock:
            code = (code or "").strip()
            if not _CODE.fullmatch(code):
                raise GrowthError("code_invalid")
            if code in RESERVED_CODES:
                raise GrowthError("code_reserved")
            slug = code.lower()
            if code in DEPT_CODES.values() or slug in DEPT_CODES:
                raise GrowthError("code_taken")
            name = (name or "").strip()
            if not 1 <= len(name) <= 64 or not name.isprintable():
                raise GrowthError("dept_name_invalid")
            used = {n["name"].casefold() for n in await self.ctx.db.fetch("SELECT name FROM departments")}
            if name.casefold() in used | {normalise(s) for s in DEPT_CODES}:
                raise GrowthError("dept_name_taken")
            if channel:
                try:
                    channel = st.validate_channel(channel)
                except SettingsError:
                    raise GrowthError("channel_invalid") from None
            if head:
                self._target(head)
                if st.is_disabled(head):
                    raise GrowthError("head_invalid")
            async with self.ctx.db.transaction() as tx:
                await tx.execute("INSERT INTO departments (code, slug, name, created_by) VALUES (?1,?2,?3,?4)",
                                 code, slug, name, actor.ref)
                await self._audit(tx, "dept", code, "add", None, None,
                                  mask_secrets(json.dumps({"name": name, "slug": slug}, ensure_ascii=False))[:4000], actor)
            register_dept(slug, code)
            if channel:
                await st.set(f"approval.channel.{slug}", channel, actor.ref)
            if head:
                await self._move(head, slug, True, actor)
            self.ctx.log.write_log("growth", "dept.added", "WARNING", code=code, by=actor.ref)
            return code
