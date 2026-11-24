"""Run one `core.cli --script` case in-process with fake providers. Usage: run_case.py <script> [ENV=VAL ...]
Env needed: DATABASE_PATH (temp SQLite file migrated to head, outside the repo), ACC_WORK, EMP_CLI_DEV=1. Exit code = CLI exit code."""
import asyncio
import os
import sys
import tempfile
import types


sys.path.insert(0, os.getcwd())
from core.cli.__main__ import amain  # noqa: E402
from tests.acceptance.fakes import FakeProv  # noqa: E402
from tests.conftest import base_env  # noqa: E402


class _Embed:
    def __init__(self, title="", description="", colour=0):
        self.title, self.description, self.fields = title, description, []

    def add_field(self, name, value, inline=True):
        self.fields.append(types.SimpleNamespace(name=name, value=value))


def _patch_sleep():  # test-side only: `/sleep N` so a script can wait for a job to finish
    from core.cli.script import Session
    orig = Session.handle

    async def handle(self, line):
        if line.strip().startswith("/sleep "):
            await asyncio.sleep(float(line.split()[1]))
            return
        return await orig(self, line)
    Session.handle = handle


async def main() -> int:
    _patch_sleep()
    script, extra = sys.argv[1], dict(a.split("=", 1) for a in sys.argv[2:])
    sys.modules["discord"] = types.SimpleNamespace(Embed=_Embed)  # plain data object only (plan: no live Discord)
    work = os.environ["ACC_WORK"]
    k = os.path.join(work, "knowledge")
    os.makedirs(k, exist_ok=True)
    if extra.pop("RESET", "1") == "1":
        from core.db.sqlite import open_database
        p = await open_database(os.environ["DATABASE_PATH"])
        for t in ("approvals", "tasks", "brainstorm_threads", "jobs", "usage_events", "budget_notices", "budgets"):
            await p.execute(f"DELETE FROM {t}")
        if "SEEDJOB" in extra:
            await p.execute("INSERT INTO jobs (kind, payload, created_by, timeout_s) VALUES (?1, '{}', 'acc', 30)",
                            extra.pop("SEEDJOB"))
        await p.close()
    env = {**base_env(__import__("pathlib").Path(work)), "DATABASE_PATH": os.environ["DATABASE_PATH"],
           "LOG_DIR": os.path.join(work, "logs"), "KNOWLEDGE_DIR": k, "BRAINSTORM_TURN_LIMIT": "1",
           "ANTHROPIC_API_KEY": os.environ["PLANT_ANTHROPIC"], "GOOGLE_API_TOKEN": os.environ["PLANT_GOOGLE"], **extra}
    os.chdir(work)
    prov = {"google": FakeProv(), "anthropic": FakeProv()}
    return await amain(["--as", "user", "--script", script], providers=prov, env=env)


sys.exit(asyncio.run(main()))
