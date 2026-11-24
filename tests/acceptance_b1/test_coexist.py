"""021B-T: AC-1 gate/silence/streaming, spec 12.6 / 12.7 / 12.10.1 coexistence probes. Full core, fake Discord, fake providers."""
import asyncio
import json

import pytest

from core.__main__ import amain
from core.discord import strings
from tests.acceptance_b1.harness import (ADMIN, ALLOWED, CAT, G, HUMAN, OUTSIDE, build_env, launch)
from tests.discord_fakes import SYS_UID
from tests.discord_fakes import APPROVER_ROLE

SMALL = ["praw", "tek", "fahsai"]
CANARY = "CANARY-9f3a-do-not-log"


async def settle(n=0.15):
    await asyncio.sleep(n)


# ---- non-allowlisted channel: no reply, zero provider calls, no content anywhere (AC-1, 12.6) -----------------------------
async def test_non_allowlisted_channel_silent_no_provider_no_content(tmp_path, monkeypatch):
    r = await launch(tmp_path, monkeypatch, SMALL)
    rows_before = len(r.log_text().splitlines())
    assert rows_before > 0                                 # non-empty log: the grep below is not vacuous
    out = r.ch(OUTSIDE)
    for to in ("praw", "tek", None):                      # mention, mention of a non-intake persona, plain text with a name
        await r.say(OUTSIDE, f"{CANARY} hey praw please answer", to=to)
    await r.say(OUTSIDE, f"{CANARY} reply", ref=type("R", (), {"resolved": type("X", (), {"author": type("A", (), {"id": r.uid("praw")})()})()})())
    await settle()
    assert r.prov.stream_calls == 0 and r.prov.complete_calls == 0
    assert not any(c.get_channel(OUTSIDE).sent for c in r.world.clients.values())
    ev = r.log_events("gate.outside_allowlist")
    assert ev and all(CANARY not in str(e) for e in ev)
    assert CANARY not in r.log_text() and all(CANARY not in t for t in r.world.texts())
    new = [json.loads(x)["event"] for x in r.log_text().splitlines()[rows_before:]]
    assert new and set(new) == {"gate.outside_allowlist"}, new       # plan 021B-T (2): ONLY this line is logged
    assert await r.stop() == 0


async def test_outside_log_is_rate_limited_and_has_ids_only(tmp_path, monkeypatch):
    r = await launch(tmp_path, monkeypatch, SMALL)
    for i in range(50):
        await r.say(OUTSIDE, f"{CANARY} {i}")
    ev = r.log_events("gate.outside_allowlist")
    assert 1 <= len(ev) <= 2, len(ev)                      # one line per channel per minute, rest suppressed
    assert all(set(e) >= {"channel", "suppressed"} and "content" not in e and "text" not in e for e in ev)
    await r.stop()


# ---- slash / button outside the allowlist: ephemeral refusal, nothing else -------------------------------------------------
async def test_slash_and_button_outside_allowlist_ephemeral_refusal(tmp_path, monkeypatch):
    r = await launch(tmp_path, monkeypatch, SMALL)
    check = r.world.clients[r.uid("praw")].checks[0]
    i = r.interaction(ch=r.ch(OUTSIDE), kind="command")
    assert await check(type("Ctx", (), {"interaction": i})()) is False
    assert i.out == [("resp", strings.NOT_ALLOWED, {"ephemeral": True})]
    i = r.interaction(ch=r.ch(ALLOWED), kind="command")    # same command inside the allowlist passes the gate
    assert await check(type("Ctx", (), {"interaction": i})()) is True and i.out == []
    for pid in ("praw", "tek"):                            # a click arriving on any client, outside the allowlist
        i = r.interaction(ch=r.ch(OUTSIDE), custom_id="emp:appr:approve:" + "0" * 8 + "-0000-0000-0000-" + "0" * 12, client_pid=pid)
        out = await r.click(i, pid)
        assert out == [("resp", strings.NOT_ALLOWED, {"ephemeral": True})], pid
    assert r.prov.stream_calls == 0
    await r.stop()


# ---- DM from a non-approver in coexist: silence --------------------------------------------------------------------------
async def test_dm_non_approver_silent_approver_answered(tmp_path, monkeypatch):
    r = await launch(tmp_path, monkeypatch, SMALL)
    dm = r.world.members[HUMAN + 1].create_dm
    for uid in (HUMAN + 1, HUMAN + 3, HUMAN + 77):         # plain member, another plain member, not a guild member
        await r.say(0, f"{CANARY} hi", uid=uid, dm=True, ch=await dm())
    await settle()
    assert r.prov.stream_calls == 0 and r.prov.complete_calls == 0 and not r.world.dms.get(HUMAN + 1).sent
    assert CANARY not in r.log_text()
    await r.say(0, "hi", uid=HUMAN, dm=True, ch=await r.world.members[HUMAN].create_dm())   # approver-role holder
    await settle()
    assert r.prov.stream_calls == 1 and any("reply from" in (t or "") for t in r.world.texts(HUMAN + 10**6))
    await r.stop()


# ---- startup refusals (12.7) -----------------------------------------------------------------------------------------------
async def run_refusal(tmp_path, monkeypatch, capsys, personas=SMALL, **over):
    r = await launch(tmp_path, monkeypatch, personas, **over)
    rc = await asyncio.wait_for(r.task, 30)
    return rc, capsys.readouterr().err, r


async def test_app_id_mismatch_intake_refuses_and_posts_nothing(tmp_path, monkeypatch, capsys):
    import tests.acceptance_b1.harness as H
    orig = H.FClient.__init__

    def bad(self, world, uid, app_id):
        orig(self, world, uid, app_id + 5000 if uid == 9001 else app_id)   # praw (intake) logs in as the wrong application
    monkeypatch.setattr(H.FClient, "__init__", bad)
    rc, err, r = await run_refusal(tmp_path, monkeypatch, capsys)
    assert rc == 2 and "app_id_mismatch:praw" in err
    assert not any(m for _, c, m in r.world.all), "no message may be posted after an intake refusal"
    assert r.prov.stream_calls == 0


async def test_app_id_mismatch_non_intake_disables_only_that_persona(tmp_path, monkeypatch, capsys):
    import tests.acceptance_b1.harness as H
    orig = H.FClient.__init__

    def bad(self, world, uid, app_id):
        orig(self, world, uid, app_id + 5000 if uid == 9002 else app_id)   # tek
    monkeypatch.setattr(H.FClient, "__init__", bad)
    r = await launch(tmp_path, monkeypatch, SMALL, DISCORD_BOT_TOKEN_SYSTEM="tok-system-dddddddddddddddd", DISCORD_APP_ID_SYSTEM=4242)
    assert "tek" in r.app.disabled and r.app.exit_code == 0
    await settle()
    admin = [t for t in r.world.texts(ADMIN)]
    assert any(t.startswith("online:") and "clients=2/3" in t for t in admin) and "persona_disabled:tek" in admin
    assert all(m.author.id == SYS_UID for _, c, m in r.world.all if c == ADMIN)   # only System posts in #bot-log (12.14)
    await r.say(ALLOWED, "hi", to="tek")                   # OBS-1 fixed: an @mention of the disabled persona's account goes to Praw
    await settle()
    assert r.prov.stream_calls == 1 and len(r.ch(ALLOWED).sent) == 1 and not r.ch(ALLOWED, "tek").sent
    await r.say(ALLOWED, "เทค ช่วยหน่อย")                   # by name (Tier 1): the gate hands the work to Praw (S1210-07)
    await settle()
    assert r.prov.stream_calls == 2 and len(r.ch(ALLOWED).sent) == 2 and not r.ch(ALLOWED, "fahsai").sent
    assert "reply from" in r.ch(ALLOWED).sent[0].content
    await r.stop()


async def test_token_shared_and_unknown_persona_token_refuse(tmp_path, monkeypatch, capsys):
    env = build_env(tmp_path, SMALL)
    env["DISCORD_BOT_TOKEN_TEK"] = env["DISCORD_BOT_TOKEN_PRAW"]
    assert await amain(env, install_signals=False) == 2 and "token_shared" in capsys.readouterr().err
    env = build_env(tmp_path, SMALL, DISCORD_BOT_TOKEN_NOBODY="tok-nobody-xxxxxxxxxxxxxxxx", DISCORD_APP_ID_NOBODY="4242")
    assert await amain(env, install_signals=False) == 2 and "unknown_persona_token:NOBODY" in capsys.readouterr().err
    env = build_env(tmp_path, SMALL, DISCORD_BOT_TOKEN="legacy-shared-token-xxxxxxxx")
    assert await amain(env, install_signals=False) == 2 and "use_per_persona_tokens" in capsys.readouterr().err
    out = capsys.readouterr()
    assert "tok-" not in out.err and "tok-" not in out.out        # refusal output never echoes a token


async def test_empty_allowlist_and_admin_channels_outside_allowlist_refuse(tmp_path, monkeypatch, capsys):
    env = build_env(tmp_path, SMALL, CHANNEL_ALLOWLIST=None)
    assert await amain(env, install_signals=False) == 2 and "allowlist_empty" in capsys.readouterr().err
    rc, err, r = await run_refusal(tmp_path, monkeypatch, capsys, CHANNEL_ALLOWLIST=str(ALLOWED))   # TASKS/ADMIN/APPROVAL are under CAT only
    assert rc == 2 and "channel_not_allowlisted" in err and not r.world.all
    rc, err, r = await run_refusal(tmp_path, monkeypatch, capsys, CHANNEL_ALLOWLIST=f"{ALLOWED},{CAT},777777777777777777")
    assert rc == 2 and "allowlist_unresolved" in err


async def test_dev_cli_flag_refuses_discord_process(tmp_path, monkeypatch, capsys):
    monkeypatch.setenv("EMP_CLI_DEV", "1")
    assert await amain(build_env(tmp_path, SMALL), install_signals=False) == 2
    assert "cli_flag_in_discord_mode" in capsys.readouterr().err


async def test_other_guild_is_left_at_startup(tmp_path, monkeypatch):
    import tests.acceptance_b1.harness as H
    from tests.discord_fakes import Guild
    orig = H.FClient.__init__
    foreign = []

    def init(self, world, uid, app_id):
        orig(self, world, uid, app_id)
        g = Guild(gid=G + 9)
        foreign.append(g)
        self.guilds.append(g)
    monkeypatch.setattr(H.FClient, "__init__", init)
    r = await launch(tmp_path, monkeypatch, SMALL)
    assert all(g.left for g in foreign) and len(r.log_events("guild.left")) == 3
    await r.stop()


async def test_intents_and_listeners_only_intake_reads_messages(tmp_path, monkeypatch):
    """S1210-06 / spec 12.10: non-intake clients: guilds intent only, no message content, no members, no DM or message listener."""
    from core.config import Config
    from core.discord.client import make_bot
    r = await launch(tmp_path, monkeypatch, SMALL)
    cfg = Config.load(r.env)
    intake, other = make_bot(cfg, True), make_bot(cfg, False)
    assert intake.intents.message_content and intake.intents.members
    assert other.intents.guilds and not other.intents.message_content and not other.intents.members and not other.intents.dm_messages
    assert intake.allowed_mentions.everyone is False and other.allowed_mentions.everyone is False and not other.allowed_mentions.users
    for pid in ("tek", "fahsai"):
        names = sorted(n for n, _ in r.world.clients[r.uid(pid)].listeners)
        assert names == ["on_interaction", "on_ready"], (pid, names)
    assert "on_message" in [n for n, _ in r.world.clients[r.uid("praw")].listeners]
    await r.stop()


async def test_bot_level_crashing_job_does_not_stop_the_bot_ac9(tmp_path, monkeypatch):
    r = await launch(tmp_path, monkeypatch, SMALL, JOBS_ENABLE_SELFTEST="true", JOB_POLL_INTERVAL_S="0.2")
    await r.ctx.db.execute("INSERT INTO jobs (kind, payload, created_by, timeout_s) VALUES ('selftest_crash', '{}', 'acc', 30)")
    row = None
    for _ in range(100):
        row = await r.ctx.db.fetchrow("SELECT status, error FROM jobs WHERE kind='selftest_crash'")
        if row["status"] in ("failed", "done"):
            break
        await asyncio.sleep(0.1)
    assert row["status"] == "failed" and row["error"].startswith("signal"), dict(row)       # the worker really crashed
    await r.say(ALLOWED, "hello after the crash", to="praw")
    await settle(0.3)
    assert "reply from" in r.ch(ALLOWED).sent[-1].history[-1] and not r.task.done()          # bot still answers, still running
    assert await r.stop() == 0
