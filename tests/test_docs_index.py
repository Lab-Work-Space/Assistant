"""Owner rule (2026-11-23): every docs folder has an _index.md listing all its docs,
and every doc over 150 lines starts with a Contents section."""
from pathlib import Path

DOCS = Path(__file__).resolve().parents[1] / "docs"
LONG = 150


def _folders():
    return [DOCS, *(p for p in DOCS.rglob("*") if p.is_dir())]


def test_every_docs_folder_has_index_listing_all_files():
    problems = []
    for d in _folders():
        idx = d / "_index.md"
        if not idx.is_file():
            problems.append(f"missing {idx.relative_to(DOCS)}")
            continue
        text = idx.read_text(encoding="utf-8")
        for f in d.glob("*.md"):
            if f.name != "_index.md" and f"({f.name})" not in text:
                problems.append(f"unlisted {f.relative_to(DOCS)}")
    assert not problems, problems


def test_long_docs_have_contents():
    missing = [str(f.relative_to(DOCS)) for f in DOCS.rglob("*.md")
               if f.name != "_index.md"
               and len(f.read_text(encoding="utf-8").splitlines()) > LONG
               and "\n## Contents" not in f.read_text(encoding="utf-8")]
    assert not missing, missing


def test_contents_line_numbers_point_at_headings():
    import re
    stale = []
    for f in DOCS.rglob("*.md"):
        lines = f.read_text(encoding="utf-8").splitlines()
        for ln in lines:
            m = re.search(r"— L(\d+)\s*$", ln)
            if m and (int(m.group(1)) > len(lines) or not lines[int(m.group(1)) - 1].startswith("#")):
                stale.append(f"{f.relative_to(DOCS)}: {ln.strip()[:60]}")
    assert not stale, stale  # regenerate the Contents block after editing the doc
