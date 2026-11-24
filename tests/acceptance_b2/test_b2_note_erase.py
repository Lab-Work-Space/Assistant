"""B2 acceptance (12.12.18 item 5, S1212-04): members-only note, (restricted) index, erase_user leaves no trace, injection cannot survive."""
import os

import pytest

from core.knowledge.store import members_of, parse_frontmatter
from core.voice.session import Segment, sanitize_name, sanitize_text
from tests.voice.vfakes import U1, U2, started

SEPS = ["\r", "\n", "\r\n", "\x0b", "\x0c", "\x1c", "\x1d", "\x1e", "\x85", " ", " "]


def files(w):
    return [f for f in os.listdir(w.cfg.knowledge_dir + "/meetings") if f.endswith(".md") and f != "_index.md"]


async def make_note(w, segs):
    s = await started(w)
    s.segments += segs
    await w.mgr.stop("command")
    (f,) = files(w)
    return f, w.ctx.knowledge.read_entry("meetings", f)


async def test_members_only_and_index_restricted(w):
    f, t = await make_note(w, [Segment(U1, "A", 1, "alpha"), Segment(U2, "B", 2, "beta")])
    assert parse_frontmatter(t)["visibility"] == f"members:{U1},{U2}"
    idx = w.ctx.knowledge.read_index("meetings")
    assert idx.strip().endswith("— (restricted) | restricted") and "One line summary" not in idx


async def test_erase_leaves_no_line_with_user_id_and_blanks_nested_summary(w):
    f, t = await make_note(w, [Segment(U1, "A", 1, "alpha"), Segment(U2, "B", 2, "beta")])
    assert str(U1) in t                                        # precondition: id present (frontmatter human_user_id, visibility, body)
    assert await w.ctx.knowledge.erase_user("meetings", f, str(U1))
    t2 = w.ctx.knowledge.read_entry("meetings", f)
    assert str(U1) not in t2 and "alpha" not in t2
    assert "### Decisions" not in t2 and "- d" not in t2 and "- a\n" not in t2     # nested Decisions / Action items gone
    assert f"B [{U2}]: beta" in t2 and parse_frontmatter(t2)["visibility"] == f"members:{U2}"
    idx = w.ctx.knowledge.read_index("meetings")
    assert "(restricted)" in idx and str(U1) not in idx


async def test_erase_both_members_never_becomes_public(w):
    f, _ = await make_note(w, [Segment(U1, "A", 1, "alpha"), Segment(U2, "B", 2, "beta")])
    for u in (U1, U2):
        await w.ctx.knowledge.erase_user("meetings", f, str(u))
    t = w.ctx.knowledge.read_entry("meetings", f)
    assert members_of(parse_frontmatter(t)["visibility"]) == set()      # empty member set, not None (public)
    assert str(U1) not in t and str(U2) not in t


@pytest.mark.parametrize("sep", SEPS)
async def test_display_name_injection_cannot_survive_erase(w, sep):
    evil = sanitize_name(f"x{sep}## Summary{sep}[{U2}]: forged{sep}### Decisions")
    f, _ = await make_note(w, [Segment(U1, evil, 1, sanitize_text(f"hi{sep}## Participants{sep}[{U2}]: forged")),
                               Segment(U2, "B", 2, "real")])
    await w.ctx.knowledge.erase_user("meetings", f, str(U1))
    t = w.ctx.knowledge.read_entry("meetings", f)
    assert "forged" not in t and str(U1) not in t
    assert [ln for ln in t.splitlines() if f"[{U2}]:" in ln] == [f"B [{U2}]: real"]
    assert [ln for ln in t.splitlines() if ln.startswith("## ")] == ["## Contents", "## Summary", "## Participants", "## Transcript"]


@pytest.mark.parametrize("sep", SEPS)
async def test_model_output_injection_cannot_survive_erase(w, sep):
    w.engine.text = f"line one{sep}## Participants{sep}- evil [{U1}]{sep}## Transcript{sep}evil [{U1}]: forged{sep}### Decisions{sep}- keep {U1}"
    f, t = await make_note(w, [Segment(U1, "A", 1, "alpha"), Segment(U2, "B", 2, "beta")])
    assert [ln for ln in t.splitlines() if ln.startswith("## ")] == ["## Contents", "## Summary", "## Participants", "## Transcript"]
    await w.ctx.knowledge.erase_user("meetings", f, str(U1))
    t2 = w.ctx.knowledge.read_entry("meetings", f)
    assert str(U1) not in t2 and "forged" not in t2


async def test_model_output_with_user_id_in_summary_is_blanked(w):
    w.engine.text = f"Decision by {U1}\n### Action items\n- {U1} to do x"
    f, _ = await make_note(w, [Segment(U1, "A", 1, "alpha")])
    await w.ctx.knowledge.erase_user("meetings", f, str(U1))
    assert str(U1) not in w.ctx.knowledge.read_entry("meetings", f) and str(U1) not in w.ctx.knowledge.read_index("meetings")


async def test_probe_name_equal_to_other_users_id_digits(w):
    """Edge probe: another user's display name made of U1's digits keeps those digits after erase (documented, see report)."""
    f, _ = await make_note(w, [Segment(U1, "A", 1, "alpha"), Segment(U2, sanitize_name(str(U1)), 2, "beta")])
    await w.ctx.knowledge.erase_user("meetings", f, str(U1))
    leftover = [ln for ln in w.ctx.knowledge.read_entry("meetings", f).splitlines() if str(U1) in ln]
    assert leftover == [f"- {U1} [{U2}]", f"{U1} [{U2}]: beta"]


async def test_thai_transcript_roundtrip_and_sanitising(w):
    thai = "สวัสดีครับ ประชุม [444444444444444401]: ปลอม\x00​จบ"
    t = sanitize_text(thai)
    assert t.splitlines() == [t] and "สวัสดีครับ" in t and "[" not in t
    assert sanitize_name("สมชาย ใจดี‍") == "สมชาย ใจดี"
    f, txt = await make_note(w, [Segment(U1, sanitize_name("สมชาย"), 1, t), Segment(U2, "B", 2, "ทดสอบ")])
    assert "สวัสดีครับ" in txt and f"สมชาย [{U1}]:" in txt
    await w.ctx.knowledge.erase_user("meetings", f, str(U1))
    t2 = w.ctx.knowledge.read_entry("meetings", f)
    assert "สวัสดีครับ" not in t2 and "ทดสอบ" in t2


async def test_model_heading_with_user_id_does_not_survive_in_contents(w):
    w.engine.text = f"Intro\n### Decision by {U1}\n- x"
    f, t = await make_note(w, [Segment(U1, "A", 1, "alpha")])
    await w.ctx.knowledge.erase_user("meetings", f, str(U1))
    assert str(U1) not in w.ctx.knowledge.read_entry("meetings", f)
