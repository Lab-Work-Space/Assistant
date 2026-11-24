"""Discord entry point (spec 12.4, 12.10): Config.load -> logging -> open_database -> init_core -> setup_discord -> run.
Exit: 0 clean, 2 refusal (code on stderr, never exception text)."""
import asyncio
import os
import signal
import sys

from core.config import PROJECT_ROOT, Config, ConfigError
from core.db.sqlite import DbError, open_database
from core.discord.client import DenyAllApproverPolicy, Refusal, env_suffix, make_bot, setup_discord
from core.extensions import init_core
from core.interfaces import AppContext


def _refuse(code) -> int:
    print(getattr(code, "code", None) or str(code), file=sys.stderr)
    return 2


async def amain(env=None, bot_factory=make_bot, install_signals=True, providers=None) -> int:
    pool, ctx, app = None, None, None
    try:
        try:
            if (os.environ if env is None else env).get("DISCORD_BOT_TOKEN"):  # first, before any other check (S1210-04)
                raise Refusal("use_per_persona_tokens")
            if os.environ.get("EMP_CLI_DEV"):  # any value: dev CLI flag must never reach the Discord process
                raise Refusal("cli_flag_in_discord_mode")
            config = Config.load(env)
            if config.discord_bot_token:
                raise Refusal("use_per_persona_tokens")
            if not config.persona_tokens:
                raise Refusal("missing:DISCORD_BOT_TOKEN_" + env_suffix(config.intake_persona))
            from core.agents.persona import FilePersonaRegistry
            from core.functions.logs.logsystem import Log, install_logging, prepare_log_dir
            pdir = config.prompts_dir if os.path.isabs(config.prompts_dir) else str(PROJECT_ROOT / config.prompts_dir)
            personas = FilePersonaRegistry.load(pdir, config.default_agent_id, config.default_cheap_model)
            by_suffix = {env_suffix(p.id): p.id for p in personas.all()}
            tokens, deferred = {}, {}
            for suf, tok in config.persona_tokens.items():
                if suf in by_suffix:
                    tokens[by_suffix[suf]] = tok
                else:
                    deferred[suf] = tok  # may belong to a hired persona: decided after the DB opens (R23)
            if "SYSTEM" in by_suffix:  # 12.14.2: the id is reserved
                raise Refusal("persona_id_reserved:system")
            if config.intake_persona not in tokens:
                raise Refusal("missing:DISCORD_BOT_TOKEN_" + env_suffix(config.intake_persona))
            log = Log(os.path.join(prepare_log_dir(config.log_dir), "app.jsonl"), stdout=False)
            install_logging(log, config.log_level)
            pool = await open_database(config.database_path)
            from core.growth.personas import RuntimePersonaRegistry, load_departments
            await load_departments(pool)
            file_personas = personas
            personas = await RuntimePersonaRegistry.load(pool, file_personas, pdir, config.default_cheap_model, log)
            hired = {env_suffix(i): i for i in personas.known_ids() if i not in {p.id for p in file_personas.all()}}
            for suf, tok in deferred.items():
                if suf not in hired:
                    raise Refusal("unknown_persona_token:" + suf)
                tokens[hired[suf]] = tok
            for pid in [i for i in tokens if personas.is_fired(i)]:  # G033-09: fired personas get no client
                del tokens[pid]
                log.write_log("discord", "persona.token_fired", "WARNING", id=pid)
            if config.intake_persona not in tokens:
                raise Refusal("missing:DISCORD_BOT_TOKEN_" + env_suffix(config.intake_persona))
        except Exception as e:
            return _refuse(e if isinstance(e, (Refusal, ConfigError, DbError)) else type(e).__name__)
        bots = {pid: bot_factory(config, pid == config.intake_persona) for pid in tokens}
        system = bot_factory(config, False) if config.system_token else None
        ctx = AppContext(config=config, log=log, db=pool, personas=personas, surface="discord",
                         approver_policy=DenyAllApproverPolicy(), bot=bots[config.intake_persona],
                         providers=providers if providers is not None else {})
        try:
            init_core(ctx)
            app = setup_discord(ctx, bots, system)
        except Exception as e:
            return _refuse(getattr(e, "code", None) or type(e).__name__)
        if install_signals:
            loop = asyncio.get_running_loop()
            for s in (signal.SIGTERM, signal.SIGINT):
                loop.add_signal_handler(s, lambda: asyncio.ensure_future(app.shutdown()))
        code = await app.run(tokens, config.system_token)
        return _refuse(app.refusal) if code and getattr(app, "refusal", None) else code
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
