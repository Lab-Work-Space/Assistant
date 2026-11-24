"""python -m core.mcp dump <svc> | google-auth  (spec 3.7, 3.2, 3.14). Output has no secrets: names, hashes only."""
import asyncio
import os
import subprocess
import sys
from pathlib import Path

from core.config import PROJECT_ROOT, parse_env_file
from core.mcp import host as H


class _Out:
    def write_log(self, comp, event, level, **kw):
        print(f"[{level}] {event} {kw}", file=sys.stderr)


def _env() -> dict[str, str]:
    env = dict(os.environ)
    f = Path(PROJECT_ROOT) / ".env.local"
    if f.exists():
        env = {**parse_env_file(f), **env}
    return env


def _data_dir(env) -> Path:
    db = env.get("DATABASE_PATH")
    return Path(db).resolve().parent if db else Path(PROJECT_ROOT) / "data"


def _cfg(svc: str) -> H.ServerConfig:
    return H.load_server(Path(PROJECT_ROOT) / "mcp" / svc / "server.toml")


async def dump(svc: str) -> int:
    from core.mcp.policy import registered_name, tool_sha256  # MCP-02
    env = _env()
    h = H.McpHost(Path(PROJECT_ROOT) / "mcp", _data_dir(env), _Out(), {}, environ=env)
    await h.start([svc])
    st = await h.wait_state(svc, ("running", "not_configured", "disabled", "unknown"), 60)
    if st != "running":
        print(f"{svc}: {st}", file=sys.stderr)
        await h.stop()
        return 1
    for n, d in sorted(h.live_tools(svc).items()):
        sn = H._safe(n)  # G2T040-14: server-supplied names never reach the terminal raw
        print(f"{sn}\t{registered_name(svc, sn)}\t{tool_sha256(d)}")
    await h.stop()
    return 0


def google_auth() -> int:
    """Owner's one-time login: same env as the host, stdio inherited, creds dir 0700 and files 0600 afterwards."""
    cfg = _cfg("google")
    env = _env()
    data = _data_dir(env)
    try:
        cmd, args, child_env, cwd, _ = H.prepare(cfg, data, env, bootstrap=True)
    except H.NotConfigured as e:
        print(f"google: not_configured ({e})", file=sys.stderr)
        return 1
    creds = H.svc_data_dir(data, "google") / "credentials"
    os.umask(0o077)
    creds.mkdir(mode=0o700, exist_ok=True)
    os.chmod(creds, 0o700)
    rc = subprocess.run([cmd, *args], env=child_env, cwd=cwd).returncode
    for f in creds.iterdir():
        if f.is_file() and not f.is_symlink():
            os.chmod(f, 0o600)
    try:
        H.check_creds(creds)
    except H.NotConfigured:
        print("google: credentials directory permissions are wrong (need 0700 dir, 0600 files)", file=sys.stderr)
        return 1
    return rc


def main(argv: list[str]) -> int:
    if len(argv) == 2 and argv[0] == "dump" and argv[1].isalnum():
        return asyncio.run(dump(argv[1]))
    if argv == ["google-auth"]:
        return google_auth()
    print("usage: python -m core.mcp dump <svc> | google-auth", file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
