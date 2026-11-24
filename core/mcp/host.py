"""MCP host (TASK-040 / MCP-03): one stdio child per service through the official `mcp` SDK.

Spec 3.7 lifecycle (spawn, init, startup comparison, health, backoff, call, output cap, stop) plus Gate 1
G040-04 (env allowlist), G040-08 (elicitation), G040-09 (credentials perms, Node fs scope), G040-13 (binary re-hash).
Policy objects are injected (`policies[svc]` = {tool name: ToolPolicy}) so this module does not depend on
core.mcp.policy at import time; the default hash function is policy.tool_sha256, imported lazily.
Tool args and results are never logged; the child's stderr goes to /dev/null.
"""
import asyncio
import hashlib
import json
import logging
import os
import platform
import re
import shutil
import stat
import sys
import time
import tomllib
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Mapping

import jsonschema
import mcp.types as mt
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

from core.functions.logs.masking import add_exact

OUTPUT_CAP = 32_000
ERROR_CAP = 2_000
SCHEMA_CAP = 16 * 1024
MAX_TOOLS = 500
BASE_PATH = "/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin"
TOOL_RE = re.compile(r"^[A-Za-z0-9_.-]{1,64}$")
NAME_RE = re.compile(r"^[a-z][a-z0-9]{0,15}$")
OAUTH_RE = re.compile(r"accounts\.google\.com/o/oauth2")
# G040-04
LITERAL_ENV = {"github": {"GITHUB_TOOLSETS"}, "clickup": {"CLICKUP_MCP_MODE"},
               "google": {"WORKSPACE_MCP_CREDENTIALS_DIR", "WORKSPACE_ATTACHMENT_DIR",
                          "WORKSPACE_MCP_DISABLE_LOCAL_FILES", "ALLOWED_FILE_DIRS"},
               "hostinger": set()}
FORBIDDEN_ENV = re.compile(r"^(?:(?:NODE_|PYTHON|LD_|DYLD_)|(?:API_BASE_URL|API_HEADERS|OAUTH_ISSUER|DEBUG)$)")
BASE_KEYS = {"PATH", "HOME", "SHELL", "USER", "LOGNAME", "LANG"}
_TOP = {"name", "enabled", "command", "args", "call_timeout_s", "rate_per_min", "max_concurrency", "pin", "env",
        "node_permission"}


_SDK_DIR = os.path.dirname(mt.__file__) + os.sep


def _pin_sdk_root_logger() -> None:
    """G2T040-09: the SDK logs server-controlled protocol data on the ROOT logger; drop records that originate in it."""
    root = logging.getLogger()
    if not any(getattr(f, "_mcp_pin", False) for f in root.filters):
        f = lambda r: not str(r.pathname).startswith(_SDK_DIR)  # noqa: E731
        f._mcp_pin = True
        root.addFilter(f)


class HostError(Exception):
    """code: service_unavailable | tool_timeout | service_error"""
    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


class ServerConfigError(ValueError):
    pass


class NotConfigured(Exception):
    """Pre-condition failed (3.2, G040-09, G040-13); reason is a short token, never a value."""


@dataclass(frozen=True)
class ServerConfig:
    name: str
    enabled: bool
    command: str
    args: tuple[str, ...]
    call_timeout_s: int
    rate_per_min: int
    max_concurrency: int
    literals: dict[str, str]
    secrets: dict[str, str]      # destination key -> bot env var
    pin: dict[str, Any]
    root: Path                   # mcp/<svc>


def load_server(path: Path | str) -> ServerConfig:
    p = Path(path)
    d = tomllib.loads(p.read_text())
    bad = set(d) - _TOP
    if bad:
        raise ServerConfigError("unknown_key")
    name = d.get("name")
    if not isinstance(name, str) or not NAME_RE.fullmatch(name):
        raise ServerConfigError("bad_name")
    cmd, args = d.get("command"), d.get("args", [])
    if not isinstance(cmd, str) or not cmd or not isinstance(args, list) or not all(isinstance(a, str) for a in args):
        raise ServerConfigError("bad_command")
    timeout, conc = d.get("call_timeout_s", 60), d.get("max_concurrency", 4)
    if not (isinstance(timeout, int) and 5 <= timeout <= 300) or not (isinstance(conc, int) and 1 <= conc <= 16):
        raise ServerConfigError("bad_limits")
    literals: dict[str, str] = {}
    secrets: dict[str, str] = {}
    src_re = re.compile(rf"^MCP_{name.upper()}_[A-Z0-9_]+$")
    for k, v in (d.get("env") or {}).items():
        if not re.fullmatch(r"[A-Z][A-Z0-9_]{0,63}", k) or FORBIDDEN_ENV.match(k) or k in BASE_KEYS:
            raise ServerConfigError("env_key_refused")
        if isinstance(v, str):
            if k not in LITERAL_ENV.get(name, set()):
                raise ServerConfigError("env_literal_not_allowed")
            literals[k] = v
        elif isinstance(v, dict) and set(v) <= {"from", "secret"} and isinstance(v.get("from"), str):
            if not src_re.fullmatch(v["from"]):
                raise ServerConfigError("env_source_refused")
            secrets[k] = v["from"]
        else:
            raise ServerConfigError("env_shape")
    if d.get("node_permission", True) is not True:  # G2T040-01: the only fs restriction on the Node servers
        raise ServerConfigError("node_permission_required")
    return ServerConfig(name=name, enabled=bool(d.get("enabled", False)), command=cmd, args=tuple(args),
                        call_timeout_s=timeout, rate_per_min=int(d.get("rate_per_min", 60)), max_concurrency=conc,
                        literals=literals, secrets=secrets, pin=d.get("pin") or {},
                        root=p.parent.resolve())


def _platform_key() -> str:
    m = platform.machine().lower()
    return f"{'darwin' if sys.platform == 'darwin' else 'linux'}_{'arm64' if m in ('arm64', 'aarch64') else 'x86_64'}"


def _sha256_file(p: str) -> str:
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def svc_data_dir(data_dir: Path, name: str) -> Path:
    return data_dir / "mcp" / name


def ensure_dirs(data_dir: Path, name: str) -> Path:
    data_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    d = svc_data_dir(data_dir, name)
    d.parent.mkdir(mode=0o700, exist_ok=True)
    d.mkdir(mode=0o700, exist_ok=True)
    os.chmod(d, 0o700)
    return d


def check_creds(creds: Path) -> None:
    """G040-09: directory (lstat, not a symlink), euid-owned, 0700; every file euid-owned and 0600."""
    try:
        st = os.lstat(creds)
        ok = stat.S_ISDIR(st.st_mode) and st.st_uid == os.geteuid() and stat.S_IMODE(st.st_mode) == 0o700
        if ok:
            for f in creds.iterdir():
                fs = os.lstat(f)
                if not stat.S_ISREG(fs.st_mode) or fs.st_uid != os.geteuid() or stat.S_IMODE(fs.st_mode) != 0o600:
                    ok = False
                    break
    except OSError:
        ok = False
    if not ok:
        raise NotConfigured("creds_perms")


def prepare(cfg: ServerConfig, data_dir: Path, environ: Mapping[str, str], *, bootstrap: bool = False):
    """Returns (command, args, env, cwd, secret_values). Raises NotConfigured. bootstrap skips the Google creds check."""
    secret_vals = {}
    for dest, src in cfg.secrets.items():
        v = environ.get(src)
        if not v:
            raise NotConfigured("missing_env")
        secret_vals[dest] = v
    svc = ensure_dirs(data_dir, cfg.name)
    if cfg.name == "google" and not bootstrap:
        check_creds(svc / "credentials")
    path = BASE_PATH
    cmd = cfg.command
    if "/" in cmd:
        cmd = str(Path(cmd) if os.path.isabs(cmd) else cfg.root / cmd)
    else:
        cmd = shutil.which(cmd, path=path + ":" + os.environ.get("PATH", "")) or ""
    if not cmd or not os.access(cmd, os.X_OK):
        raise NotConfigured("command_missing")
    pin = cfg.pin if isinstance(cfg.pin, dict) else {}
    if (pin.get("binary_sha256") or pin.get("sha256")) and cmd.startswith(str(cfg.root)):
        # G040-13 / G2T040-02: re-hash our own binary at each start against the committed binary hash (not the tarball's)
        want = (pin.get("binary_sha256") or {}).get(_platform_key())
        if not isinstance(want, str) or not re.fullmatch(r"[0-9a-f]{64}", want.lower()) or _sha256_file(cmd) != want.lower():
            raise NotConfigured("pin_mismatch")
    cmd_dir = os.path.dirname(cmd)
    if cmd_dir not in path.split(":"):
        path += ":" + cmd_dir
    args = list(cfg.args)
    if os.path.basename(cmd) == "node":  # G040-09: only mcp/<svc> and <data_dir>/mcp/<svc>
        # G2T040-01: one flag per path; a comma list grants nothing on Node >= 20.7
        args = ["--permission", f"--allow-fs-read={cfg.root}", f"--allow-fs-read={svc}", f"--allow-fs-write={svc}"] + args
    env = {"PATH": path, "HOME": str(svc), "SHELL": "/bin/sh", "LANG": "C.UTF-8",
           "USER": environ.get("USER", ""), "LOGNAME": environ.get("LOGNAME", environ.get("USER", ""))}
    env.update({k: v.replace("{svc_data}", str(svc)) for k, v in cfg.literals.items()})
    env.update(secret_vals)
    return cmd, args, env, str(cfg.root), list(secret_vals.values())


@dataclass
class _Svc:
    cfg: ServerConfig
    state: str = "starting"
    live: dict[str, dict] = field(default_factory=dict)
    status: dict[str, str] = field(default_factory=dict)   # tool -> active | changed | unclassified | invalid
    session: ClientSession | None = None
    sem: asyncio.Semaphore | None = None
    excl: asyncio.Lock = field(default_factory=asyncio.Lock)
    wake: asyncio.Event = field(default_factory=asyncio.Event)
    relist: bool = False
    task: asyncio.Task | None = None
    fails: int = 0
    restarts: int = 0
    elicit_target: str | None = None


class McpHost:
    def __init__(self, mcp_root: Path | str, data_dir: Path | str, log, policies: Mapping[str, Mapping[str, Any]] | None = None,
                 *, environ: Mapping[str, str] | None = None, on_change: Callable[[], Any] | None = None,
                 hash_fn: Callable[[dict], str] | None = None, ping_s: float = 60, ping_timeout_s: float = 10,
                 init_timeout_s: float = 30, backoff_s: float = 1, backoff_cap_s: float = 300, healthy_reset_s: float = 600):
        self.mcp_root, self.data_dir, self.log = Path(mcp_root), Path(data_dir), log
        _pin_sdk_root_logger()
        self.policies = policies or {}
        self.environ = os.environ if environ is None else environ
        self.on_change = on_change
        self._hash = hash_fn
        self.ping_s, self.ping_timeout_s, self.init_timeout_s = ping_s, ping_timeout_s, init_timeout_s
        self.backoff_s, self.backoff_cap_s, self.healthy_reset_s = backoff_s, backoff_cap_s, healthy_reset_s
        self._svcs: dict[str, _Svc] = {}
        self._stopping = False

    # ---- public API (spec 5.2)
    async def start(self, services: list[str] | None = None) -> None:
        for f in sorted(self.mcp_root.glob("*/server.toml")):
            if services is not None and f.parent.name not in services:
                continue
            try:
                cfg = load_server(f)
                if cfg.name != f.parent.name:
                    raise ServerConfigError("name_mismatch")
            except Exception as e:  # one bad config must not stop the others
                self.log.write_log("mcp", "mcp.config_invalid", "ERROR", service=f.parent.name,
                                   reason=str(e) if isinstance(e, ServerConfigError) else type(e).__name__)
                continue
            s = _Svc(cfg=cfg, sem=asyncio.Semaphore(cfg.max_concurrency))
            self._svcs[cfg.name] = s
            if not cfg.enabled:
                s.state = "disabled"
                continue
            s.task = asyncio.create_task(self._supervise(s), name=f"mcp-{cfg.name}")

    async def stop(self) -> None:
        self._stopping = True
        tasks = [s.task for s in self._svcs.values() if s.task]
        for t in tasks:
            t.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        for s in self._svcs.values():
            s.session = None
            if s.state != "disabled":
                s.state = "stopped"

    def state(self, svc: str) -> str:
        s = self._svcs.get(svc)
        return s.state if s else "unknown"

    def config(self, svc: str) -> ServerConfig | None:
        s = self._svcs.get(svc)
        return s.cfg if s else None

    def live_tools(self, svc: str) -> dict[str, dict]:
        s = self._svcs.get(svc)
        return dict(s.live) if s else {}

    def active(self, svc: str) -> dict[str, Any]:
        s = self._svcs.get(svc)
        if not s or s.state != "running":
            return {}
        pol = self.policies.get(svc, {})
        return {n: pol[n] for n, st in s.status.items() if st == "active" and n in pol}

    def status(self) -> list[dict]:
        out = []
        for n, s in sorted(self._svcs.items()):
            act = sum(1 for v in s.status.values() if v == "active")
            out.append({"service": n, "state": s.state, "active": act, "blocked": len(s.status) - act,
                        "restarts": s.restarts,
                        "unclassified": sorted(_safe(t) for t, v in s.status.items() if v == "unclassified")})
        return out

    async def wait_state(self, svc: str, states: tuple[str, ...] = ("running",), timeout: float = 30) -> str:
        end = time.monotonic() + timeout
        while self.state(svc) not in states and time.monotonic() < end:
            await asyncio.sleep(0.02)
        return self.state(svc)

    async def call(self, svc: str, tool: str, args: dict, *, replay: bool = False) -> tuple[bool, str]:
        s = self._svcs.get(svc)
        if not s or s.state != "running" or s.session is None:
            raise HostError("service_unavailable")
        if s.status.get(tool) != "active":  # defence in depth: the gateway refuses these first
            raise HostError("service_error")
        tp = self.active(svc).get(tool)
        exclusive = replay and bool(getattr(tp, "elicits", False))
        sem, n = s.sem, (s.cfg.max_concurrency if exclusive else 1)
        got = 0
        try:
            if exclusive:
                async with s.excl:
                    for _ in range(n):
                        await sem.acquire()
                        got += 1
                o, r = args.get("owner"), args.get("repo")
                s.elicit_target = f"{o}/{r}" if isinstance(o, str) and isinstance(r, str) and o and r else None
            else:
                await sem.acquire()
                got = 1
            try:
                async with asyncio.timeout(s.cfg.call_timeout_s):
                    res = await s.session.call_tool(tool, args)
            except TimeoutError:
                raise HostError("tool_timeout") from None
            except Exception:
                s.wake.set()  # likely a dead child: let the health loop notice now
                raise HostError("service_error") from None
        finally:
            s.elicit_target = None
            for _ in range(got):
                sem.release()
        return self._shape(s, res)

    # ---- internals
    def _shape(self, s: _Svc, res: mt.CallToolResult) -> tuple[bool, str]:
        parts, texts = [], []
        for c in res.content:
            if isinstance(c, mt.TextContent):
                texts.append(c.text)
            else:
                parts.append(f"[{getattr(c, 'type', 'content')} omitted]")
        text = "\n".join(texts + parts) if (texts or parts) else ""
        if not texts and res.structuredContent is not None:
            text = json.dumps(res.structuredContent, ensure_ascii=False, default=str)
        if s.cfg.name == "google" and OAUTH_RE.search(text):  # R-AUTH: no link reaches the model
            self.log.write_log("mcp", "mcp.auth_required", "WARNING", service=s.cfg.name)
            return False, "auth_required"
        if res.isError:
            return False, text[:ERROR_CAP]
        if len(text) > OUTPUT_CAP:
            text = text[:OUTPUT_CAP] + f"\n[truncated: {len(text) - OUTPUT_CAP} chars]"
        return True, text

    def _tool_hash(self, tool: dict) -> str:
        if self._hash is None:
            from core.mcp.policy import tool_sha256  # lazy: MCP-02 owns it
            self._hash = tool_sha256
        return self._hash(tool)

    def _compare(self, s: _Svc, tools: list[mt.Tool]) -> None:
        """R9 startup comparison. Names are logged only when they match TOOL_RE."""
        pol = self.policies.get(s.cfg.name, {})
        live: dict[str, dict] = {}
        status: dict[str, str] = {}
        seen_reg: dict[str, str] = {}
        for t in tools[:MAX_TOOLS]:
            d = {"name": t.name, "description": t.description or "", "inputSchema": t.inputSchema}
            live[t.name] = d
            tag = t.name if TOOL_RE.fullmatch(t.name) else "invalid"
            tp = pol.get(t.name)
            if not TOOL_RE.fullmatch(t.name) or not self._schema_ok(t.inputSchema):
                status[t.name], ev = "invalid", "mcp.tool_invalid"
            elif tp is None:
                status[t.name], ev = "unclassified", "mcp.tool_unclassified"
            elif self._tool_hash(d) != tp.tool_sha256:
                status[t.name], ev = "changed", "mcp.tool_changed"
            elif tp.registered in seen_reg:
                status[t.name], ev = "invalid", "mcp.tool_invalid"
            else:
                seen_reg[tp.registered] = t.name
                status[t.name], ev = "active", ""
            if ev:
                self.log.write_log("mcp", ev, "WARNING", service=s.cfg.name, tool=tag)
        for n in pol:
            if n not in live:
                self.log.write_log("mcp", "mcp.tool_missing", "INFO", service=s.cfg.name, tool=_safe(n))
        s.live, s.status = live, status

    @staticmethod
    def _schema_ok(schema: Any) -> bool:
        try:
            if not isinstance(schema, dict) or len(json.dumps(schema)) > SCHEMA_CAP:
                return False
            jsonschema.Draft202012Validator.check_schema(schema)
            return True
        except Exception:
            return False

    async def _list(self, sess: ClientSession) -> list[mt.Tool]:
        tools, cursor = [], None
        for _ in range(20):
            r = await sess.list_tools(cursor)
            tools += r.tools
            cursor = r.nextCursor
            if not cursor or len(tools) >= MAX_TOOLS:
                break
        return tools

    async def _elicit(self, s: _Svc, _ctx, params) -> mt.ElicitResult:
        """G040-08: accept only a one-required-string-field form during an exclusive replay naming owner/repo."""
        target = s.elicit_target
        try:
            sch = params.requestedSchema
            props = sch.get("properties", {}) if isinstance(sch, dict) else sch.properties
            req = sch.get("required", []) if isinstance(sch, dict) else (sch.required or [])
            if (target and getattr(params, "mode", "form") == "form"
                    and len(props) == 1 and list(props) == list(req) and target in params.message
                    and next(iter(props.values())).get("type") == "string"):
                return mt.ElicitResult(action="accept", content={next(iter(props)): target})
        except Exception:
            pass
        return mt.ElicitResult(action="decline")

    async def _message(self, s: _Svc, msg) -> None:
        if isinstance(msg, mt.ServerNotification) and isinstance(msg.root, mt.ToolListChangedNotification):
            s.relist = True
            s.wake.set()

    async def _supervise(self, s: _Svc) -> None:
        name = s.cfg.name
        while not self._stopping:
            started = time.monotonic()
            try:
                await self._session(s)
            except asyncio.CancelledError:
                raise
            except NotConfigured as e:
                s.state = "not_configured"
                lvl = "ERROR" if str(e) in ("creds_perms", "pin_mismatch") else "INFO"
                self.log.write_log("mcp", "mcp.creds_perms" if str(e) == "creds_perms" else "mcp.not_configured", lvl,
                                   service=name, reason=str(e))
                return
            except BaseException as e:  # incl. ExceptionGroup from the SDK task groups
                self.log.write_log("mcp", "mcp.session_ended", "WARNING", service=name, exc_type=type(e).__name__)
            s.state, s.session = "down", None
            self._notify()
            if time.monotonic() - started >= self.healthy_reset_s:
                s.fails = 0
            s.fails += 1
            s.restarts += 1
            if s.fails >= 5:
                self.log.write_log("mcp", "mcp.server_down", "ERROR", service=name, failures=s.fails)
            await asyncio.sleep(min(self.backoff_cap_s, self.backoff_s * 2 ** (s.fails - 1)))
            s.state = "starting"

    def _notify(self) -> None:
        if self.on_change:
            try:
                self.on_change()
            except Exception:
                pass

    async def _session(self, s: _Svc) -> None:
        cmd, args, env, cwd, secrets = prepare(s.cfg, self.data_dir, self.environ)
        for v in secrets:
            add_exact(v)
        if s.cfg.name == "google":  # G2T040-11: refreshed tokens must be written 0600; umask for the child only
            cmd, args = "/bin/sh", ["-c", 'umask 077; exec "$0" "$@"', cmd, *args]
        params = StdioServerParameters(command=cmd, args=args, env=env, cwd=cwd)
        with open(os.devnull, "w") as errlog:
            async with stdio_client(params, errlog=errlog) as (r, w):
                # no sampling_callback / list_roots_callback / logging_callback: SDK defaults refuse or discard
                async with ClientSession(r, w, elicitation_callback=lambda c, p: self._elicit(s, c, p),
                                         message_handler=lambda m: self._message(s, m)) as sess:
                    async with asyncio.timeout(self.init_timeout_s):
                        await sess.initialize()
                        self._compare(s, await self._list(sess))
                    s.session, s.state = sess, "running"
                    self._notify()
                    up = time.monotonic()
                    healthy = False
                    while True:
                        try:
                            await asyncio.wait_for(s.wake.wait(), self.ping_s)
                        except TimeoutError:
                            pass
                        s.wake.clear()
                        async with asyncio.timeout(self.ping_timeout_s):
                            await sess.send_ping()
                        if not healthy and time.monotonic() - up >= self.healthy_reset_s:
                            s.fails, healthy = 0, True
                        if s.relist:
                            s.relist = False
                            async with asyncio.timeout(self.init_timeout_s):
                                self._compare(s, await self._list(sess))
                            self._notify()


def _safe(name: str) -> str:
    return name if TOOL_RE.fullmatch(name) else "invalid"
