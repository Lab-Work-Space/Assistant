"""Knowledge tools + ext init (spec 3.4/3.9, 10.8, 10.10). Index first: read_index/search, then open only matched entries."""
from pathlib import Path

from core.agents.untrusted import wrap_untrusted
from core.interfaces import ToolContext, ToolResult, ToolSpec
from core.knowledge.store import FILE_RE, AREA_RE, KnowledgeError, KnowledgeStore, members_of, parse_frontmatter, view

WRITABLE_AREAS = {"memory", "notes", "drafts"}  # plus the agent's own dept area
READ_ONLY_AREAS = {"rules", "meetings"}  # G1-07: never writable, even if a dept had this name
MAX_READ = 64 * 1024
_AREA = {"type": "string", "pattern": AREA_RE.pattern}


def _obj(props: dict, req: list[str]) -> dict:
    return {"type": "object", "additionalProperties": False, "required": req, "properties": props}


def make_tools(app, store: KnowledgeStore) -> list[ToolSpec]:
    def log(event: str, ctx: ToolContext, **kw):
        app.log.write_log("knowledge", event, agent=ctx.agent.id, run=ctx.run_id, **kw)

    def wrap(text: str) -> str:
        return wrap_untrusted(text, "knowledge")

    async def read_index(ctx, a):
        try:
            text = store.read_index(a["area"])
        except KnowledgeError as e:
            return ToolResult(ok=False, error=e.code)
        log("knowledge.open", ctx, area=a["area"], file="_index.md")
        return ToolResult(ok=True, content=wrap(text))

    async def can_see(ctx, vis: str) -> bool:
        m = members_of(vis)
        if m is None:
            return True
        if ctx.human_user_id is None:
            return False
        if str(ctx.human_user_id) in m:
            return True
        return ctx.human_actor is not None and await app.approver_policy.is_approver(ctx.human_actor)

    async def read(ctx, a):
        try:
            text = store.read_entry(a["area"], a["file"])
        except KnowledgeError as e:
            return ToolResult(ok=False, error=e.code)
        if not await can_see(ctx, parse_frontmatter(text).get("visibility", "members:")):
            log("knowledge.denied", ctx, area=a["area"], file=a["file"])
            return ToolResult(ok=False, error="not_found")  # never leak existence
        sec = a.get("section")
        out = None if a.get("full") else view(text, sec)
        if sec is not None and not a.get("full") and out is None:
            return ToolResult(ok=False, error="section_not_found")
        log("knowledge.open", ctx, area=a["area"], file=a["file"], section=sec or ("full" if out is None else "first"))
        return ToolResult(ok=True, content=wrap((text if out is None else out).encode()[:MAX_READ].decode(errors="ignore")))

    async def search(ctx, a):
        try:
            found = store.search(a["query"], a.get("areas"))
        except KnowledgeError as e:
            return ToolResult(ok=False, error=e.code)
        hits = [ln for vis, ln in found if await can_see(ctx, vis)]
        log("knowledge.search", ctx, hits=len(hits))
        return ToolResult(ok=True, content=wrap("\n".join(hits)), data={"hits": len(hits)})

    async def write(ctx, a):
        if a["area"] in READ_ONLY_AREAS or (a["area"] not in WRITABLE_AREAS and a["area"] != ctx.agent.dept):
            try:
                store.read_index(a["area"])
            except KnowledgeError as e:
                return ToolResult(ok=False, error=e.code)
            return ToolResult(ok=False, error="area_read_only")
        try:
            f = await store.write_entry(a["area"], title=a["title"], hook=a["hook"], tags=a["tags"], body=a["body"],
                                        author_agent=ctx.agent.id, run_id=ctx.run_id, trigger=ctx.trigger,
                                        human_user_id=ctx.human_user_id,
                                        # drafts are private: requester + approvers (approvers pass can_see at read time)
                                        visibility=f"members:{ctx.human_user_id}" if a["area"] == "drafts" else "public")
        except KnowledgeError as e:
            return ToolResult(ok=False, error=e.code)
        log("knowledge.write", ctx, area=a["area"], file=f)
        return ToolResult(ok=True, content=f"{a['area']}/{f}", data={"path": f"{a['area']}/{f}"})

    file_p = {"type": "string", "pattern": FILE_RE.pattern}
    return [
        ToolSpec("knowledge_read_index", "Read a knowledge area's _index.md. Do this first, then open only matching entries.",
                 _obj({"area": _AREA}, ["area"]), read_index),
        ToolSpec("knowledge_read", "Read one knowledge entry (max 64 KB). Long entries have a Contents block: without `section` you get Contents + the first section only. "
                 "Prefer section=<id or heading> to read one part; use full=true only when you need the whole entry.",
                 _obj({"area": _AREA, "file": file_p, "section": {"type": "string", "minLength": 1, "maxLength": 120},
                       "full": {"type": "boolean"}}, ["area", "file"]), read),
        ToolSpec("knowledge_search", "Case-insensitive substring search over index lines only.",
                 _obj({"query": {"type": "string", "minLength": 1, "maxLength": 200},
                       "areas": {"type": "array", "maxItems": 10, "items": _AREA}}, ["query"]), search),
        ToolSpec("knowledge_write", "Write an entry to memory, notes, drafts, or your own department area (human-initiated runs only). Drafts are private to the requester and approvers.",
                 _obj({"area": _AREA, "title": {"type": "string", "minLength": 1, "maxLength": 120},
                       "hook": {"type": "string", "maxLength": 160},
                       "tags": {"type": "array", "maxItems": 8, "items": {"type": "string", "pattern": "^[a-z0-9-]{1,24}$"}},
                       "body": {"type": "string", "maxLength": 32768}},
                      ["area", "title", "hook", "tags", "body"]), write, needs_human_trigger=True),
    ]


def init(ctx) -> None:
    root = Path(ctx.config.knowledge_dir)
    store = KnowledgeStore(root)
    ctx.knowledge = store  # AppContext.knowledge; voice on_done (TASK-016) uses it
    for spec in make_tools(ctx, store):
        ctx.tools.register(spec)
    if ctx.jobs is not None:
        days = ctx.config.knowledge_meetings_retention_days

        async def sweep():
            n = await store.purge_older_than("meetings", days)
            ctx.log.write_log("knowledge", "knowledge.purge", area="meetings", removed=n)

        ctx.jobs.add_sweep(sweep)
