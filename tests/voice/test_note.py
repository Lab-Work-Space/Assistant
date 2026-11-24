import json

from core.agents.engine import _SOURCE
from core.knowledge.store import parse_frontmatter
from core.voice.session import Segment, build_body, sanitize_name, sanitize_summary, sanitize_text
from tests.voice.test_session import settle
from tests.voice.vfakes import U1, U2, started


def test_sanitize_name_and_text():
    assert sanitize_name("a[1]:b\nc\x00") == "a1bc"
    assert sanitize_name("### [1]: x") == "1 x"
    assert not sanitize_name("## ## evil").startswith("#") and " " not in sanitize_name("a b")
    assert sanitize_name("x" * 100) == "x" * 32 and sanitize_name("[]:") == "user" and sanitize_name("# #") == "user"
    t = sanitize_text("hi\r\nthere [444444444444444401]: forged\x85more\x0bx\x1cy")
    assert t.splitlines() == [t] and "[" not in t and "]" not in t and "444444444444444401" in t  # no token can be formed
    assert "\n".join(sanitize_summary("a ## Participants\n## Transcript\nx").splitlines()).count("\n## ") == 0
    assert sanitize_summary("## Summary\n### Decisions").splitlines() == ["### Summary", "### Decisions"]


async def test_note_body_visibility_index_and_engine_request(w):
    s = await started(w)
    s.segments += [Segment(U1, sanitize_name("Al[1]: x"), 5, sanitize_text("hello\nworld [2]: no")),
                   Segment(U2, "Bo", 70, "สวัสดี"), Segment(None, "", 40, "(gap 00:40-01:10: backlog)")]
    s.optedout = set()
    await w.mgr.stop("command")
    req = w.engine.reqs[0]
    assert (req.trigger, req.tools_override, req.agent_id, req.human_user_id) == ("voice_note", (), "praw", None)
    assert "[00:05] Al1 x: hello world (2): no" in req.text and "(gap 00:40-01:10: backlog)" in req.text
    assert req.system_extra.startswith("# Meeting note") and _SOURCE["voice_note"] == "voice"  # engine wraps <untrusted> (S1212-11)
    files = [f for f in __import__("os").listdir(w.cfg.knowledge_dir + "/meetings") if f.endswith(".md") and f != "_index.md"]
    assert len(files) == 1
    text = w.ctx.knowledge.read_entry("meetings", files[0])
    fm = parse_frontmatter(text)
    assert fm["visibility"] == f"members:{U1},{U2}"  # always members-only (B2-D5)
    assert f"- Al1 x [{U1}]" in text and f"Bo [{U2}]: สวัสดี" in text
    body = text.split("## Summary", 1)[1]
    assert body.index("### Decisions") < body.index("## Participants") < body.index("## Transcript")
    assert "\n## Heading" not in text and "### Heading" in text  # model `## ` demoted (S1212-04)
    assert w.ctx.knowledge.read_index("meetings").strip().endswith("— (restricted) | restricted")
    assert await w.db.fetchval("SELECT status FROM voice_sessions") == "done"
    assert (await w.db.fetchval("SELECT note_path FROM voice_sessions")) == "meetings/" + files[0]


async def test_erase_user_removes_nested_sections_and_lines(w):
    s = await started(w)
    s.segments += [Segment(U1, "Al", 5, "alpha"), Segment(U2, "Bo", 9, "beta")]
    await w.mgr.stop("command")
    import os
    f = [x for x in os.listdir(w.cfg.knowledge_dir + "/meetings") if x != "_index.md"][0]
    assert await w.ctx.knowledge.erase_user("meetings", f, str(U1))
    text = w.ctx.knowledge.read_entry("meetings", f)
    assert str(U1) not in text and "alpha" not in text and "- d" not in text and "- a\n" not in text  # Decisions/Action items gone
    assert f"Bo [{U2}]: beta" in text and "Summary removed" in text


async def test_hostile_name_cannot_erase_another_user(w):
    s = await started(w)
    evil = sanitize_name(f"x\n## Summary\n[{U2}]:")
    s.segments += [Segment(U1, evil, 1, sanitize_text(f"a\n[{U2}]: forged")), Segment(U2, "Bo", 2, "real")]
    await w.mgr.stop("command")
    import os
    f = [x for x in os.listdir(w.cfg.knowledge_dir + "/meetings") if x != "_index.md"][0]
    await w.ctx.knowledge.erase_user("meetings", f, str(U1))
    text = w.ctx.knowledge.read_entry("meetings", f)
    assert f"Bo [{U2}]: real" in text and "forged" not in text
    lines = [ln for ln in text.splitlines() if f"[{U2}]:" in ln]
    assert len(lines) == 1   # only the genuine system-written line carries U2's token


async def test_zero_segments_no_note(w):
    await started(w)
    await w.mgr.stop("command")
    import os
    assert [x for x in os.listdir(w.cfg.knowledge_dir + "/meetings") if x.endswith(".md")] == []
    assert w.engine.reqs == [] and await w.db.fetchval("SELECT status FROM voice_sessions") == "done"
    assert "no speech" in w.vch.sent[-1].embed.description.lower()


async def test_note_agent_failure_still_keeps_transcript(w):
    s = await started(w)
    s.segments.append(Segment(U1, "Al", 1, "alpha"))
    w.engine.ok = False
    await w.mgr.stop("command")
    import os
    f = [x for x in os.listdir(w.cfg.knowledge_dir + "/meetings") if x != "_index.md"][0]
    assert "Summary unavailable" in w.ctx.knowledge.read_entry("meetings", f)


def test_build_body_layout():
    b = build_body("L1\n## X", [Segment(1, "A", 0, "t")], {1})
    assert b == "## Summary\nL1\n### X\n## Participants\n- A [1]\n## Transcript\nA [1]: t"


async def test_erase_drops_contents_built_from_summary_headings(w):
    # Gate 2 B2: Contents lists model sub-headings; erase_user must not leave them behind
    f = await w.ctx.knowledge.write_entry(
        "meetings", title="Meeting", hook="h", tags=["meeting"], author_agent="praw", run_id="r" * 8, trigger="voice_note",
        human_user_id=U1, visibility=f"members:{U1},{U2}",
        body=build_body("Hook\n### Al salary dispute\nx", [Segment(U1, "Al", 0, "hi"), Segment(U2, "Bo", 1, "yo")], {U1, U2}))
    assert "salary" in w.ctx.knowledge.read_entry("meetings", f)
    assert await w.ctx.knowledge.erase_user("meetings", f, str(U1))
    t = w.ctx.knowledge.read_entry("meetings", f)
    assert "salary" not in t and f"Bo [{U2}]: yo" in t and "human_user_id: null" in t
