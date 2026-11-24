"""python -m core.cli [--as admin|user] [--agent <id|alias>] [--script FILE] [--fake] (spec 10.15). Exit: 0 ok, 1 failed, 2 refusal."""
import argparse
import asyncio
import os
import sys

from core.approvals.service import CliDevApproverPolicy
from core.cli.identity import Refusal, dotenv_guard, require_dev
from core.cli.presenter import CliApprovalPresenter
from core.cli.script import Session, run_script
from core.cli.sink import CliSinkFactory, Out
from core.cli.threads import CliThreads
from core.config import PROJECT_ROOT, Config, ConfigError
from core.db.sqlite import DbError, open_database
from core.extensions import init_core
from core.interfaces import AppContext


def _refuse(e) -> int:
    print(getattr(e, "code", None) or str(e), file=sys.stderr)
    return 2


async def amain(argv=None, providers=None, out: Out | None = None, env=None) -> int:
    ap = argparse.ArgumentParser(prog="core.cli")
    ap.add_argument("--as", dest="as_name", choices=["admin", "user"], default="user")
    ap.add_argument("--agent")
    ap.add_argument("--script")
    ap.add_argument("--fake", action="store_true", help="deterministic fake providers: no keys, no cost (dev only)")
    args = ap.parse_args(argv)
    out, pool, ctx = out or Out(), None, None
    try:
        try:
            if args.fake:
                from core.cli.fakes import FAKE_ENV, fake_providers, stub_discord
                env = {**FAKE_ENV, **(os.environ if env is None else env)}
                providers, _ = fake_providers(), stub_discord()
            config = Config.load(env)
            dotenv_guard()
            require_dev(config)
            policy = CliDevApproverPolicy(config)
            from core.agents.persona import FilePersonaRegistry
            from core.functions.logs.logsystem import Log, install_logging, prepare_log_dir
            pdir = config.prompts_dir if os.path.isabs(config.prompts_dir) else str(PROJECT_ROOT / config.prompts_dir)
            personas = FilePersonaRegistry.load(pdir, config.default_agent_id, config.default_cheap_model)
            log = Log(os.path.join(prepare_log_dir(config.log_dir), "app.jsonl"), stdout=False)
            install_logging(log, config.log_level)
            pool = await open_database(config.database_path)
            from core.growth.personas import RuntimePersonaRegistry, load_departments
            await load_departments(pool)
            personas = await RuntimePersonaRegistry.load(pool, personas, pdir, config.default_cheap_model, log)
        except Exception as e:  # startup refusal: code only, never exception text with secrets
            return _refuse(e if isinstance(e, (Refusal, ConfigError, DbError)) else type(e).__name__)
        threads = CliThreads(out)
        ctx = AppContext(config=config, log=log, db=pool, personas=personas, surface="cli", approver_policy=policy,
                         providers=providers if providers is not None else {})
        ctx.sinks, ctx.threads = CliSinkFactory(out, threads), threads
        try:
            init_core(ctx)
            ctx.approval_presenter = CliApprovalPresenter(out)
            ctx.approvals.set_presenter(ctx.approval_presenter)
            asyncio.ensure_future(ctx.approvals.recover())
            if os.environ.get("EMP_VERIFY_MODELS") == "1":
                from core.provider.registry import verify_models
                await verify_models(ctx)
        except Exception as e:
            return _refuse(getattr(e, "code", None) or type(e).__name__)  # type only, never exception text (rule 16)
        agent = (personas.get(args.agent) or personas.by_name(args.agent)) if args.agent else None
        if args.agent and agent is None:
            return _refuse("unknown_agent")
        s = Session(ctx, out, threads, args.as_name, agent.id if agent else config.default_agent_id)
        try:
            if args.script:
                return await run_script(s, args.script)
            while not s.quit:
                try:
                    line = await asyncio.to_thread(input, f"{s.as_name}@{s.agent}> ")
                except EOFError:
                    break
                try:
                    await s.handle(line)
                except Exception as e:  # type only: message/traceback may carry secrets (G2-06)
                    out.line(f"[error] {type(e).__name__}")
            return 0
        except Exception as e:
            out.line(f"[error] {type(e).__name__}")
            return 1
    finally:
        if ctx is not None:
            if ctx.approvals is not None:
                await ctx.approvals.stop()
            if ctx.jobs is not None:
                await ctx.jobs.stop()
        if pool is not None:
            await pool.close()


if __name__ == "__main__":
    sys.exit(asyncio.run(amain()))
