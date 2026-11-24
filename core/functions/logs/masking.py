import json
import threading
import urllib.parse

MIN_SECRET_LEN = 12
_lock = threading.Lock()
_exact: tuple[str, ...] = ()


def _forms(v: str) -> set[str]:
    return {v, urllib.parse.quote(v, safe=""), json.dumps(v)[1:-1]}


def set_exact(values) -> None:
    """Called once by Config.load with DISCORD_BOT_TOKEN, ANTHROPIC_API_KEY, GOOGLE_API_TOKEN."""
    global _exact
    out: set[str] = set()
    for v in values:
        if v and len(v) >= MIN_SECRET_LEN:
            out |= _forms(v)
    with _lock:
        _exact = tuple(sorted(out, key=len, reverse=True))


def add_exact(v: str) -> None:
    """Runtime secrets, e.g. cached webhook tokens (G1-13)."""
    global _exact
    if v and len(v) >= MIN_SECRET_LEN:
        with _lock:
            _exact = tuple(sorted(set(_exact) | _forms(v), key=len, reverse=True))


def exact_values() -> tuple[str, ...]:
    return _exact


# ---- regexes and masking (spec 5.4 as amended by 10.3.4) ----
import re

_REGEXES = (
    (re.compile(r"[MN][A-Za-z\d_-]{23,25}\.[A-Za-z\d_-]{6}\.[A-Za-z\d_-]{27,}"), "***"),
    (re.compile(r"sk-ant-[A-Za-z0-9_-]{10,}"), "***"),
    (re.compile(r"AIza[0-9A-Za-z_-]{35}"), "***"),
    (re.compile(r"discord(?:app)?\.com/api/webhooks/\d+/[A-Za-z0-9_-]+"), "***"),
    (re.compile(r"(postgres(?:ql)?(?:\+\w+)?://[^:/\s]+:)[^@\s]+@"), r"\1***@"),
    (re.compile(r"(?i)\bBearer\s+[^\s*][^\s]*"), "Bearer ***"),
    (re.compile(r"(?im)^(\s*(?:x-api-key|x-goog-api-key|authorization)\s*[:=]\s*)\S.*$"), r"\1***"),
    (re.compile(r"ya29\.[\w-]+"), "***"),
    (re.compile(r"/webhooks/\d+/[\w-]{60,}"), "/webhooks/***"),
)
_KEY = re.compile(r"(?i)(^|[_-])(token|secret|password|passwd|api[_-]?key|authorization|cookies?)$")


def mask_secrets(s: str) -> str:
    for v in _exact:
        s = s.replace(v, "***")
    for rx, rep in _REGEXES:
        s = rx.sub(rep, s)
    return s


def mask_obj(o):
    """Recursive: key-name masking (any value type) plus string masking; tuples/lists/dicts kept in shape."""
    if isinstance(o, str):
        return mask_secrets(o)
    if isinstance(o, (int, float, bool)) or o is None:
        return o
    if isinstance(o, dict):
        return {k: ("***" if isinstance(k, str) and _KEY.search(k) else mask_obj(v)) for k, v in o.items()}
    if isinstance(o, (list, tuple)):
        return type(o)(mask_obj(v) for v in o) if type(o) in (list, tuple) else [mask_obj(v) for v in o]
    return mask_secrets(str(o))
