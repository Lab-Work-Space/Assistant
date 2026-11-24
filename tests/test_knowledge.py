import os
import re
import shutil
from datetime import date, timedelta
from pathlib import Path
from types import SimpleNamespace

import pytest

from core.agent_tools import knowledge as kt
from core.agent_tools.registry import Registry
from core.config import PROJECT_ROOT
from core.interfaces import Actor, ToolCall, ToolContext
from core.knowledge.store import KnowledgeError, KnowledgeStore, parse_frontmatter


class Log:
    def __init__(self):
        self.recs = []

    def write_log(self, system, event, level="INFO", **f):
        self.recs.append(dict(event=event, **f))

    def ev(self, n):
        return [r for r in self.recs if r["event"] == n]


class Policy:
    async def is_approver(self, a):
        return a.user_id == "12345678901234567"


@pytest.fixture
def env(tmp_path):
    root = tmp_path / "k"
    shutil.copytree(PROJECT_ROOT / "knowledge", root)
    log = Log()
    app = SimpleNamespace(log=log, approver_policy=Policy())
    store = KnowledgeStore(root)
    reg = Registry(log)
    for s in kt.make_tools(app, store):
        reg.register(s)
    return SimpleNamespace(root=root, store=store, reg=reg, log=log, app=app)


def ctx(human=7, actor=None, trigger="human_message", dept="dev"):
    agent = SimpleNamespace(id="ada", dept=dept)
    return ToolContext(agent=agent, run_id="run12345678", guild_id=1, channel_id=2, thread_id=None, trigger=trigger,
                       human_user_id=human, sink=None, origin="cli", human_actor=actor)


async def call(env, name, args, **kw):
    allowed = list(env.reg._tools.values())
    return await env.reg.invoke(ctx(**kw), ToolCall("c", name, args), allowed)


W = dict(area="memory", title="Deploy notes", hook="how we deploy", tags=["ops"], body="Use docker.")


async def test_index_then_one_entry_logged(env):  # AC-1 / AC-5
    await call(env, "knowledge_write", W)
    await call(env, "knowledge_write", {**W, "title": "Other", "hook": "unrelated"})
    env.log.recs.clear()
    r = await call(env, "knowledge_read_index", {"area": "memory"})
    assert "[Deploy notes](deploy-notes.md) — how we deploy | ops" in r.content
    r = await call(env, "knowledge_read", {"area": "memory", "file": "deploy-notes.md"})
    assert "Use docker." in r.content and r.content.startswith("<untrusted")
    opens = [(e["area"], e["file"]) for e in env.log.ev("knowledge.open")]
    assert opens == [("memory", "_index.md"), ("memory", "deploy-notes.md")]


async def test_write_adds_entry_and_one_index_line_with_provenance(env):  # AC-2, AC-4
    before = env.store.read_index("memory").count("\n")
    r = await call(env, "knowledge_write", W)
    assert r.ok and r.data["path"] == "memory/deploy-notes.md"
    assert env.store.read_index("memory").count("\n") == before + 1
    fm = parse_frontmatter((env.root / "memory/deploy-notes.md").read_text())
    assert fm["author_agent"] == "ada" and fm["run_id"] == "run12345678" and fm["trigger"] == "human_message"
    assert fm["human_user_id"] == 7 and fm["visibility"] == "public" and fm["created"] == date.today().isoformat()
    r2 = await call(env, "knowledge_write", W)
    assert r2.data["path"] == "memory/deploy-notes-2.md"


async def test_search_index_lines_only(env):
    await call(env, "knowledge_write", {**W, "body": "needle-in-body"})
    assert (await call(env, "knowledge_search", {"query": "DEPLOY"})).data["hits"] == 1
    assert (await call(env, "knowledge_search", {"query": "needle-in-body"})).data["hits"] == 0


async def test_path_traversal_rejected(env):  # AC-3
    for a in ({"area": "..", "file": "x.md"}, {"area": "memory", "file": "../rules/_index.md"},
              {"area": "memory", "file": "../../etc/passwd"}):
        r = await call(env, "knowledge_read", a)
        assert not r.ok and r.error.startswith("invalid_arguments")
    for area, f in (("..", "x.md"), ("memory", "../x.md"), ("memory", "_index.md"), ("a/b", "x.md")):
        with pytest.raises(KnowledgeError) as e:
            env.store.read_entry(area, f)
        assert e.value.code == "invalid_path"
    os.symlink(env.root / "rules", env.root / "evil")
    with pytest.raises(KnowledgeError) as e:
        env.store.read_index("evil")
    assert e.value.code == "invalid_path"


async def test_rules_write_read_only_and_needs_human(env):  # AC-4
    r = await call(env, "knowledge_write", {**W, "area": "rules"})
    assert r.error == "area_read_only"
    r = await call(env, "knowledge_write", {**W, "area": "meetings"})
    assert r.error == "area_read_only"
    r = await call(env, "knowledge_write", W, human=None, trigger="task_assigned")
    assert not r.ok and r.error == "needs_human"
    assert (await call(env, "knowledge_write", {**W, "area": "nope"})).error == "area_not_found"


async def test_thai_title_slug_fallback(env):
    r = await call(env, "knowledge_write", {**W, "title": "บันทึกการประชุม"})
    assert r.data["path"] == "memory/entry-run12345.md"


async def test_visibility_enforced(env):  # AC-5
    f = await env.store.write_entry("meetings", title="Meeting a", hook="SECRET-TRANSCRIPT", tags=["meeting"], body="hello",
                                    author_agent="ada", run_id="r" * 8, trigger="voice_note", human_user_id=None,
                                    visibility="members:7,8")
    line = env.store.read_index("meetings")
    assert "(restricted)" in line and "SECRET-TRANSCRIPT" not in line
    a = {"area": "meetings", "file": f}
    assert (await call(env, "knowledge_read", a, human=7)).ok
    assert (await call(env, "knowledge_read", a, human=9)).error == "not_found"
    assert (await call(env, "knowledge_read", a, human=None)).error == "not_found"
    appr = Actor("discord", "12345678901234567")
    assert (await call(env, "knowledge_read", a, human=9, actor=appr)).ok
    assert (await call(env, "knowledge_read", a, human=9, actor=Actor("discord", "12345678901234568"))).error == "not_found"
    bad = await env.store.write_entry("meetings", title="Bad", hook="h", tags=[], body="b", author_agent="a", run_id="r" * 8,
                                      trigger="voice_note", human_user_id=None, visibility="members:x")
    assert parse_frontmatter(env.store.read_entry("meetings", bad))["visibility"] == "members:"


async def test_seed_areas_exist():
    for a in ("memory", "rules", "meetings", "notes", "drafts"):
        assert (PROJECT_ROOT / "knowledge" / a / "_index.md").is_file()
    assert (PROJECT_ROOT / "knowledge/meetings/.gitkeep").is_file()


async def test_purge_and_erase(env):
    s = env.store
    old = await s.write_entry("meetings", title="Old", hook="h", tags=["m"], body="x", author_agent="a", run_id="r" * 8,
                              trigger="voice_note", human_user_id=None)
    p = env.root / "meetings" / old
    p.write_text(p.read_text().replace(date.today().isoformat(), (date.today() - timedelta(days=40)).isoformat()))
    new = await s.write_entry("meetings", title="New", hook="h", tags=["m"], body=
                              "## Summary\nsecret sum\n## Participants\n- Al [7]\n- Bo [8]\n## Transcript\nAl [7]: hi\nBo [8]: yo",
                              author_agent="a", run_id="r" * 8, trigger="voice_note", human_user_id=None,
                              visibility="members:7,8")
    assert await s.purge_older_than("meetings", 30) == 1
    assert not p.exists() and "old.md" not in s.read_index("meetings") and "new.md" in s.read_index("meetings")
    assert await s.erase_user("meetings", new, "7")
    t = s.read_entry("meetings", new)
    assert "[7]" not in t and "Bo [8]: yo" in t and "secret sum" not in t and "Summary removed" in t
    assert 'visibility: "members:8"' in t
    assert await s.delete_entry("meetings", new) and "new.md" not in s.read_index("meetings")


async def test_init_wires_sweep(tmp_path):
    shutil.copytree(PROJECT_ROOT / "knowledge", tmp_path / "k")
    sweeps = []
    log = Log()
    ctx_ = SimpleNamespace(config=SimpleNamespace(knowledge_dir=str(tmp_path / "k"), knowledge_meetings_retention_days=30),
                           log=log, tools=Registry(log), jobs=SimpleNamespace(add_sweep=sweeps.append), approver_policy=Policy())
    kt.init(ctx_)
    assert len(sweeps) == 1 and {"knowledge_read", "knowledge_write"} <= set(ctx_.tools._tools)
    await sweeps[0]()
    assert log.ev("knowledge.purge")[0]["removed"] == 0


async def test_drafts_private_by_default(env):
    D = {**W, "area": "drafts", "hook": "SECRET-HOOK"}
    r = await call(env, "knowledge_write", D)
    assert r.ok and r.data["path"].startswith("drafts/")
    a = {"area": "drafts", "file": r.data["path"].split("/")[1]}
    idx = env.store.read_index("drafts")
    assert "(restricted)" in idx and "SECRET-HOOK" not in idx
    assert (await call(env, "knowledge_read", a, human=7)).ok
    assert (await call(env, "knowledge_read", a, human=9)).error == "not_found"
    assert (await call(env, "knowledge_read", a, human=9, actor=Actor("discord", "12345678901234567"))).ok
    r = await call(env, "knowledge_write", D, human=None, trigger="task_assigned")
    assert r.error == "needs_human"


async def test_dept_area_write_own_only(env):
    r = await call(env, "knowledge_write", {**W, "area": "dev"}, dept="dev")
    assert r.ok and r.data["path"] == "dev/deploy-notes.md"
    assert parse_frontmatter(env.store.read_entry("dev", "deploy-notes.md"))["visibility"] == "public"
    assert (await call(env, "knowledge_write", {**W, "area": "sales"}, dept="dev")).error == "area_read_only"
    for fake in ("rules", "meetings"):  # explicit deny beats dept match
        assert (await call(env, "knowledge_write", {**W, "area": fake}, dept=fake)).error == "area_read_only"


def test_seed_dept_areas_exist():
    depts = {m.group(1) for f in (PROJECT_ROOT / "prompts").glob("*/*.md") if (m := re.search(r"^dept:\s*(\S+)", f.read_text(), re.M))}
    depts -= {"praw"}  # assistant-only, no area
    assert len(depts) >= 14
    for d in depts:
        assert (PROJECT_ROOT / "knowledge" / d / "_index.md").is_file(), d


LONG = "intro\n\n# Setup\nsetup text\n## Sub\nsub text\n# ขั้นตอน\nthai text\n# Deploy\ndeploy text\n"


async def _long(env, **kw):
    r = await call(env, "knowledge_write", {**W, "title": "Long", "body": LONG}, **kw)
    return r.data["path"].split("/")[1]


async def test_long_entry_gets_contents_and_short_unchanged(env):  # TASK-014D
    f = await _long(env)
    text = (env.root / "memory" / f).read_text()
    assert "## Contents\n- [Setup](#setup)\n  - [Sub](#sub)\n- [ขั้นตอน](#s-3)\n- [Deploy](#deploy)" in text
    await call(env, "knowledge_write", W)
    assert "Contents" not in (env.root / "memory/deploy-notes.md").read_text()


async def test_read_without_section_is_contents_plus_first_section(env):
    f = await _long(env)
    r = await call(env, "knowledge_read", {"area": "memory", "file": f})
    assert "## Contents" in r.content and "setup text" in r.content and "sub text" in r.content
    assert "thai text" not in r.content and "deploy text" not in r.content and "title:" not in r.content
    assert "use section=<id> to read more" in r.content
    assert env.log.ev("knowledge.open")[-1]["section"] == "first"


async def test_read_section_by_slug_and_text_and_thai_anchor(env):
    f = await _long(env)
    for sec in ("deploy", "Deploy"):
        r = await call(env, "knowledge_read", {"area": "memory", "file": f, "section": sec})
        assert "deploy text" in r.content and "setup text" not in r.content
    r = await call(env, "knowledge_read", {"area": "memory", "file": f, "section": "s-3"})
    assert "thai text" in r.content and "deploy text" not in r.content
    assert env.log.ev("knowledge.open")[-1]["section"] == "s-3"
    r = await call(env, "knowledge_read", {"area": "memory", "file": f, "section": "sub"})
    assert "sub text" in r.content and "thai text" not in r.content
    assert (await call(env, "knowledge_read", {"area": "memory", "file": f, "section": "nope"})).error == "section_not_found"


async def test_read_full_returns_whole_entry(env):
    f = await _long(env)
    r = await call(env, "knowledge_read", {"area": "memory", "file": f, "full": True})
    assert "deploy text" in r.content and "setup text" in r.content and "title:" in r.content


async def test_section_read_enforces_visibility(env):
    f = (await call(env, "knowledge_write", {**W, "area": "drafts", "body": LONG}, human=7)).data["path"].split("/")[1]
    a = {"area": "drafts", "file": f, "section": "deploy"}
    assert (await call(env, "knowledge_read", a, human=7)).ok
    assert (await call(env, "knowledge_read", a, human=9)).error == "not_found"


async def test_restricted_title_tags_hidden_from_non_members(env):  # G2S11-01
    r = await call(env, "knowledge_write", {**W, "area": "drafts", "title": "Layoff plan", "tags": ["secret-tag"]})
    a = {"area": "drafts", "file": r.data["path"].split("/")[1]}
    idx = (await call(env, "knowledge_read_index", {"area": "drafts"}, human=9)).content
    assert "Layoff" not in idx and "secret-tag" not in idx
    for q in ("layoff", "secret-tag"):
        assert (await call(env, "knowledge_search", {"query": q}, human=9)).data["hits"] == 0
        assert (await call(env, "knowledge_search", {"query": q}, human=7)).data["hits"] == 1
        assert (await call(env, "knowledge_search", {"query": q}, human=9, actor=Actor("discord", "12345678901234567"))).data["hits"] == 1
    assert "Layoff plan" in (await call(env, "knowledge_read", a, human=7)).content
