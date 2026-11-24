"""TASK-033 T4: settings keys, runtime departments, RuntimePersonaRegistry (R20-R22, G033-08/10)."""
import types
from pathlib import Path

import pytest

from core.agent_tools.registry import Registry
from core.agents.persona import FilePersonaRegistry
from core.approvals import depts
from core.growth import OVERLAY_HARD_MAX_CHARS
from core.growth.personas import HIRED_TOOLS, RuntimePersonaRegistry, load_departments
from core.interfaces import ToolSpec
from core.settings import service as S
from tests.test_approvals_routing import Log

PROMPTS = Path(__file__).resolve().parent.parent / "prompts"


@pytest.fixture
def depts_snapshot():
    codes, slugs, keys = dict(depts.DEPT_CODES), list(depts.DEPT_SLUGS), list(S.KEYS)
    yield
    depts.DEPT_CODES.clear(); depts.DEPT_CODES.update(codes)
    depts.DEPT_SLUGS[:] = slugs
    S.KEYS[:] = keys


def files():
    return FilePersonaRegistry.load(PROMPTS, "praw", "google/cheap")


def hired_row(db, pid="ben", name="Ben", aliases='["benny"]', status="active", dept="dev"):
    return db.execute("INSERT INTO personas_runtime (id, kind, name, aliases, role, model, dept, status, updated_by) "
                      "VALUES (?1,'hired',?2,?3,'does things','google/cheap',?4,?5,'cli:admin')", pid, name, aliases, dept, status)


def test_growth_keys_and_bounds():
    assert S._INTS["growth.lessons_per_day"] == (0, 50) and S._INTS["growth.overlay_max_chars"] == (500, 6000)
    assert 6000 + 100 <= 6500 and 2 * 6500 + 2 + 200 <= OVERLAY_HARD_MAX_CHARS


async def test_growth_seeds_and_validation(db):
    s = S.SettingsService(db, types.SimpleNamespace(), Log(), None)
    assert await s.lessons_per_day() == 3 and await s.overlay_max_chars() == 3000
    assert s.validate("growth.lessons_per_day", "0") == "0" and s.validate("growth.overlay_max_chars", "6000") == "6000"
    for k, v in (("growth.lessons_per_day", "51"), ("growth.overlay_max_chars", "499"), ("growth.overlay_max_chars", "6001")):
        with pytest.raises(S.SettingsError):
            s.validate(k, v)


async def test_register_dept_idempotent_in_place(db, depts_snapshot):
    ident = (id(depts.DEPT_CODES), id(depts.DEPT_SLUGS), id(S.KEYS))
    S.register_dept("qa", "QAT"); S.register_dept("qa", "QAT")
    assert ident == (id(depts.DEPT_CODES), id(depts.DEPT_SLUGS), id(S.KEYS))
    assert depts.DEPT_CODES["qa"] == "QAT" and depts.DEPT_SLUGS.count("qa") == 1 and isinstance(depts.DEPT_SLUGS, list)
    assert S.KEYS.count("approval.channel.qat") == 1 and "approval.head.qat" in S.KEYS
    s = S.SettingsService(db, types.SimpleNamespace(), Log(), None)
    assert await s.get("approval.channel.qat") == "hq" and await s.get("approval.head.qat") == "none"
    await db.execute("INSERT INTO departments (code, slug, name, created_by) VALUES ('ZED','zed','Zed','cli:admin')")
    await load_departments(db)
    assert depts.DEPT_CODES["zed"] == "ZED"


async def test_template_loaded_tools_exactly_hired_tools(db):
    await hired_row(db)
    reg = await RuntimePersonaRegistry.load(db, files(), PROMPTS, "google/cheap", Log())
    assert reg.template_ok
    p = reg.get("ben")
    assert p.tools == HIRED_TOOLS and not any("*" in t for t in p.tools) and p.path == "db:personas_runtime/ben"
    assert p.cheap_model == "google/cheap" and p.dept == "dev"
    tr = Registry(Log())
    for n in (*HIRED_TOOLS, "knowledge_extra", "task_create", "approval_decide"):
        tr.register(ToolSpec(n, "d", {"type": "object", "additionalProperties": False}, None, override_only=n == "approval_decide"))
    assert {t.name for t in tr.for_agent(p)} == set(HIRED_TOOLS)
    assert reg.by_name("ben") is p and "praw" in reg.known_ids()


async def test_template_filled_in_one_pass(db):
    await db.execute("INSERT INTO personas_runtime (id, kind, name, aliases, role, model, dept, updated_by) "
                     "VALUES ('ben','hired','Ben','[\"benny\"]','see {dept} and {name}','google/cheap','dev','cli:admin')")
    reg = await RuntimePersonaRegistry.load(db, files(), PROMPTS, "google/cheap", Log())
    assert "see {dept} and {name}" in reg.get("ben").body


@pytest.mark.parametrize("break_it", ["wildcard", "foreign_tool", "fragment"])
async def test_template_invalid_disables_hiring(db, tmp_path, break_it):
    import shutil
    root = tmp_path / "p"
    shutil.copytree(PROMPTS, root)
    t = root / "_system" / "hired-persona.md"
    txt = t.read_text()
    txt = {"wildcard": txt.replace('"respond"', '"knowledge_*"'), "foreign_tool": txt.replace('"respond"', '"task_create"'),
           "fragment": txt.replace("[asking,", "[nonesuch,")}[break_it]
    t.write_text(txt)
    await hired_row(db)
    log = Log()
    reg = await RuntimePersonaRegistry.load(db, files(), root, "google/cheap", log)
    assert not reg.template_ok and reg.get("ben") is None and log.ev("persona.template_invalid")
    assert reg.get("praw") is not None   # startup continues


async def test_collisions_refused_file_wins(db):
    await hired_row(db, "tekk", "เทค", '["x1"]')            # collides on a file persona's name
    await hired_row(db, "bob", "Bob", '["Ｐｒａｗ"]')        # fullwidth Praw alias collides after NFKC
    await hired_row(db, "mira", "Zed", '["zed"]')           # collides on a file persona's id
    log = Log()
    reg = await RuntimePersonaRegistry.load(db, files(), PROMPTS, "google/cheap", log)
    assert reg.get("tekk") is None and reg.get("bob") is None and reg.get("mira").name != "Zed"
    assert len(log.ev("persona.refused")) == 3
    assert all(set(f) <= {"id", "reason"} for f in log.ev("persona.refused"))


async def test_override_fired_and_lookups(db):
    await hired_row(db, "ben"); await hired_row(db, "old", "Olde", '["olde2"]', status="fired")
    await db.execute("INSERT INTO personas_runtime (id, kind, dept, updated_by) VALUES ('tek','override','data','cli:admin')")
    await db.execute("INSERT INTO personas_runtime (id, kind, status, updated_by) VALUES ('bank','override','fired','cli:admin')")
    reg = await RuntimePersonaRegistry.load(db, files(), PROMPTS, "google/cheap", Log())
    assert reg.get("tek").dept == "data" and reg.get("bank") is None and reg.is_fired("bank") and reg.is_fired("old")
    assert reg.get("old") is None and {"old", "bank", "ben"} <= reg.known_ids()
    assert "olde2" in reg.name_keys() and "google/cheap" in reg.file_models()
    assert reg.by_name("Olde") is None
    ident = id(reg)
    await db.execute("DELETE FROM personas_runtime WHERE id='tek'")
    await reg.reload()
    assert id(reg) == ident and reg.get("tek").dept == "dev"
