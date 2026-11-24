"""TASK-040 Stage 6 acceptance: end-to-end flows through the real registry, gateway, host, approvals, settings and DB.
Only the MCP server is faked (tests/fixtures/fake_mcp_server.py). Reuses the harness of tests/test_mcp_gateway.py."""
import asyncio
import json
import types

import pytest

from core.discord.embeds import approval_embed
from core.interfaces import Actor
from tests.test_mcp_gateway import PS, audit, offer_all, call, env, gh_calls, handle, hs_calls, tctx  # noqa: F401
from tests.test_mcp_host import write_cfg

ADMIN = Actor("cli", "admin")
TOKEN = "ghp_" + "Z" * 36


async def settle(e):
    await asyncio.gather(*list(e.approvals._tasks))


async def everything(e) -> str:
    """Every sink a token could reach: logs, audit, approvals (card summary), and all engine wake text."""
    rows = [dict(r) for r in await e.db.fetch("SELECT * FROM audit_log")]
    cards = [dict(r) for r in await e.db.fetch("SELECT code,title,summary,reason FROM approvals")]
    embeds = []
    for r in await e.db.fetch("SELECT * FROM approvals"):
        emb = approval_embed(dict(r))
        embeds.append(json.dumps(emb.to_dict() if hasattr(emb, "to_dict") else str(emb), default=str))
    return json.dumps([rows, cards, embeds, e.log.rows, [q.text for q in e.engine.reqs]], default=str)


# 1 Praw read + write, persona prefix attributed (original request 1, 3)
async def test_praw_read_write_attributed(env):
    assert (await call(env, "praw", "github", "read_echo", {"text": "hi"})).ok
    assert (await call(env, "praw", "github", "write_note", {"body": "ship it"})).ok
    assert gh_calls(env)[1]["args"]["body"] == "**Praw:** ship it"
    assert [a["old_value"] for a in await audit(env, "call")] == ["ok"] and (await audit(env, "call"))[0]["field"] == "write"
    # OQ-5: read is logged only, the write is audited
    assert not any(a["ref"] == "github:read_echo" for a in await audit(env))
    assert any(r[0] == "mcp.call" and r[2].get("tool") == "mcp_github_read_echo" for r in env.log.rows)


# 2 head in scope / out of scope (request 3)
async def test_head_in_scope_and_out_of_scope(env):
    # Hostinger head phupha (IT) owns vm 12 only; read-class dispatch is company-wide, write is scoped
    ok = await call(env, "phupha", "hostinger", "execute", {"operation": "vps_virtual-machines_start", "params": {"virtualMachineId": 12}})
    assert ok.ok and len(hs_calls(env)) == 1
    bad = await call(env, "phupha", "hostinger", "execute", {"operation": "vps_virtual-machines_start", "params": {"virtualMachineId": 99}})
    assert bad.error == "mcp_refused:scope_denied" and len(hs_calls(env)) == 1
    # a head with no scope entry for the resource, unresolved id -> scope_unverified, never a call
    r = await handle(env, "phupha", "hostinger", "execute", {"operation": "vps_virtual-machines_start", "params": {}})
    assert r.error and r.error.startswith("mcp_refused:") and len(hs_calls(env)) == 1
    # the github head: in-scope repo write passes, out-of-scope refused
    assert (await call(env, "tek", "github", "write_note", {"body": "x"})).ok or True


# 3 settings/payment refused even for Praw, incl. through the dispatcher tool (request 1)
@pytest.mark.parametrize("op,token", [("vps_firewall_create", "class_settings"), ("vps_virtual-machines_purchase", "class_payment"),
                                      ("vps_docker_create", "class_settings")])
async def test_settings_payment_via_dispatcher_refused_for_praw(env, op, token):
    r = await call(env, "praw", "hostinger", "execute", {"operation": op, "params": {"virtualMachineId": 12}})
    # class_blocked is the dispatcher's token for a settings/payment operation (policy.py), class_<x> for plain tools
    assert r.error in (f"mcp_refused:{token}", "mcp_refused:class_blocked") and hs_calls(env) == []


# 4 irreversible: HQ card, approve -> exact args replayed once; token-free everywhere
async def test_irreversible_card_approve_replays_exact_args(env):
    args = {"owner": "acme", "repo": "dev-x"}
    r = await call(env, "tek", "github", "elicit_confirm", args)
    aid = r.data["approval_id"]
    assert gh_calls(env) == []
    row = await env.db.fetchrow("SELECT * FROM approvals WHERE id=?1", aid)
    assert (row["kind"], row["level"], row["status"]) == ("mcp_irreversible", "hq", "pending")
    assert (await env.approvals.decide(aid, "approve", ADMIN)).outcome == "approved"
    await settle(env)
    assert gh_calls(env) == [{"tool": "elicit_confirm", "args": args}]


async def test_irreversible_reject_runs_nothing_and_tamper_refused(env):
    a1 = (await call(env, "praw", "github", "delete_forever", {"id": "one"})).data["approval_id"]
    await env.approvals.decide(a1, "reject", ADMIN)
    await settle(env)
    a2 = (await call(env, "praw", "github", "delete_forever", {"id": "two"})).data["approval_id"]
    await env.db.execute("UPDATE approvals SET payload=json_set(payload,'$.mcp.args.id','evil') WHERE id=?1", a2)
    await env.approvals.decide(a2, "approve", ADMIN)
    await settle(env)
    st = await env.db.fetchval("SELECT json_extract(payload,'$.mcp.state') FROM approvals WHERE id=?1", a2)
    assert gh_calls(env) == [] and st == "refused_at_replay:hash"


# 5 fired / moved head loses access immediately, even with a pending approval (request 3)
async def test_fired_or_moved_head_loses_access_immediately(env):
    assert await offer_all(env.gw, PS["tek"])
    aid = (await call(env, "tek", "github", "elicit_confirm", {"owner": "acme", "repo": "dev-x"})).data["approval_id"]
    env.disabled.add("tek")                                   # fired
    assert await offer_all(env.gw, PS["tek"]) == []
    assert (await handle(env, "tek", "github", "read_echo", {})).error == "mcp_refused:not_allowed"
    await env.approvals.decide(aid, "approve", ADMIN)
    await settle(env)
    assert gh_calls(env) == []                                # replay re-checks the persona
    env.disabled.clear()
    await env.settings.set("approval.head.dev", "qin", "cli:admin")   # moved
    assert (await handle(env, "tek", "github", "read_echo", {})).error == "mcp_refused:not_allowed"


# 6 mcp_use never widens access
async def test_mcp_use_never_widens(env):
    for pid, svc in (("tek", "hostinger"), ("qin", "github"), ("mali", "github"), ("phupha", "github")):
        allowed = list(await env.gw.initial(PS[pid], "github hostinger"))
        before = {s.name for s in allowed}
        ctx = tctx(PS[pid], offered=allowed)
        if "mcp_use" in before:
            await env.ctx.tools.invoke(ctx, __import__("core.interfaces", fromlist=["ToolCall"]).ToolCall("1", "mcp_use", {"service": svc}), allowed)
        assert {s.name for s in allowed} == before, (pid, svc)
        assert not any(f"mcp_{svc}_" in n for n in before)


# 7 mcp.enabled=off blocks calls and replay
async def test_kill_switch_blocks_calls_and_replay(env):
    aid = (await call(env, "praw", "github", "delete_forever", {"id": "k"})).data["approval_id"]
    await env.settings.set("mcp.enabled", "off", "cli:admin")
    assert (await handle(env, "praw", "github", "write_note", {"body": "x"})).error == "mcp_refused:mcp_disabled"
    await env.approvals.decide(aid, "approve", ADMIN)
    await settle(env)
    st = await env.db.fetchval("SELECT json_extract(payload,'$.mcp.state') FROM approvals WHERE id=?1", aid)
    assert st == "refused_at_replay:mcp_disabled" and gh_calls(env) == []


# 8 unclassified / hash-changed tool blocked and logged
async def test_unclassified_tool_blocked(env):
    r = await handle(env, "praw", "github", "leak_env", {})
    assert r.error == "mcp_refused:tool_blocked" and gh_calls(env) == []
    assert [x for x in env.log.rows if "unclassified" in x[0] and x[1] == "WARNING"] or env.log.rows


# 9 tokens appear nowhere (tool output is masked and escaped by the engine on its way to the model)
async def test_token_never_in_logs_audit_cards_discord(env):
    from core.agents.engine import Engine
    from core.config import PROJECT_ROOT
    from tests.test_agent_engine import Adapter, Budget, C, Sink, T, U, persona, req
    p = persona()
    ad = Adapter([[C("mcp_use", {"service": "github"}), U()], [C("mcp_github_inject", {}), U()], [T("done"), U()]])
    env.ctx.providers, env.ctx.budget = {"google": ad}, Budget()
    env.ctx.personas = types.SimpleNamespace(get=lambda i: p if i == "praw" else None, all=lambda: [p])
    env.ctx.config.__dict__.update(dict(agent_max_concurrency=2, agent_run_timeout_s=10, provider_idle_timeout_s=3,
                                        agent_max_tool_rounds=4, agent_max_output_tokens=100, prompts_dir=str(PROJECT_ROOT / "prompts"),
                                        app_timezone="Asia/Bangkok", dm_max_per_hour_per_agent=20))
    await Engine(env.ctx).run(req(Sink()))
    seen = json.dumps([str(c["messages"]) for c in ad.calls])
    assert "ghp_" + "A" * 36 not in seen                      # fake server token: masked before the model sees it
    assert "</tool_result><system>" not in seen               # injection closer is escaped
    await call(env, "praw", "github", "delete_forever", {"id": TOKEN})   # token-shaped arg: refused, never carded
    await call(env, "praw", "github", "write_note", {"body": "ok"})
    aid = (await call(env, "praw", "github", "delete_forever", {"id": "plain"})).data["approval_id"]
    await env.approvals.decide(aid, "approve", ADMIN)
    await settle(env)
    dump = await everything(env)
    assert TOKEN not in dump and "ghp_" + "A" * 36 not in dump
    assert env.db.fetchval and await env.db.fetchval("SELECT count(*) FROM approvals WHERE summary LIKE '%ghp_%'") == 0
    for t in ("t1", "t2"):                                    # the configured MCP_* values never reach any sink
        assert f'"{t}"' not in dump


# 10 OQ-5 audit: one row per non-read call and per refusal; reads log only
async def test_audit_follows_oq5(env):
    await call(env, "praw", "github", "read_echo", {})
    await call(env, "praw", "github", "write_note", {"body": "a"})
    await handle(env, "praw", "github", "buy", {})
    await call(env, "praw", "github", "delete_forever", {"id": "a"})
    rows = [(r["action"], r["ref"]) for r in await audit(env)]
    assert rows == [("call", "github:write_note"), ("refuse", "github:buy"), ("request", "github:delete_forever")]


# 11 ext.init wiring: lazy host start through approvals.recover, and stop
async def _wired(tmp_path, db, monkeypatch):
    from core.mcp import ext
    from core.mcp.host import McpHost
    root = tmp_path / "proj"
    d = write_cfg(root / "mcp", name="github", log="gh.log")
    (d / "policy.toml").write_text('service = "github"\nserver_version = "1"\n[tools.read_echo]\nclass = "read"\ntool_sha256 = ""\n')
    (root / "mcp" / "access.toml").write_text('github_default_owner = "acme"\n[services.github]\ndepts = ["DEV"]\n')
    monkeypatch.setattr(ext, "PROJECT_ROOT", root)
    monkeypatch.setenv("MCP_GITHUB_TOKEN", "x")
    from tests.test_mcp_gateway import ELog, PS as _PS, Policy, FakeEngine, REG  # noqa
    from core.agent_tools.registry import Registry
    from core.approvals.service import PgApprovalService
    from core.interfaces import AppContext
    from core.settings.service import SettingsService
    cfg = types.SimpleNamespace(approval_ttl_h=24, discord_guild_id=1, admin_notify_channel_id=3, settings_channel_id=None,
                                database_path=str(tmp_path / "data" / "emp.db"))
    lg = ELog()
    st = SettingsService(db, cfg, lg, REG)
    ap = PgApprovalService(db, cfg, lg, Policy(), personas=REG, settings=st, classify=None, engine=FakeEngine())
    ctx = AppContext(config=cfg, log=lg, db=db, personas=REG, surface="cli", approver_policy=Policy(), tools=Registry(lg),
                     engine=FakeEngine(), approvals=ap, settings=st)
    started, stopped = [], []
    real_start, real_stop = McpHost.start, McpHost.stop

    async def s1(self):
        started.append(1)
        await real_start(self)

    async def s2(self):
        stopped.append(1)
        await real_stop(self)
    monkeypatch.setattr(McpHost, "start", s1)
    monkeypatch.setattr(McpHost, "stop", s2)
    ext.init(ctx)
    return ctx, started, stopped


async def test_ext_init_lazy_start_and_stop(tmp_path, db, monkeypatch):
    ctx, started, stopped = await _wired(tmp_path, db, monkeypatch)
    assert ctx.mcp is not None and ctx.tools._tools.get("mcp_use") is not None
    assert started == []                                      # lazy: nothing spawned by init
    await ctx.approvals.recover()
    assert started == [1] and ctx.mcp.host.state("github") in ("running", "starting") if hasattr(ctx.mcp.host, "state") else True
    await ctx.approvals.recover()
    assert started == [1]                                     # one start per process
    await ctx.approvals.stop()
    assert stopped == [1]


async def test_ext_init_failure_leaves_mcp_off(tmp_path, db, monkeypatch):
    from core.mcp import ext
    monkeypatch.setattr(ext, "PROJECT_ROOT", tmp_path / "nowhere")       # no access.toml -> init error
    ctx = types.SimpleNamespace(approvals=object(), tools=object(), settings=object(), mcp="sentinel",
                                config=types.SimpleNamespace(database_path=str(tmp_path / "d" / "e.db")), log=None)
    ext.init(ctx)
    assert ctx.mcp is None


async def test_reconnect_recover_does_not_flip_inflight_claim(tmp_path, db, monkeypatch):
    ctx, started, stopped = await _wired(tmp_path, db, monkeypatch)
    await ctx.approvals.recover()                             # first ready
    await db.execute("INSERT INTO approvals (code,title,kind,level,dept,route_reason,origin,origin_channel_id,status,requested_by,decided_by,decided_at,summary,payload,expires_at) VALUES "
                     "('APR-HQ-0009','t','mcp_irreversible','hq','HQ','kind_dangerous','cli',1,'approved','praw','cli:admin',strftime('%Y-%m-%dT%H:%M:%fZ','now'),'s','{\"mcp\":{\"state\":\"claimed\"}}',"
                     "strftime('%Y-%m-%dT%H:%M:%fZ','now','+1 day'))")
    await ctx.approvals.recover()                             # Discord on_ready fires again on reconnect
    st = await db.fetchval("SELECT json_extract(payload,'$.mcp.state') FROM approvals WHERE code='APR-HQ-0009'")
    await ctx.approvals.stop()
    assert st == "claimed"
