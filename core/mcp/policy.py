"""Pure MCP policy engine (TASK-040 MCP-02): classes, policy/access loading, argument inspection.

No network, no subprocess. Only load_policy/load_access read a file. Unknown means blocked.
"""
from __future__ import annotations

import copy
import fnmatch
import hashlib
import json
import re
import tomllib
import unicodedata
from dataclasses import dataclass, field
from urllib.parse import unquote

# severity order, low to high (spec 3.14)
CLASSES = ("read", "write", "delete_recoverable", "irreversible", "settings", "payment", "blocked")
_SEV = {c: i for i, c in enumerate(CLASSES)}


class PolicyError(Exception):
    def __init__(self, code: str, detail: str = ""):
        self.code = code
        self.detail = detail
        super().__init__(f"{code}:{detail}" if detail else code)


# ---------- id kinds (G040-01) ----------
_GH = re.compile(r"[A-Za-z0-9_.-]{1,100}")
_CU = re.compile(r"[A-Za-z0-9_-]{1,64}")
_GFILE = re.compile(r"[A-Za-z0-9_-]{10,200}")
_GCAL = re.compile(r"[A-Za-z0-9._%+-]{1,200}@[A-Za-z0-9.-]{1,200}")
_HID = re.compile(r"[0-9]{1,12}")


def _ok_gh(v):
    return bool(_GH.fullmatch(v)) and v not in (".", "..") and ".." not in v


ID_KINDS = {
    "gh_owner": lambda v: isinstance(v, str) and _ok_gh(v),
    "gh_repo": lambda v: isinstance(v, str) and _ok_gh(v),
    "clickup_id": lambda v: isinstance(v, str) and bool(_CU.fullmatch(v)),
    "google_file_id": lambda v: isinstance(v, str) and bool(_GFILE.fullmatch(v)),
    "google_calendar_id": lambda v: isinstance(v, str) and (v == "primary" or bool(_GCAL.fullmatch(v))),
    "hostinger_id": lambda v: (type(v) is int and 0 <= v < 10**12) or (isinstance(v, str) and bool(_HID.fullmatch(v))),
}
# scope kind -> id kind of its args
SCOPE_KINDS = {
    "github_repo": "gh_repo", "clickup_space": "clickup_id", "google_calendar": "google_calendar_id",
    "google_drive": "google_file_id", "hostinger_vm": "hostinger_id",
}
_SCOPE_LISTS = {  # [scopes.<CODE>] key -> id kind of each entry (github_repos are globs, checked separately)
    "github_repos": None, "clickup_spaces": "clickup_id", "google_calendars": "google_calendar_id",
    "google_folders": "google_file_id", "hostinger_vms": "hostinger_id",
}

_PATH_SEG = re.compile(r"[A-Za-z0-9_-]+(\[\*\])?")
_TOOL_NAME = re.compile(r"[A-Za-z0-9_.-]{1,64}")
_SVC = re.compile(r"[a-z0-9]{2,16}")
_DEPT = re.compile(r"[A-Z]{2,4}")
_HEX64 = re.compile(r"[0-9a-f]{64}")
_PATHISH = re.compile(r"(?i)(path|file|url|uri|source|dir|attachment)")
_MAX_SCHEMA = 16 * 1024
_HOST_BAD = ("/", "\\", "?", "#", "%", "..")


def canonical(obj) -> str:
    return json.dumps(obj, sort_keys=True, ensure_ascii=False, separators=(",", ":"))


def tool_sha256(tool: dict) -> str:
    c = canonical({"name": tool.get("name"), "description": tool.get("description"),
                   "inputSchema": tool.get("inputSchema")})
    return hashlib.sha256(c.encode("utf-8", "surrogatepass")).hexdigest()


def registered_name(svc: str, tool: str) -> str | None:
    if not isinstance(svc, str) or not isinstance(tool, str):
        return None
    if not _SVC.fullmatch(svc) or not _TOOL_NAME.fullmatch(tool):
        return None
    s = re.sub(r"([A-Z]+)([A-Z][a-z])", r"\1_\2", tool)
    s = re.sub(r"([a-z0-9])([A-Z])", r"\1_\2", s).lower()
    s = re.sub(r"_+", "_", re.sub(r"[^a-z0-9_]", "_", s)).strip("_")
    name = f"mcp_{svc}_{s}"
    return name if s and len(name) <= 64 else None


# ---------- dotted paths with [*] ----------
def _check_path(p, what):
    if not isinstance(p, str) or not p or not all(_PATH_SEG.fullmatch(s) for s in p.split(".")):
        raise PolicyError("policy_bad_path", f"{what}:{p!r}"[:80])
    return p


def _walk(node, segs, out) -> bool:
    """Collect (container, key) refs of existing non-null leaves; return True on a type mismatch."""
    if not isinstance(node, dict):
        return True
    seg = segs[0]
    wild = seg.endswith("[*]")
    name = seg[:-3] if wild else seg
    child = node.get(name)
    if child is None:
        return False
    if wild:
        if not isinstance(child, list):
            return True
        if len(segs) == 1:
            out.extend((child, i) for i in range(len(child)))
            return False
        mm = False
        for it in child:
            mm = _walk(it, segs[1:], out) or mm
        return mm
    if len(segs) == 1:
        out.append((node, name))
        return False
    return _walk(child, segs[1:], out)


def _resolve(obj, path):
    out: list = []
    mm = _walk(obj, path.split("."), out)
    return out, mm


def _set(obj, path, value):
    segs = path.split(".")
    for s in segs[:-1]:
        nxt = obj.get(s)
        if nxt is None:
            nxt = obj[s] = {}
        if not isinstance(nxt, dict):
            raise PolicyError("policy_path_conflict", path)
        obj = nxt
    obj[segs[-1]] = value


# ---------- data model ----------
@dataclass(frozen=True)
class ToolPolicy:
    service: str
    tool: str
    registered: str
    cls: str                      # label/offer class; with dispatch the dispatch map decides per call
    tool_sha256: str              # "" = not filled yet, never equals a live hash (fails closed)
    scope: dict | None            # {"kind", "arg": tuple[str, ...]}
    attribution: tuple
    strip: tuple
    force: dict
    rules: tuple                  # dicts {"arg","op","val","cls"}
    dispatch: dict | None         # {"arg", "map"}
    ids: dict = field(default_factory=dict)   # dot path -> id kind
    free_text: tuple = ()         # hostinger params paths exempt from the path-char guard
    elicits: bool = False
    allow_args: tuple = ()
    require_props: tuple = ()


@dataclass(frozen=True)
class ServicePolicy:
    service: str
    server_version: str
    tools: dict                   # live tool name -> ToolPolicy


@dataclass(frozen=True)
class ServiceAccess:
    depts: tuple


@dataclass(frozen=True)
class Access:
    github_default_owner: str
    services: dict                # service -> ServiceAccess
    scopes: dict                  # dept code -> {list key: tuple}


def _keys(d, allowed, what):
    if not isinstance(d, dict):
        raise PolicyError("policy_bad_type", what)
    extra = set(d) - set(allowed)
    if extra:
        raise PolicyError("policy_unknown_key", f"{what}:{sorted(map(str, extra))[0]}")


def _cls(c, what):
    if c not in _SEV:
        raise PolicyError("policy_bad_class", what)
    return c


def _norm(s):
    return s.strip().casefold()


def _strlist(v, what):
    if not isinstance(v, list) or not all(isinstance(x, str) for x in v):
        raise PolicyError("policy_bad_type", what)
    return v


def _parse_rule(r, tool):
    _keys(r, ("when", "class"), f"{tool}.rules")
    w = r.get("when")
    _keys(w, ("arg", "present", "equals", "in", "contains", "glob"), f"{tool}.when")
    ops = [k for k in w if k != "arg"]
    if "arg" not in w or len(ops) != 1:
        raise PolicyError("policy_bad_rule", tool)
    op, val = ops[0], w[ops[0]]
    if op == "present":
        if val is not True:
            raise PolicyError("policy_bad_rule", tool)
    elif op in ("equals",):
        val = _norm(val) if isinstance(val, str) else val
        if not isinstance(val, (str, int, bool)):
            raise PolicyError("policy_bad_rule", tool)
    elif op in ("in", "glob"):
        val = tuple(_norm(x) for x in _strlist(val, tool))
        if not val:
            raise PolicyError("policy_bad_rule", tool)
    else:  # contains
        if not isinstance(val, str) or not val:
            raise PolicyError("policy_bad_rule", tool)
        val = _norm(val)
    return {"arg": _check_path(w["arg"], tool), "op": op, "val": val, "cls": _cls(r.get("class"), tool)}


def _parse_tool(svc, name, t):
    allowed = ("class", "tool_sha256", "scope", "attribution", "strip", "force", "rules", "dispatch", "ids",
               "free_text", "elicits", "allow_args", "require_props")
    _keys(t, allowed, name)
    reg = registered_name(svc, name)
    if reg is None:
        raise PolicyError("policy_bad_tool_name", str(name)[:64])
    h = t.get("tool_sha256", "")
    if h != "" and not (isinstance(h, str) and _HEX64.fullmatch(h)):
        raise PolicyError("policy_bad_hash", name)
    ids = {}
    for p, k in (t.get("ids") or {}).items():
        if k not in ID_KINDS:
            raise PolicyError("policy_bad_id_kind", name)
        ids[_check_path(p, name)] = k
    scope = None
    if "scope" in t:
        s = t["scope"]
        _keys(s, ("kind", "arg"), f"{name}.scope")
        if s.get("kind") not in SCOPE_KINDS:
            raise PolicyError("policy_bad_scope", name)
        arg = s.get("arg", ["owner", "repo"] if s["kind"] == "github_repo" else None)
        arg = [arg] if isinstance(arg, str) else arg
        if not arg:
            raise PolicyError("policy_bad_scope", name)
        scope = {"kind": s["kind"], "arg": tuple(_check_path(a, name) for a in _strlist(arg, name))}
        for a in scope["arg"]:
            ids.setdefault(a, SCOPE_KINDS[s["kind"]])
    disp = None
    if "dispatch" in t:
        d = t["dispatch"]
        _keys(d, ("arg", "map"), f"{name}.dispatch")
        if not isinstance(d.get("map"), dict) or not d["map"]:
            raise PolicyError("policy_bad_dispatch", name)
        m = {}
        for k, c in d["map"].items():
            if k != _norm(k):
                raise PolicyError("policy_dispatch_key_not_normalised", name)
            m[k] = _cls(c, name)
        disp = {"arg": _check_path(d.get("arg"), name), "map": m}
    attr = []
    for a in t.get("attribution", []):
        _keys(a, ("field", "style", "set_if_absent"), f"{name}.attribution")
        if a.get("style") not in ("bold_prefix", "commit_prefix") or "[*]" in str(a.get("field")):
            raise PolicyError("policy_bad_attribution", name)
        attr.append({"field": _check_path(a["field"], name), "style": a["style"],
                     "set_if_absent": a.get("set_if_absent", False) is True})
    return ToolPolicy(
        service=svc, tool=name, registered=reg, cls=_cls(t.get("class"), name),
        tool_sha256=h, scope=scope, attribution=tuple(attr),
        strip=tuple(_check_path(p, name) for p in _strlist(t.get("strip", []), name)),
        force={_check_path(k, name): v for k, v in (t.get("force") or {}).items()},
        rules=tuple(_parse_rule(r, name) for r in t.get("rules", [])),
        dispatch=disp, ids=ids,
        free_text=tuple(_check_path(p, name) for p in _strlist(t.get("free_text", []), name)),
        elicits=t.get("elicits", False) is True,
        allow_args=tuple(_strlist(t.get("allow_args", []), name)),
        require_props=tuple(_strlist(t.get("require_props", []), name)),
    )


def parse_policy(data: dict) -> ServicePolicy:
    _keys(data, ("service", "server_version", "tools"), "policy")
    svc = data.get("service")
    if not isinstance(svc, str) or not _SVC.fullmatch(svc) or not isinstance(data.get("server_version"), str):
        raise PolicyError("policy_bad_header")
    tools, seen = {}, set()
    for name, t in (data.get("tools") or {}).items():
        tp = _parse_tool(svc, name, t)
        if tp.registered in seen:
            raise PolicyError("policy_name_collision", name)
        seen.add(tp.registered)
        tools[name] = tp
    return ServicePolicy(svc, data["server_version"], tools)


def parse_access(data: dict) -> Access:
    _keys(data, ("github_default_owner", "services", "scopes"), "access")
    owner = data.get("github_default_owner", "")
    if owner and not ID_KINDS["gh_owner"](owner):
        raise PolicyError("access_bad_owner")
    services = {}
    for svc, s in (data.get("services") or {}).items():
        _keys(s, ("depts",), f"services.{svc}")
        depts = _strlist(s.get("depts", []), svc)
        if not _SVC.fullmatch(svc) or not all(_DEPT.fullmatch(d) for d in depts):
            raise PolicyError("access_bad_dept", svc)
        services[svc] = ServiceAccess(tuple(depts))
    scopes = {}
    for code, sc in (data.get("scopes") or {}).items():
        _keys(sc, _SCOPE_LISTS, f"scopes.{code}")
        if not _DEPT.fullmatch(code):
            raise PolicyError("access_bad_dept", code)
        out = {}
        for k, vals in sc.items():
            for v in _strlist(vals, k):
                if k == "github_repos":
                    # repo-name globs only: no "/" (owner is compared separately), no "..", no char classes
                    if not re.fullmatch(r"[A-Za-z0-9_.*?-]{1,100}", v) or ".." in v:
                        raise PolicyError("access_bad_glob", v[:40])
                elif not ID_KINDS[_SCOPE_LISTS[k]](v):
                    raise PolicyError("access_bad_id", k)
            out[k] = tuple(vals)
        scopes[code] = out
    return Access(owner, services, scopes)


def _load(path, fn):
    try:
        with open(path, "rb") as f:
            return fn(tomllib.load(f))
    except (OSError, tomllib.TOMLDecodeError):
        raise PolicyError("policy_unreadable") from None


def load_policy(path) -> ServicePolicy:
    return _load(path, parse_policy)


def load_access(path) -> Access:
    return _load(path, parse_access)


def repo_in_scope(owner, repo, default_owner, globs) -> bool:
    """Owner and repo compared separately; globs hold no "/", so fnmatch cannot cross a path separator."""
    if not (ID_KINDS["gh_owner"](owner) and ID_KINDS["gh_repo"](repo)) or not default_owner:
        return False
    if owner.casefold() != default_owner.casefold():
        return False
    return any("/" not in g and fnmatch.fnmatchcase(repo.casefold(), g.casefold()) for g in globs)


# ---------- argument inspection ----------
def check_ids(tp: ToolPolicy, args: dict) -> None:
    """G040-01 step 4a: every id-bearing argument must match its kind regex, else PolicyError('invalid_id')."""
    for path, kind in tp.ids.items():
        refs, mm = _resolve(args, path)
        if mm or not all(ID_KINDS[kind](c[k]) for c, k in refs):
            raise PolicyError("invalid_id")


def _unq(s):
    for _ in range(4):
        n = unquote(s)
        if n == s:
            break
        s = n
    return s


def _norm_path(s):
    s = unicodedata.normalize("NFKC", s).replace("\\", "/").casefold()
    parts: list[str] = []
    for seg in s.split("/"):
        seg = seg.strip()
        if seg in ("", "."):
            continue
        if seg == "..":
            if parts:
                parts.pop()
            continue
        parts.append(seg)
    return "/".join(parts)


def _hit(rule, a) -> bool:
    refs, mm = _resolve(a, rule["arg"])
    if mm:
        return True  # unexpected shape: fail toward severity
    op, val = rule["op"], rule["val"]
    if op == "present":
        return bool(refs)
    hit = False
    for c, k in refs:
        v = c[k]
        if op == "equals" and not isinstance(val, str):
            hit = hit or type(v) is not type(val) or v == val
        elif not isinstance(v, str):
            hit = True
        elif op in ("equals", "in"):
            n = _norm(v)
            if n == val if op == "equals" else n in val:
                c[k] = n  # the server receives the normalised value we matched on
                hit = True
        elif op == "contains":
            # Gate 2: also match the dot-segment/percent-decoded path form, so ".github/./workflows" cannot slip past
            hit = hit or any(val in x for x in (_norm(v), _norm_path(v), _norm_path(_unq(v))))
        else:  # glob over normalised path candidates
            cands = {_norm_path(v), _norm_path(_unq(v))}
            hit = hit or any(fnmatch.fnmatchcase(x, g) for x in cands for g in val)
    return hit


def _params_bad(node, path, free) -> bool:
    if isinstance(node, str):
        return any(b in s for s in (node, unicodedata.normalize("NFKC", node)) for b in _HOST_BAD)
    if isinstance(node, dict):
        for k, v in node.items():
            p = f"{path}.{k}"
            if p in free:
                continue
            if _params_bad(str(k), path, free) or _params_bad(v, p, free):
                return True
    elif isinstance(node, list):
        return any(_params_bad(x, path, free) for x in node)
    return False


def classify(tp: ToolPolicy, args: dict) -> tuple[str, dict]:
    """Final class and normalised args. Args must already be the effective args (after effective_args)."""
    if not isinstance(args, dict):
        return "blocked", {}
    a = copy.deepcopy(args)
    check_ids(tp, a)
    if tp.cls == "blocked":
        return "blocked", a
    for p in tp.strip:  # stripped args the registry should have refused; never reach the server
        if p not in tp.force and _resolve(a, p)[0]:
            return "blocked", a
    cls = tp.cls
    if tp.dispatch:
        refs, mm = _resolve(a, tp.dispatch["arg"])
        if mm or len(refs) != 1 or not isinstance(refs[0][0][refs[0][1]], str):
            return "blocked", a
        c, k = refs[0]
        n = _norm(c[k])
        if n not in tp.dispatch["map"]:
            return "blocked", a
        c[k] = n
        cls = tp.dispatch["map"][n]
    for r in tp.rules:  # raise-only
        if _hit(r, a) and _SEV[r["cls"]] > _SEV[cls]:
            cls = r["cls"]
    if tp.service == "hostinger" and "params" in a and _params_bad(a["params"], "params", set(tp.free_text)):
        cls = "blocked"
    return cls, a


def effective_args(tp: ToolPolicy, args: dict, name: str, variables: dict | None = None) -> dict:
    """Step 8: forced fields, then attribution (G040-11: runs before classify). Pure helper for the gateway."""
    a = copy.deepcopy(args)
    for p, v in tp.force.items():
        if isinstance(v, str) and v.startswith("$"):
            if v[1:] not in (variables or {}):
                raise PolicyError("force_unresolved", p)
            v = variables[v[1:]]
        _set(a, p, v)
    name = " ".join(str(name).split())
    for at in tp.attribution:
        pre = f"**{name}:** " if at["style"] == "bold_prefix" else f"{name} (AI): "
        refs, mm = _resolve(a, at["field"])
        if mm or any(not isinstance(c[k], str) for c, k in refs):
            raise PolicyError("bad_attribution_field", at["field"])
        if not refs or not refs[0][0][refs[0][1]].strip():
            if at["set_if_absent"]:
                _set(a, at["field"], f"Created by {name} (AI)")
            continue
        c, k = refs[0]
        if not c[k].startswith(pre.rstrip()):
            c[k] = pre + c[k]
    return a


def _props_walk(node, prefix, out):
    if isinstance(node, dict):
        for k, v in node.items():
            if k == "properties" and isinstance(v, dict):
                for pn, pv in v.items():
                    out.append(prefix + pn)
                    _props_walk(pv, prefix + pn + ".", out)
            else:
                _props_walk(v, prefix, out)
    elif isinstance(node, list):
        for x in node:
            _props_walk(x, prefix, out)


def offered_schema(tp: ToolPolicy, input_schema: dict) -> dict:
    """Deep copy with strip removed and top-level additionalProperties false; PolicyError('tool_invalid') if unsafe."""
    if not isinstance(input_schema, dict) or input_schema.get("type") != "object" \
            or not isinstance(input_schema.get("properties", {}), dict) \
            or len(canonical(input_schema)) > _MAX_SCHEMA:
        raise PolicyError("tool_invalid", tp.tool)
    props = input_schema.get("properties", {})
    if any(r not in props for r in tp.require_props):
        raise PolicyError("tool_invalid", tp.tool)
    if tp.service == "google":
        names: list = []
        _props_walk(input_schema, "", names)
        ok = set(tp.strip) | set(tp.allow_args) | set(tp.ids)  # ids are regex-validated (G2T040-12)
        for n in names:
            if _PATHISH.search(n.rsplit(".", 1)[-1]) and n not in ok and not any(n.startswith(s + ".") for s in ok):
                raise PolicyError("tool_invalid", tp.tool)
    s = copy.deepcopy(input_schema)
    for p in tp.strip:
        node, segs = s, p.split(".")
        for seg in segs[:-1]:
            node = node.get("properties", {}).get(seg, {}) if isinstance(node, dict) else {}
        if isinstance(node, dict):
            node.get("properties", {}).pop(segs[-1], None)
            if isinstance(node.get("required"), list):
                node["required"] = [r for r in node["required"] if r != segs[-1]]
    s["additionalProperties"] = False
    return s
