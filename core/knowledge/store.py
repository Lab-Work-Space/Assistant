"""Index-first knowledge store (spec 3.9 as amended by 10.8, 10.10). Pure file I/O; callers do logging and visibility.

shortcut: sync file I/O inside async methods; files are small (<=32 KB), move to a thread executor if that changes.
"""
import asyncio
import json
import os
import re
import string
import tempfile
from datetime import date, timedelta
from pathlib import Path

AREA_RE = re.compile(r"^[a-z0-9-]{1,32}$")
FILE_RE = re.compile(r"^[a-z0-9-]{1,64}\.md$")
_ID_RE = re.compile(r"^[0-9]{1,20}$")
_STRIP = re.compile(r"[\]()\r\n]")
_REMOVED = "Summary removed after an erasure request."
_DEFAULT_TPL = "$frontmatter\n\n$body\n"  # used when knowledge/_template/<area>.md is missing or empty


class KnowledgeError(Exception):
    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


def slugify(title: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", title.lower()).strip("-")[:56].strip("-")


_HEAD = re.compile(r"^(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$")
_CONTENTS_AT = 4096


def outline(lines: list[str]) -> list[tuple[int, int, str, str]]:
    """(line_no, level, title, id) for each markdown heading outside code fences, excluding the generated Contents.
    id = ascii slug, else stable `s-<n>` (n = 1-based heading position); duplicates get -2, -3."""
    out, seen, fence, n = [], set(), False, 0
    for i, ln in enumerate(lines):
        if ln.lstrip().startswith("```"):
            fence = not fence
        m = None if fence else _HEAD.match(ln)
        if not m:
            continue
        if m[2] == "Contents" and len(m[1]) == 2 and not out and not n:
            n = -1  # the generated block: skip it, and do not count it
            continue
        n = max(n, 0) + 1
        base = slugify(m[2]) or f"s-{n}"
        sid, k = base, 1
        while sid in seen:
            k += 1
            sid = f"{base}-{k}"
        seen.add(sid)
        out.append((i, len(m[1]), m[2], sid))
    return out


def add_contents(body: str) -> str:
    """Prepend a `## Contents` block when the body is long (>4 KB) or has 3+ headings."""
    heads = outline(body.split("\n"))
    if len(heads) < 3 and len(body.encode()) <= _CONTENTS_AT or not heads:
        return body
    top = min(h[1] for h in heads)
    items = [f"{'  ' * (lvl - top)}- [{_clean(t)}](#{sid})" for _, lvl, t, sid in heads]
    return "## Contents\n" + "\n".join(items) + "\n\n" + body


def _frontmatter_end(lines: list[str]) -> int:
    if lines[0] != "---":
        return 0
    return next((i + 1 for i in range(1, len(lines)) if lines[i] == "---"), 0)


def view(text: str, section: str | None = None) -> str | None:
    """Section read. section=None: Contents + first section + hint (None if entry has no Contents block).
    Returns None if `section` is not found."""
    lines = text.split("\n")
    start = _frontmatter_end(lines)
    heads = [h for h in outline(lines) if h[0] >= start]

    def span(k: int) -> str:
        end = next((h[0] for h in heads[k + 1:] if h[1] <= heads[k][1]), len(lines))
        return "\n".join(lines[heads[k][0]:end]).strip()

    if section is not None:
        k = next((k for k, h in enumerate(heads) if section in (h[3], h[2])), None)
        return None if k is None else span(k)
    c = next((i for i in range(start, len(lines)) if lines[i] == "## Contents"), None)
    if c is None or not heads:
        return None
    e = c + 1
    while e < len(lines) and lines[e].lstrip().startswith("- ["):
        e += 1
    first = "\n".join(lines[e:heads[0][0]]).strip()
    head = "\n".join(lines[c:e]) + "\n\n" + (first + "\n\n" if first else "") + span(0)
    return head + "\n\n(use section=<id> to read more, or full=true for the whole entry)"


def norm_visibility(v: str) -> str:
    """`public` or `members:<ids>`; anything invalid fails closed to an empty members list (10.10.1)."""
    if v == "public":
        return v
    ids = [i for i in v[8:].split(",") if i] if isinstance(v, str) and v.startswith("members:") else None
    if ids is None or not all(_ID_RE.fullmatch(i) for i in ids):
        return "members:"
    return "members:" + ",".join(ids)


def members_of(visibility: str) -> set[str] | None:
    """None = public; otherwise the allowed id set (possibly empty)."""
    v = norm_visibility(visibility)
    return None if v == "public" else {i for i in v[8:].split(",") if i}


def parse_frontmatter(text: str) -> dict:
    out: dict = {}
    lines = text.split("\n")
    if lines[0] != "---":
        return out
    for ln in lines[1:]:
        if ln == "---":
            break
        k, _, v = ln.partition(": ")
        try:
            out[k] = json.loads(v)
        except ValueError:
            out[k] = v
    return out


def _clean(s: str) -> str:
    return _STRIP.sub("", s).replace("[", "").strip()


class KnowledgeStore:
    def __init__(self, root: str | Path):
        self.root = os.path.realpath(root)
        self._locks: dict[str, asyncio.Lock] = {}

    def _lock(self, area: str) -> asyncio.Lock:
        return self._locks.setdefault(area, asyncio.Lock())

    def _area_dir(self, area: str) -> str:
        if not isinstance(area, str) or not AREA_RE.fullmatch(area):
            raise KnowledgeError("invalid_path")
        p = os.path.join(self.root, area)
        if os.path.islink(p) or not os.path.realpath(p).startswith(self.root + os.sep):
            raise KnowledgeError("invalid_path")
        if not os.path.isdir(p):
            raise KnowledgeError("area_not_found")
        return p

    def _path(self, area: str, file: str, allow_index: bool = False) -> str:
        d = self._area_dir(area)
        if not isinstance(file, str) or not (FILE_RE.fullmatch(file) or (allow_index and file == "_index.md")):
            raise KnowledgeError("invalid_path")
        p = os.path.join(d, file)
        if os.path.islink(p) or not os.path.realpath(p).startswith(os.path.realpath(d) + os.sep):
            raise KnowledgeError("invalid_path")
        return p

    @staticmethod
    def _atomic(path: str, text: str) -> None:
        fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path), prefix=".tmp-")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                f.write(text)
            os.replace(tmp, path)
        except BaseException:
            if os.path.exists(tmp):
                os.unlink(tmp)
            raise

    def areas(self) -> list[str]:
        return sorted(n for n in os.listdir(self.root) if AREA_RE.fullmatch(n)
                      and not os.path.islink(os.path.join(self.root, n)) and os.path.isdir(os.path.join(self.root, n)))

    def read_index(self, area: str) -> str:
        p = self._path(area, "_index.md", allow_index=True)
        return Path(p).read_text(encoding="utf-8") if os.path.exists(p) else ""

    def read_entry(self, area: str, file: str) -> str:
        p = self._path(area, file)
        if not os.path.isfile(p):
            raise KnowledgeError("not_found")
        return Path(p).read_text(encoding="utf-8", errors="replace")

    def search(self, query: str, areas: list[str] | None = None) -> list[tuple[str, str]]:
        """Substring match over index lines. Returns (visibility, "area: line"); restricted entries are matched and shown
        with their real title/tags from frontmatter, so the caller MUST filter on visibility (G2S11-01)."""
        q, out = query.lower(), []
        for a in (areas or self.areas()):
            for ln in self.read_index(a).splitlines():
                if not ln.startswith("- ["):
                    continue
                vis = "public"
                if "— (restricted) |" in ln:
                    m = re.search(r"\]\(([^)]+)\)", ln)
                    try:
                        fm = parse_frontmatter(self.read_entry(a, m[1])) if m else {}
                    except KnowledgeError:
                        continue
                    vis = fm.get("visibility", "members:")
                    ln = f"- [{_clean(str(fm.get('title', '')))}]({m[1]}) — (restricted) | {', '.join(fm.get('tags') or [])}"
                if q in ln.lower():
                    out.append((vis, f"{a}: {ln}"))
        return out

    async def write_entry(self, area: str, *, title: str, hook: str, tags: list[str], body: str, author_agent: str,
                          run_id: str, trigger: str, human_user_id: int | None, visibility: str = "public",
                          slug: str | None = None) -> str:
        """Returns the new file name. Provenance frontmatter on every entry (10.8)."""
        d = self._area_dir(area)
        vis = norm_visibility(visibility)
        async with self._lock(area):
            base = slugify(slug or title) or f"entry-{run_id[:8]}"
            file, n = base + ".md", 1
            while os.path.lexists(os.path.join(d, file)):
                n += 1
                file = f"{base}-{n}.md"
            self._path(area, file)
            fm = "---\n" + "\n".join(f"{k}: {json.dumps(v, ensure_ascii=False)}" for k, v in [
                ("title", _clean(title)), ("tags", tags), ("created", date.today().isoformat()),
                ("author_agent", author_agent), ("run_id", run_id), ("trigger", trigger),
                ("human_user_id", human_user_id), ("visibility", vis)]) + "\n---"
            tpl = os.path.join(self.root, "_template", area + ".md")
            t = Path(tpl).read_text(encoding="utf-8") if os.path.isfile(tpl) else ""
            text = string.Template(t if t.strip() else _DEFAULT_TPL).safe_substitute(frontmatter=fm, body=add_contents(body))
            self._atomic(os.path.join(d, file), text)
            idx = self.read_index(area)
            line = (f"- [{_clean(title)}]({file}) — {_clean(hook)} | {', '.join(tags)}" if vis == "public"
                    else f"- [(restricted)]({file}) — (restricted) | restricted")  # G2S11-01: no title/tags for non-members
            self._atomic(os.path.join(d, "_index.md"), idx + ("\n" if idx and not idx.endswith("\n") else "") + line + "\n")
        return file

    def _edit_index(self, area: str, file: str, fn=None) -> None:
        """Drop (fn None) or rewrite the index line for `file`."""
        keep = []
        for ln in self.read_index(area).splitlines():
            if ln.startswith("- [") and f"]({file})" in ln:
                if fn is not None:
                    keep.append(fn(ln))
            else:
                keep.append(ln)
        self._atomic(os.path.join(self._area_dir(area), "_index.md"), "\n".join(keep) + "\n")

    async def delete_entry(self, area: str, file: str) -> bool:
        p = self._path(area, file)
        async with self._lock(area):
            if not os.path.isfile(p):
                return False
            os.unlink(p)
            self._edit_index(area, file)
        return True

    async def purge_older_than(self, area: str, days: int) -> int:
        d, cutoff, n = self._area_dir(area), date.today() - timedelta(days=days), 0
        async with self._lock(area):
            for f in sorted(os.listdir(d)):
                p = os.path.join(d, f)
                if not FILE_RE.fullmatch(f) or os.path.islink(p):
                    continue
                try:
                    created = date.fromisoformat(parse_frontmatter(Path(p).read_text(encoding="utf-8")).get("created", ""))
                except (ValueError, TypeError, OSError):
                    continue  # unparseable date: keep rather than delete
                if created < cutoff:
                    os.unlink(p)
                    self._edit_index(area, f)
                    n += 1
        return n

    async def erase_user(self, area: str, file: str, user_id: str) -> bool:
        """10.10.4: drop the user's transcript and participant lines and visibility id; blank the whole Summary.
        The index hook is replaced too (it was the first summary line)."""
        if not _ID_RE.fullmatch(str(user_id)):
            raise KnowledgeError("invalid_path")
        p, uid = self._path(area, file), str(user_id)
        async with self._lock(area):
            if not os.path.isfile(p):
                return False
            out, sect = [], ""
            for ln in Path(p).read_text(encoding="utf-8").split("\n"):
                if ln.startswith("## "):
                    sect = ln[3:].strip()
                    out.append(ln)
                    if sect == "Summary":
                        out += ["", _REMOVED, ""]
                elif sect in ("Summary", "Contents"):
                    continue  # Contents lists Summary sub-headings (model text), so it goes too
                elif f"[{uid}]:" in ln or (sect == "Participants" and f"[{uid}]" in ln):
                    continue
                elif ln == f"human_user_id: {uid}":
                    out.append("human_user_id: null")  # S1212-04: the starter's id is provenance, not content
                elif ln.startswith("visibility: "):
                    v = members_of(json.loads(ln[12:]))
                    out.append(ln if v is None else "visibility: " + json.dumps("members:" + ",".join(sorted(v - {uid}))))
                else:
                    out.append(ln)
            self._atomic(p, "\n".join(out))
            self._edit_index(area, file, lambda ln: ln if "— (restricted) |" in ln else re.sub(r"\) — .*? \|", f") — {_REMOVED} |", ln, count=1))
        return True
