"""TASK-033 T4: StaffService (hire/fire/move/dept add) and startup with hired/fired tokens (AT-9, AT-10, AT-12; G033-09..11)."""
import asyncio
import types
from pathlib import Path

import pytest

from core.__main__ import amain
from core.approvals import depts
from core.growth import GrowthError
from core.growth.personas import RuntimePersonaRegistry, StaffService
from core.interfaces import Actor
from core.settings import service as S
from tests.discord_fakes import ALLOWED, APPROVER_ROLE, Bot, Channel, Guild, G, HUMAN, Member, TOK_PRAW, TOK_TEK
from tests.test_approvals_routing import Log
from tests.test_growth_registry import PROMPTS, depts_snapshot, files  # noqa: F401

ADMIN = Actor("cli", "admin")
MARK = "ZZMARKERZZ"
GOOD_CH = 222222222222222201


async def mk(db):
    log = Log()
    reg = await RuntimePersonaRegistry.load(db, files(), PROMPTS, "google/cheap", log)
    cfg = types.SimpleNamespace(intake_persona="praw", default_agent_id="praw", approval_ttl_h=24, admin_notify_channel_id=3,
                                settings_channel_id=1565667791938387969)
    st = S.SettingsService(db, cfg, log, reg)
    st.channel_ok = lambda c: c == GOOD_CH
    ctx = types.SimpleNamespace(db=db, config=cfg, log=log, personas=reg, settings=st)
    return StaffService(ctx), ctx, log


HIRE = dict(pid="ben", name="Ben Tan", aliases="benny, ben t", role="Helps with onboarding questions", dept="dev",
            model="google/cheap", actor=ADMIN)


async def audits(db, scope=None):
    return await db.fetch("SELECT * FROM audit_log WHERE scope=?1 ORDER BY id", scope)


async def test_hire_ok_works_at_once(db):
    sv, ctx, log = await mk(db)
    p = await sv.hire(**HIRE)
    reg = ctx.personas
    assert reg.get("ben") is p and reg.by_name("ben tan") is p and p.tools == sv.reg._tpl["tools"] and p.dept == "dev"
    assert "Helps with onboarding questions" in p.body and p.aliases == ("benny", "ben t")
    (a,) = await audits(db, "persona")
    assert (a["ref"], a["action"], a["actor"]) == ("ben", "hire", "cli:admin") and '"role": "Helps' in a["new_value"] and "benny" in a["new_value"]
    # no own client: the sink routes through Praw with the name prefix
    from core.discord.sinks import DiscordSinkFactory

    class Ch:
        id = 5
    f = DiscordSinkFactory.__new__(DiscordSinkFactory)
    f.app = types.SimpleNamespace(client_for=lambda pid: None, intake=types.SimpleNamespace(get_channel=lambda c: Ch()))
    _, _, prefix = await f._open_channel(5, p)()
    assert prefix == "**Ben Tan:** "


@pytest.mark.parametrize("over,code", [
    ({"pid": "Ben"}, "id_invalid"), ({"pid": "b"}, "id_invalid"), ({"pid": "praw"}, "id_reserved"), ({"pid": "system"}, "id_reserved"),
    ({"pid": "tek"}, "id_taken"),     ({"name": ""}, "name_invalid"), ({"name": "My Discord"}, "name_invalid"), ({"name": "Be*n"}, "name_invalid"),
    ({"name": "Ben\nTan"}, "name_invalid"), ({"name": "Ｐｒａｗ"}, "name_invalid"), ({"name": "Раw"}, "name_invalid"),
    ({"aliases": ""}, "alias_invalid"), ({"aliases": "a"}, "alias_invalid"), ({"aliases": ",".join(["abc"] * 11)}, "alias_invalid"),
    ({"aliases": "b<b"}, "alias_invalid"),
    ({"name": "Praw"}, "name_taken"), ({"name": "PRAW"}, "name_taken"), ({"name": "Praw CEO"}, "name_taken"),
    ({"aliases": "tek"}, "name_taken"), ({"aliases": "benny, anan"}, "name_taken"), ({"name": "เทค"}, "name_taken"),
    ({"role": ""}, "role_invalid"), ({"role": "a\nb"}, "role_invalid"), ({"role": "a<b"}, "role_invalid"),
    ({"role": "x" * 301}, "role_invalid"), ({"role": "key AIza" + "a" * 35}, "role_invalid"),
    ({"dept": "nowhere"}, "dept_unknown"), ({"dept": "exec"}, "dept_hq_only"), ({"dept": "HQ"}, "dept_hq_only"),
    ({"model": "google/other"}, "model_not_allowed"),
])
async def test_hire_refusals_write_nothing(db, over, code):
    sv, ctx, _ = await mk(db)
    with pytest.raises(GrowthError) as e:
        await sv.hire(**{**HIRE, **over})
    assert e.value.code == code
    assert not await db.fetch("SELECT 1 FROM personas_runtime") and not await audits(db, "persona")


async def test_hire_dept_by_code_and_duplicates_and_fired_ids_kept(db):
    sv, ctx, _ = await mk(db)
    assert (await sv.hire(**{**HIRE, "dept": "DEV"})).dept == "dev"
    for over in ({"pid": "ben"}, {"pid": "ben2", "name": "BEN TAN"}, {"pid": "ben2", "name": "Zed", "aliases": "benny"}):
        with pytest.raises(GrowthError):
            await sv.hire(**{**HIRE, **over})
    await sv.fire("ben", "", ADMIN)                     # no rehire: the fired id, name and aliases stay reserved
    for over in ({"pid": "ben"}, {"pid": "ben3", "name": "Ben Tan"}, {"pid": "ben3", "name": "Zed", "aliases": "benny"}):
        with pytest.raises(GrowthError):
            await sv.hire(**{**HIRE, **over})


async def test_hire_env_suffix_clash(db):
    sv, ctx, _ = await mk(db)
    await sv.hire(**{**HIRE, "pid": "ab-c", "name": "Abc", "aliases": "abcx"})
    with pytest.raises(GrowthError) as e:
        await sv.hire(**{**HIRE, "pid": "ab_c", "name": "Abd", "aliases": "abdx"})
    assert e.value.code == "suffix_taken"


async def test_hire_template_invalid(db):
    sv, ctx, _ = await mk(db)
    ctx.personas.template_ok = False
    with pytest.raises(GrowthError) as e:
        await sv.hire(**HIRE)
    assert e.value.code == "template_invalid"


async def test_fire_protected_and_unknown(db):
    sv, ctx, _ = await mk(db)
    for pid, code in (("praw", "persona_protected"), ("mira", "persona_protected"), ("nobody", "persona_unknown")):
        with pytest.raises(GrowthError) as e:
            await sv.fire(pid, "x", ADMIN)
        assert e.value.code == code
    ctx.config.intake_persona = "tek"          # intake and default agent are protected whatever they are
    with pytest.raises(GrowthError):
        await sv.fire("tek", "x", ADMIN)
    ctx.config.intake_persona = "praw"
    await sv.fire("tek", "x", ADMIN)
    with pytest.raises(GrowthError) as e:
        await sv.fire("tek", "x", ADMIN)
    assert e.value.code == "already_fired"


async def test_fire_file_persona_override_head_reset_audited(db):
    sv, ctx, _ = await mk(db)
    assert await ctx.settings.get("approval.head.dev") == "tek"
    await sv.fire("tek", "left " + "AIza" + "a" * 35 + "x" * 300, ADMIN)
    r = await db.fetchrow("SELECT * FROM personas_runtime WHERE id='tek'")
    assert r["kind"] == "override" and r["status"] == "fired" and ctx.personas.get("tek") is None and ctx.personas.is_fired("tek")
    assert await ctx.settings.get("approval.head.dev") == "none"
    (a,) = await audits(db, "persona")
    assert (a["action"], a["field"], a["old_value"]) == ("fire", "status", "active")
    assert a["new_value"].startswith("fired: left ") and "AIza" not in a["new_value"] and len(a["new_value"]) <= 208
    (s,) = await audits(db, "setting")
    assert (s["ref"], s["new_value"]) == ("approval.head.dev", "none")


async def test_move_rules_and_head(db):
    sv, ctx, log = await mk(db)
    await sv.hire(**HIRE)
    ctx.settings.is_disabled = lambda pid: pid == "ben"          # hired, no client
    for pid, dept, head, code in (("praw", "dev", False, "persona_protected"), ("mira", "dev", False, "persona_protected"),
                                  ("tek", "exec", False, "dept_hq_only"), ("tek", "dev", False, "same_dept"),
                                  ("tek", "nowhere", False, "dept_unknown"), ("ben", "hr", True, "head_invalid"),
                                  ("zzz", "hr", False, "persona_unknown")):
        with pytest.raises(GrowthError) as e:
            await sv.move(pid, dept, head, ADMIN)
        assert e.value.code == code
    assert await sv.move("tek", "hr", False, ADMIN) == ("dev", "hr")      # tek headed dev: reset
    assert ctx.personas.get("tek").dept == "hr" and await ctx.settings.get("approval.head.dev") == "none"
    assert await db.fetchval("SELECT dept FROM personas_runtime WHERE id='tek'") == "hr"
    ctx.settings.is_disabled = lambda pid: False
    assert await sv.move("ben", "HR", True, ADMIN) == ("dev", "hr")
    assert await ctx.settings.get("approval.head.hr") == "ben"
    acts = [(a["ref"], a["action"], a["old_value"], a["new_value"]) for a in await audits(db, "persona")]
    assert ("tek", "move", "dev", "hr") in acts and ("ben", "move", "dev", "hr") in acts


async def test_add_dept(db, depts_snapshot):
    sv, ctx, log = await mk(db)
    ctx.settings.is_disabled = lambda pid: False
    for code, name, kw, err in (("hq", "X", {}, "code_invalid"), ("A", "X", {}, "code_invalid"), ("LSN", "X", {}, "code_reserved"),
                                ("FIN", "X", {}, "code_taken"), ("DATA", "X", {}, "code_taken"), ("QAT", "", {}, "dept_name_invalid"),
                                ("QAT", "ACCOUNT", {}, "dept_name_taken"), ("QAT", "Qa", {"channel": "12345"}, "channel_invalid"),
                                ("QAT", "Qa", {"head": "praw"}, "persona_protected"), ("QAT", "Qa", {"head": "ghost"}, "persona_unknown")):
        with pytest.raises(GrowthError) as e:
            await sv.add_dept(code, name, kw.get("head"), kw.get("channel"), ADMIN)
        assert e.value.code == err
    assert not await db.fetch("SELECT 1 FROM departments") and "qat" not in depts.DEPT_SLUGS
    assert await sv.add_dept("QAT", "Quality", "tek", str(GOOD_CH), ADMIN) == "QAT"
    with pytest.raises(GrowthError) as e:
        await sv.add_dept("ZED", "quality", None, None, ADMIN)
    assert e.value.code == "dept_name_taken"
    view = {k for k, *_ in await ctx.settings.view()}
    assert {"approval.channel.qat", "approval.head.qat"} <= view
    assert await ctx.settings.get("approval.channel.qat") == str(GOOD_CH) and await ctx.settings.get("approval.head.qat") == "tek"
    assert ctx.personas.get("tek").dept == "qat"
    (d,) = await audits(db, "dept")
    assert (d["ref"], d["action"]) == ("QAT", "add")


async def test_logs_carry_ids_only(db):
    sv, ctx, log = await mk(db)
    await sv.hire(**{**HIRE, "name": "Ben " + MARK[:2], "role": "role " + MARK})
    await sv.fire("ben", "reason " + MARK, ADMIN)
    await sv.move("tek", "hr", False, ADMIN)
    assert not any(MARK in repr(f) for _, _, f in log.rows)


# ---- AT-12 startup ---------------------------------------------------------------------------------------
async def test_startup_hired_token_own_client_fired_skipped_unknown_refused(tmp_path, monkeypatch, capsys):
    from tests.conftest import make_db_path
    from tests.test_discord_layer import fake_env
    import core.__main__ as M
    monkeypatch.delenv("EMP_CLI_DEV", raising=False)
    path = make_db_path(tmp_path)
    for sql in ("INSERT INTO personas_runtime (id, kind, name, aliases, role, model, dept, updated_by) VALUES "
                "('ben','hired','Ben','[\"benny\"]','r','google/x','dev','cli:admin')",
                "INSERT INTO personas_runtime (id, kind, status, updated_by) VALUES ('bank','override','fired','cli:admin')",
                "INSERT INTO personas_runtime (id, kind, name, aliases, role, model, dept, status, updated_by) VALUES "
                "('gone','hired','Gone','[\"gone2\"]','r','google/x','dev','fired','cli:admin')"):
        import sqlite3
        c = sqlite3.connect(path); c.execute(sql); c.commit(); c.close()
    holder = {}

    class FBot(Bot):
        async def start(self, token):
            pass
    real = M.setup_discord
    monkeypatch.setattr(M, "setup_discord", lambda ctx, bots, system=None: holder.setdefault("bots", set(bots)) and real(ctx, bots, system))
    extra = {"DISCORD_BOT_TOKEN_BEN": "tok-ben-eeeeeeeeeeeeeeeeee", "DISCORD_APP_ID_BEN": "21",
             "DISCORD_BOT_TOKEN_BANK": "tok-bank-ffffffffffffffff", "DISCORD_APP_ID_BANK": "22",
             "DISCORD_BOT_TOKEN_GONE": "tok-gone-gggggggggggggggg", "DISCORD_APP_ID_GONE": "23"}
    env = fake_env(tmp_path, DATABASE_PATH=path, LOG_DIR=str(tmp_path / "logs"), **extra)
    g = Guild(channels=[Channel(ALLOWED)], members=[Member(HUMAN, [APPROVER_ROLE])])
    rc = await amain(env, bot_factory=lambda c, intake: FBot(900 + len(holder), 11, g), install_signals=False)
    assert holder["bots"] == {"praw", "ben"}, (rc, holder, capsys.readouterr().err)   # fired file (bank) and fired hired (gone) skipped
    assert "persona.token_fired" in (tmp_path / "logs" / "app.jsonl").read_text()
    env = fake_env(tmp_path, DATABASE_PATH=path, LOG_DIR=str(tmp_path / "logs"), DISCORD_BOT_TOKEN_NOBODY="tok-nb-hhhhhhhhhhhhhhhhhh", DISCORD_APP_ID_NOBODY="9")
    assert await amain(env, install_signals=False) == 2 and "unknown_persona_token:NOBODY" in capsys.readouterr().err
