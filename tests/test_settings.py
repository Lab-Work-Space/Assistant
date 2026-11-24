"""TASK-031 R9: settings service (validation, seeds, audit, reset) and T031-06 persona id `system`."""
import types

import pytest

from core.agents.persona import FilePersonaRegistry
from core.settings.service import KEYS, SettingsError, SettingsService
from tests.test_approvals_routing import REG, Log

CFG = types.SimpleNamespace(approval_ttl_h=48, admin_notify_channel_id=3, settings_channel_id=1565667791938387969)
GOOD_CH = 222222222222222201


def svc(db, log=None):
    s = SettingsService(db, CFG, log or Log(), REG)
    s.channel_ok = lambda cid: cid in (GOOD_CH, CFG.settings_channel_id, 3)
    return s


@pytest.mark.parametrize("key,raw,out", [
    ("approval.hq_threshold_thb", "10,000", "10000"), ("approval.hq_threshold_thb", "1", "1"),
    ("approval.hq_threshold_thb", "100000000", "100000000"), ("approval.ttl_h", "168", "168"),
    ("approval.rate_per_day", "100", "100"), ("approval.ai_daily_max", "0", "0"), ("approval.ai_daily_max", "200", "200"),
    ("approval.ai_enabled", "OFF", "off"), ("approval.channel.fin", "hq", "hq"), ("approval.channel.fin", str(GOOD_CH), str(GOOD_CH)),
    ("approval.head.fin", "mali", "mali"), ("approval.head.fin", "none", "none"), ("approval.head.dev", "tek", "tek"),
])
def test_valid_values(db, key, raw, out):
    assert svc(db).validate(key, raw) == out


@pytest.mark.parametrize("key,raw", [
    ("approval.hq_threshold_thb", "0"), ("approval.hq_threshold_thb", "100000001"), ("approval.hq_threshold_thb", "1e3"),
    ("approval.hq_threshold_thb", "-5"), ("approval.hq_threshold_thb", ""), ("approval.ttl_h", "169"), ("approval.ttl_h", "0"),
    ("approval.rate_per_day", "101"), ("approval.ai_daily_max", "201"), ("approval.ai_enabled", "maybe"),
    ("approval.channel.fin", "12345"), ("approval.channel.fin", "abc"), ("approval.channel.fin", "999999999999999999"),   # not allowlisted
    ("approval.channel.fin", str(CFG.settings_channel_id)),   # T031-07: never the settings channel
    ("approval.channel.fin", "3"),                            # nor the admin / System log channel
    ("approval.head.fin", "sub2"), ("approval.head.fin", "tek"),    # unknown persona / other department
    ("approval.head.hq", "mira"), ("approval.head.fin", "praw"),
])
def test_invalid_values(db, key, raw):
    with pytest.raises(SettingsError) as e:
        svc(db).validate(key, raw)
    assert e.value.code in ("invalid_value", "unknown_key")


def test_channel_without_resolver_and_disabled_head_refused(db):
    s = SettingsService(db, CFG, Log(), REG)  # resolver not injected: fail closed
    with pytest.raises(SettingsError):
        s.validate("approval.channel.fin", str(GOOD_CH))
    s.is_disabled = lambda pid: pid == "mali"
    with pytest.raises(SettingsError):
        s.validate("approval.head.fin", "mali")


async def test_unknown_key_refused_before_any_db_access():
    s = SettingsService(None, CFG, Log(), REG)  # a None db would raise AttributeError if touched
    for call in (s.get("nope"), s.set("approval.ttl", "1", "cli:admin"), s.reset("nope", "cli:admin"), s.view("nope")):
        with pytest.raises(SettingsError) as e:
            await call
        assert e.value.code == "unknown_key"


async def test_effective_value_db_then_seed_and_oq4_seeds(db):
    s = svc(db)
    assert await s.threshold() == 10000 and await s.ttl_h() == 48 and await s.rate_per_day() == 10
    assert await s.ai_daily_max() == 20 and await s.ai_enabled() is True
    assert await s.approval_channel("fin") == "1567005451516772513" and await s.approval_channel("HR") == "1567005110243033228"
    seeds = {"mkt": 1567005741003313212, "sal": 1567005947287568474, "ops": 1567006095526858884, "prd": 1567005024146554960,
             "dev": 1567004690351128676}
    for c, v in seeds.items():
        assert await s.approval_channel(c) == str(v)
    for c in ("it", "leg", "prc", "sup", "dat", "dsn"):
        assert await s.approval_channel(c) == "hq"
    assert await s.head("fin") == "mali" and await s.head("dev") == "tek" and await s.head("zzz") is None
    old, new = await s.set("approval.ttl_h", "12", "cli:admin")
    assert (old, new) == ("48", "12") and await s.ttl_h() == 12
    assert await s.reset("approval.ttl_h", "cli:admin") == "48" and await s.ttl_h() == 48  # back to the env seed


async def test_set_and_reset_are_audited_and_logged_without_values(db):
    log = Log()
    s = svc(db, log)
    await s.set("approval.hq_threshold_thb", "25,000", "discord:123456789012345678")
    await s.reset("approval.hq_threshold_thb", "discord:123456789012345678")
    rows = await db.fetch("SELECT * FROM audit_log WHERE scope='setting' ORDER BY id")
    assert [(r["action"], r["old_value"], r["new_value"], r["actor"]) for r in rows] == [
        ("set", None, "25000", "discord:123456789012345678"), ("reset", "25000", "10000", "discord:123456789012345678")]
    assert [(m, lv, f) for m, lv, f in log.rows] == [
        ("settings.changed", "WARNING", {"id": "approval.hq_threshold_thb", "by": "discord:123456789012345678", "status": "set"}),
        ("settings.changed", "WARNING", {"id": "approval.hq_threshold_thb", "by": "discord:123456789012345678", "status": "reset"})]
    with pytest.raises(SettingsError):
        await s.set("approval.hq_threshold_thb", "abc", "cli:admin")
    assert await db.fetchval("SELECT count(*) FROM audit_log WHERE scope='setting'") == 2  # refused write leaves nothing


async def test_view_lists_every_key_with_source(db):
    s = svc(db)
    await s.set("approval.ai_enabled", "off", "cli:admin")
    v = {k: (val, src) for k, val, src in await s.view()}
    assert set(v) == set(KEYS) and v["approval.ai_enabled"] == ("off", "db") and v["approval.ttl_h"] == ("48", "default")


# ---- T031-06 -------------------------------------------------------------------------------------------------------
def test_persona_loader_refuses_reserved_system_id_and_dept(tmp_path):
    root = tmp_path / "p"
    (root / "_fragments").mkdir(parents=True)
    (root / "x").mkdir()

    def write(name, pid, dept):
        (root / "x" / name).write_text(f"---\nid: {pid}\nname: N{pid}\naliases: [al{pid}]\nrole: r\ndept: {dept}\nmodel: google/m\n"
                                       "effort: low\ntools: []\ntraits: []\ncolor: '#112233'\nfragments: []\n---\nbody\n")
    write("a.md", "praw", "praw")
    write("b.md", "system", "ops")
    write("c.md", "okid", "system")
    reg = FilePersonaRegistry.load(root, "praw", "google/cheap")
    assert [p.id for p in reg.all()] == ["praw"]
