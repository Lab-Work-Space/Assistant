"""Department scope checks for MCP heads (spec 3.10, G040-01/06/14). Fail closed: anything unresolved is scope_unverified."""
import asyncio
import json
import re
import time
import urllib.error
import urllib.request
from urllib.parse import quote

from core.mcp.policy import ID_KINDS, repo_in_scope

CLICKUP_BASE = "https://api.clickup.com"
_CAP = 1 << 20
_TTL = 300
_CU = ID_KINDS["clickup_id"]


class ScopeError(Exception):
    def __init__(self, code: str):
        super().__init__(code)
        self.code = code  # scope_denied | scope_unverified


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k):  # G040-14: any 3xx fails the lookup
        raise urllib.error.URLError("redirect_refused")


def _get(args, path):
    for seg in path.split("."):
        if not isinstance(args, dict):
            return None
        args = args.get(seg)
    return args


class Scope:
    def __init__(self, access, environ, *, base: str = CLICKUP_BASE, clock=time.monotonic, drive_parents=None):
        self.access, self.environ, self.base, self.clock = access, environ, base, clock
        self._cache: dict[tuple, tuple[float, str]] = {}
        # shortcut: Drive ancestry needs structuredContent (P-GPARENTS unprobed); no hook = existing ids are unverified
        self.drive_parents = drive_parents

    # ---- ClickUp resolver
    def _fetch(self, path: str):
        tok = self.environ.get("MCP_CLICKUP_API_KEY")
        if not tok:
            return None
        req = urllib.request.Request(self.base + path)
        req.add_unredirected_header("Authorization", tok)
        try:
            with urllib.request.build_opener(_NoRedirect).open(req, timeout=10) as r:
                raw = r.read(_CAP + 1)
            return json.loads(raw) if len(raw) <= _CAP else None
        except Exception:
            return None

    async def _api(self, path: str):
        return await asyncio.to_thread(self._fetch, path)

    async def _space_of(self, arg: str, v) -> str | None:
        if not isinstance(v, str) or not _CU(v):
            return None
        if arg == "space_id":
            return v
        key = (arg, v)
        hit = self._cache.get(key)
        if hit and self.clock() - hit[0] < _TTL:
            return hit[1]
        q = quote(v, safe="")
        space = None
        if arg == "list_id":
            space = ((await self._api(f"/api/v2/list/{q}") or {}).get("space") or {}).get("id")
        elif arg == "task_id":
            space = ((await self._api(f"/api/v2/task/{q}") or {}).get("space") or {}).get("id")
        elif arg == "doc_id":
            team = self.environ.get("MCP_CLICKUP_TEAM_ID", "")
            if not _CU(team):
                return None
            par = ((await self._api(f"/api/v3/workspaces/{quote(team, safe='')}/docs/{q}") or {}).get("parent") or {})
            pid, typ = str(par.get("id", "")), par.get("type")
            if not _CU(pid):
                return None
            if typ == 4:
                space = pid
            elif typ in (5, 6):  # assumed type codes (P-CUDOC)
                ep = "folder" if typ == 5 else "list"
                space = ((await self._api(f"/api/v2/{ep}/{quote(pid, safe='')}") or {}).get("space") or {}).get("id")
        space = str(space) if space is not None else None
        if not space or not _CU(space):
            return None
        self._cache[key] = (self.clock(), space)
        return space

    # ---- main entry
    async def check(self, tp, args: dict, dept: str) -> None:
        sc = tp.scope
        if not sc:
            raise ScopeError("scope_unverified")
        lists = self.access.scopes.get(dept)
        if lists is None:
            raise ScopeError("scope_denied")
        kind, names = sc["kind"], sc["arg"]
        if kind == "github_repo":
            owner, repo = _get(args, names[0]), _get(args, names[1])
            if owner is None and names[0] == "organization":
                owner = self.access.github_default_owner
            if not isinstance(owner, str) or not isinstance(repo, str):
                raise ScopeError("scope_unverified")
            if not repo_in_scope(owner, repo, self.access.github_default_owner, lists.get("github_repos", ())):
                raise ScopeError("scope_denied")
        elif kind == "hostinger_vm":
            v = _get(args, names[0])
            if v is None:
                raise ScopeError("scope_unverified")
            if str(v) not in lists.get("hostinger_vms", ()):
                raise ScopeError("scope_denied")
        elif kind == "google_calendar":
            if _get(args, "calendar_id") is None:  # absent or primary: Praw only
                raise ScopeError("scope_denied")
            for n in names:
                v = _get(args, n)
                if v is not None and (v == "primary" or v not in lists.get("google_calendars", ())):
                    raise ScopeError("scope_denied")
        elif kind == "clickup_space":
            present = [(n, _get(args, n)) for n in names if _get(args, n) is not None]
            if not present:
                raise ScopeError("scope_unverified")
            for n, v in present:
                sp = await self._space_of(n, v)
                if sp is None:
                    raise ScopeError("scope_unverified")
                if sp not in lists.get("clickup_spaces", ()):
                    raise ScopeError("scope_denied")
        elif kind == "google_drive":
            folders = lists.get("google_folders", ())
            for n in names:
                v = _get(args, n)
                if v is None:
                    raise ScopeError("scope_unverified")
                if n in ("folder_id", "parent_folder_id"):  # create tools: the target folder itself
                    if v not in folders:
                        raise ScopeError("scope_denied")
                    continue
                chain = await self.drive_parents(v) if self.drive_parents else None
                if (not isinstance(chain, list) or len(chain) > 10
                        or not all(ID_KINDS["google_file_id"](c) for c in chain)):
                    raise ScopeError("scope_unverified")
                if not any(c in folders for c in chain):
                    raise ScopeError("scope_denied")
        else:
            raise ScopeError("scope_unverified")
