import logging

import pytest

from core.agents.persona import FilePersonaRegistry, PersonaError

FM = """---
id: {id}
name: {name}
aliases: {aliases}
role: r
dept: dd
model: gemini/gemini-3.8-flash
effort: medium
tools: ["*", "task_*"]
traits: [a]
color: "#F48FB1"
fragments: [{frag}]
{extra}---
body {id}
"""


def mk(root, id="praw", name="พราว", aliases='["พราว","praw"]', frag="delegation", extra="", folder="assistant"):
    d = root / folder
    d.mkdir(parents=True, exist_ok=True)
    (d / f"{name}.md").write_text(FM.format(id=id, name=name, aliases=aliases, frag=frag, extra=extra), encoding="utf-8")


@pytest.fixture
def root(tmp_path):
    (tmp_path / "_fragments").mkdir()
    (tmp_path / "_fragments" / "delegation.md").write_text("x")
    return tmp_path


def load(root):
    return FilePersonaRegistry.load(root, "praw", "google/cheap")


def test_loads_praw(root):
    mk(root)
    r = load(root)
    p = r.get("praw")
    assert p.name == "พราว" and p.cheap_model == "google/cheap" and p.color == 0xF48FB1 and p.avatar_url is None
    assert p.body.strip() == "body praw" and r.by_name(" พราว ") is p and r.by_name("nobody") is None


def test_real_praw_fixture_loads_after_task020_edits(root, tmp_path):
    # Praw.md today lacks id/aliases (TASK-020); refused with ERROR, then default_agent_missing aborts
    d = root / "assistant"
    d.mkdir()
    d.joinpath("Praw.md").write_text(open("prompts/assistant/Praw.md", encoding="utf-8").read(), encoding="utf-8")
    with pytest.raises(PersonaError, match="default_agent_missing"):
        load(root)


def test_alias_collision_aborts(root):
    mk(root)
    mk(root, id="hrx", name="Hanna", aliases='["PRAW "]', folder="hr")
    with pytest.raises(PersonaError, match="alias_collision"):
        load(root)


def test_alias_equals_other_name_aborts(root):
    mk(root)
    mk(root, id="hrx", name="Hanna", aliases='["พราว"]', folder="hr")
    with pytest.raises(PersonaError, match="alias_collision"):
        load(root)


def test_missing_fragment_refuses_persona(root, caplog):
    mk(root)
    mk(root, id="hrx", name="Hanna", aliases='["han"]', frag="nope", folder="hr")
    with caplog.at_level(logging.ERROR):
        r = load(root)
    assert r.get("hrx") is None and r.get("praw") and "fragment:nope" in caplog.text


def test_missing_default_aborts_when_fragment_missing(root):
    mk(root, frag="nope")
    with pytest.raises(PersonaError, match="default_agent_missing"):
        load(root)


@pytest.mark.parametrize("kw", [
    {"name": "Discord Bot"}, {"name": "my-CLYDE"}, {"id": "A"}, {"aliases": '["x"]'}, {"aliases": "[]"},
    {"extra": "model2: 1\ncolor: red\n"}, {"extra": "avatar: http://x/a.png\n"},
])
def test_rule_failures_refuse_persona(root, kw):
    mk(root)
    mk(root, **{"id": "oth", "name": "Other", "aliases": '["oth"]', "folder": "hr", **kw})
    assert load(root).get("oth") is None


def test_skips_underscore_and_zero_width_alias(root):
    mk(root)
    mk(root, id="_x", name="_Hidden", folder="_system")
    mk(root, id="hrx", name="Hanna", aliases='["pr​aw"]', folder="hr")
    with pytest.raises(PersonaError, match="alias_collision"):
        load(root)
