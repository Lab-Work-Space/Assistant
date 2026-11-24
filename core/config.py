"""Env-only configuration (spec 5.7 as amended by 10.0, 10.3.2, 10.12.6, 10.17 RC-1/RC-3).

Config.load never writes os.environ (RC-3). EMP_CLI_DEV is never a Config field (10.0).
"""
import os
import re
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Mapping

from core.db.sqlite import DbError, validate_db_path
from core.functions.logs import masking

PROJECT_ROOT = Path(__file__).resolve().parent.parent

# Secrets: never in repr (spec 5.7).
SECRETS = ("DISCORD_BOT_TOKEN", "ANTHROPIC_API_KEY", "GOOGLE_API_TOKEN", "GOOGLE_STT_API_KEY")
_REQ = object()  # required marker
_OPT = None      # optional, default None

# name -> (type, default)
_SPEC: dict[str, tuple[type, object]] = {
    "DISCORD_BOT_TOKEN": (str, _OPT), "DATABASE_PATH": (str, _REQ),
    "ANTHROPIC_API_KEY": (str, _OPT), "GOOGLE_API_TOKEN": (str, _OPT), "GOOGLE_STT_API_KEY": (str, _OPT),
    "DISCORD_GUILD_ID": (int, _REQ), "APPROVAL_CHANNEL_ID": (int, _REQ),
    "ADMIN_NOTIFY_CHANNEL_ID": (int, _REQ), "TASKS_CHANNEL_ID": (int, _REQ),
    "SETTINGS_CHANNEL_ID": (int, _OPT), "APPROVER_ROLE_ID": (int, _OPT), "APPROVER_ROLE_NAME": (str, "AI-Admin"),
    "DEFAULT_CHEAP_MODEL": (str, _REQ), "REPLY_TIER2_MODEL": (str, _REQ), "IMAGE_MODEL": (str, _REQ),
    "TTS_MODEL": (str, _REQ), "TTS_VOICE": (str, _REQ), "STT_PROVIDER": (str, _REQ), "STT_MODEL": (str, _REQ),
    "DEFAULT_AGENT_ID": (str, "praw"), "NOTE_AGENT_ID": (str, "praw"), "APP_TIMEZONE": (str, "Asia/Bangkok"),
    "LOG_DIR": (str, "logs"), "LOG_LEVEL": (str, "INFO"), "PROMPTS_DIR": (str, "prompts"),
    "KNOWLEDGE_DIR": (str, "knowledge"),
    "REPLY_ACTIVE_WINDOW_S": (int, 300), "REPLY_TIER2_TIMEOUT_S": (float, 3), "REPLY_TIER2_MAX_PER_MIN_CHANNEL": (int, 6),
    "CONTEXT_BUFFER_SIZE": (int, 20), "CONTEXT_BUFFER_TTL_S": (int, 1800), "USER_MAX_RUNS_PER_HOUR": (int, 30),
    "STREAM_EDIT_INTERVAL_S": (float, 1.0), "STREAM_MAX_MESSAGES": (int, 6), "STREAM_MODE": (str, "typing"),
    "AGENT_MAX_TOOL_ROUNDS": (int, 5), "AGENT_MAX_OUTPUT_TOKENS": (int, 2048), "AGENT_MAX_CONCURRENCY": (int, 4),
    "AGENT_RUN_TIMEOUT_S": (float, 180), "PROVIDER_IDLE_TIMEOUT_S": (float, 30),
    "BRAINSTORM_TURN_LIMIT": (int, 10), "BRAINSTORM_TOKEN_BUDGET": (int, 20000),
    "BRAINSTORM_TURN_MAX_OUTPUT_TOKENS": (int, 800), "BRAINSTORM_AGENT_DAILY_MAX": (int, 10),
    "JOB_MAX_CONCURRENCY": (int, 1), "JOB_DEFAULT_TIMEOUT_S": (int, 300), "JOB_OUTPUT_CAP_BYTES": (int, 1048576),
    "JOB_POLL_INTERVAL_S": (float, 2), "JOB_MEMORY_LIMIT_MB": (int, 1024), "JOBS_ENABLE_SELFTEST": (bool, False),
    "VOICE_TMP_DIR": (str, "/tmp/employee-voice"), "VOICE_NOTICE_DELAY_S": (int, 10), "VOICE_CHUNK_S": (int, 30),
    "VOICE_ENABLED": (bool, False), "GEMINI_PAID_TIER_CONFIRMED": (bool, False), "VOICE_LIVE_CAPTURE": (bool, False), "VOICE_SILENCE_FLUSH_MS": (int, 1500),
    "VOICE_MIN_SEGMENT_MS": (int, 500), "VOICE_MAX_PENDING_CHUNKS": (int, 6),
    "VOICE_MAX_SESSION_MIN": (int, 120), "TTS_MAX_CHARS": (int, 1000), "APPROVAL_TTL_H": (int, 24),
    "BUDGET_DEFAULT_DAILY_USD": (Decimal, "2.00"), "BUDGET_GATE_DAILY_USD": (Decimal, "0.50"),
    "DM_MAX_PER_HOUR_PER_AGENT": (int, 20), "PULL_MAX_PER_TARGET": (int, 3),
    "KNOWLEDGE_MEETINGS_RETENTION_DAYS": (int, 90), "TASKS_RETENTION_DAYS": (int, 180),
    "CHANNEL_ALLOWLIST": (str, ""), "ROLLOUT_MODE": (str, "coexist"), "PERSONA_NAME_SUFFIX": (str, ""),
    "INTAKE_PERSONA": (str, "praw"), "DISCORD_MAX_CLIENTS": (int, 25),
}
_TOKEN_KEY = re.compile(r"^DISCORD_BOT_TOKEN_([A-Z0-9_]+)$")
_APPID_KEY = re.compile(r"^DISCORD_APP_ID_([A-Z0-9_]+)$")
_SNOWFLAKE = re.compile(r"^[0-9]{17,20}$")
COEXIST_SUFFIX = "(ใหม่)"


class ConfigError(Exception):
    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


def cli_dev_env() -> bool:
    """RC-1: process environment only (never an env file) and no Discord token. S11-11: never as the service user."""
    import pwd
    try:
        if pwd.getpwuid(os.geteuid()).pw_name == "employee":
            return False
    except KeyError:
        pass
    has_token = any(k.startswith("DISCORD_BOT_TOKEN") and v for k, v in os.environ.items())
    return os.environ.get("EMP_CLI_DEV") == "1" and not has_token


def cli_dev_allowed(config) -> bool:
    return cli_dev_env() and not getattr(config, "discord_bot_token", None) and not getattr(config, "persona_tokens", None)


def parse_env_file(path) -> dict[str, str]:
    """Parse KEY=VALUE lines into a private mapping; never touches os.environ (RC-3)."""
    out: dict[str, str] = {}
    for line in Path(path).read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.removeprefix("export ").split("=", 1)
        v = v.strip()
        if len(v) >= 2 and v[0] == v[-1] and v[0] in "'\"":
            v = v[1:-1]
        out[k.strip()] = v
    return out


def _conv(name: str, typ: type, raw: str):
    try:
        if typ is bool:
            if raw.lower() in ("1", "true", "yes", "on"):
                return True
            if raw.lower() in ("0", "false", "no", "off"):
                return False
            raise ValueError
        return typ(raw)
    except (ValueError, InvalidOperation):
        raise ConfigError(f"invalid:{name}") from None


class Config:
    # shortcut: attributes set dynamically from _SPEC (lowercase names); upgrade to a dataclass if static typing is needed.
    def __init__(self, **kw):
        self.__dict__.update(kw)

    def __repr__(self) -> str:
        shown = {k: v for k, v in self.__dict__.items() if k.upper() not in SECRETS and k not in ("persona_tokens", "system_token")}
        return f"Config({shown})"

    @classmethod
    def load(cls, env: Mapping[str, str] | None = None) -> "Config":
        """env defaults to os.environ. Pass a merged private mapping to use an env file."""
        env = os.environ if env is None else env
        vals: dict[str, object] = {}
        for name, (typ, default) in _SPEC.items():
            raw = env.get(name)
            if raw is None or raw == "":  # empty counts as unset (10.3.2)
                if default is _REQ:
                    raise ConfigError(f"missing:{name}")
                vals[name.lower()] = _conv(name, typ, default) if isinstance(default, str) else default
            else:
                vals[name.lower()] = _conv(name, typ, raw)
        v = type("V", (), vals)  # attribute view for the checks below
        _check_secrets(vals, env)
        _check_bounds(v)
        vals["voice_tmp_dir"] = _check_voice_dir(v)
        vals["database_path"] = _check_db_path(v)
        _check_memory(v)
        _check_discord(vals, env)
        masking.set_exact(_secret_values(vals))
        return cls(**vals)


def _secret_values(vals) -> list[str]:
    return [vals["discord_bot_token"], vals["anthropic_api_key"], vals["google_api_token"], vals["google_stt_api_key"],
            *vals["persona_tokens"].values(), vals["system_token"]]


def _check_secrets(vals, env) -> None:
    for name in ("DISCORD_BOT_TOKEN", "ANTHROPIC_API_KEY", "GOOGLE_API_TOKEN", "GOOGLE_STT_API_KEY"):
        s = vals[name.lower()]
        if s is not None and len(s) < masking.MIN_SECRET_LEN:
            raise ConfigError(f"secret_too_short:{name}")


CGROUP_FILE = "/proc/self/cgroup"
CGROUP_ROOT = "/sys/fs/cgroup"
BOT_BASELINE_MB = 512


def _check_db_path(c) -> str:
    try:
        return validate_db_path(c.database_path, (c.knowledge_dir, c.log_dir, c.voice_tmp_dir))
    except DbError as e:
        raise ConfigError(e.code) from None


def _check_memory(c) -> None:
    """Global rule 11: the unit's MemoryMax (shared by bot + workers) must hold the bot baseline plus every
    concurrent job's RLIMIT_AS. Skipped when not under a cgroup v2 memory limit (dev shell, macOS, tests)."""
    try:
        cg = open(CGROUP_FILE).read().strip().split("::", 1)[1]
        raw = open(CGROUP_ROOT + cg + "/memory.max").read().strip()
    except (OSError, IndexError):
        return
    if raw != "max" and int(raw) < (BOT_BASELINE_MB + c.job_max_concurrency * c.job_memory_limit_mb) * 2**20:
        raise ConfigError("bounds:MEMORY_MAX")


def _check_bounds(c) -> None:
    def need(ok: bool, code: str) -> None:
        if not ok:
            raise ConfigError(code)
    need(c.stream_edit_interval_s >= 1.0, "bounds:STREAM_EDIT_INTERVAL_S")
    need(c.stream_mode in ("typing", "edit"), "bounds:STREAM_MODE")
    need(1 <= c.brainstorm_turn_limit <= 50, "bounds:BRAINSTORM_TURN_LIMIT")
    need(c.brainstorm_token_budget >= 2 * c.brainstorm_turn_max_output_tokens, "bounds:BRAINSTORM_TOKEN_BUDGET")
    need(1 <= c.job_default_timeout_s <= 3600, "bounds:JOB_DEFAULT_TIMEOUT_S")
    need(c.reply_tier2_timeout_s < 10, "bounds:REPLY_TIER2_TIMEOUT_S")
    need(c.provider_idle_timeout_s < c.agent_run_timeout_s, "bounds:PROVIDER_IDLE_TIMEOUT_S")
    need(30 <= c.reply_active_window_s <= 3600, "bounds:REPLY_ACTIVE_WINDOW_S")
    need(c.stream_max_messages * 1900 >= c.agent_max_output_tokens, "bounds:STREAM_MAX_MESSAGES")
    need(c.budget_default_daily_usd > 0 and c.budget_gate_daily_usd > 0, "bounds:BUDGET")
    need(1 <= c.knowledge_meetings_retention_days <= 3650, "bounds:KNOWLEDGE_MEETINGS_RETENTION_DAYS")
    need(1 <= c.tasks_retention_days <= 3650, "bounds:TASKS_RETENTION_DAYS")
    need(5 <= c.voice_chunk_s <= 55, "bounds:VOICE_CHUNK_S")
    need(500 <= c.voice_silence_flush_ms <= 5000, "bounds:VOICE_SILENCE_FLUSH_MS")
    need(c.voice_min_segment_ms >= 0, "bounds:VOICE_MIN_SEGMENT_MS")
    need(1 <= c.voice_max_pending_chunks <= 20, "bounds:VOICE_MAX_PENDING_CHUNKS")
    need(5 <= c.voice_max_session_min <= 240, "bounds:VOICE_MAX_SESSION_MIN")
    need(5 <= c.voice_notice_delay_s <= 60, "bounds:VOICE_NOTICE_DELAY_S")
    need(not c.voice_live_capture or c.voice_enabled, "bounds:VOICE_LIVE_CAPTURE")
    if c.voice_enabled:
        need(c.stt_provider in ("gemini", "google-stt"), "stt_provider_invalid")
        need(c.stt_provider != "google-stt" or bool(c.google_stt_api_key), "missing:GOOGLE_STT_API_KEY")


def _check_voice_dir(c) -> str:
    p = c.voice_tmp_dir
    bad = ConfigError("voice_tmp_dir_invalid")
    if not os.path.isabs(p) or os.path.islink(p):
        raise bad
    real = os.path.realpath(p)
    if real == "/":
        raise bad
    for base in (PROJECT_ROOT, Path(c.knowledge_dir)):
        b = os.path.realpath(base)
        if real == b or real.startswith(b + os.sep):
            raise bad
    os.makedirs(p, mode=0o700, exist_ok=True)
    st = os.stat(p)
    if st.st_uid != os.geteuid() or st.st_mode & 0o077:
        raise bad
    return p


def _check_discord(vals, env) -> None:
    """Spec 12.3, 12.7 S12-05, 12.10. Per-persona tokens (suffix = persona id upper case) and app ids."""
    def need(ok: bool, code: str) -> None:
        if not ok:
            raise ConfigError(code)
    need(not (vals["discord_bot_token"] and any(_TOKEN_KEY.match(k) for k in env)), "use_per_persona_tokens")
    tokens = {m.group(1): v for k, v in env.items() if v and (m := _TOKEN_KEY.match(k))}
    apps = {}
    for k, v in env.items():
        if v and (m := _APPID_KEY.match(k)):
            apps[m.group(1)] = _conv(k, int, v)
    mode = vals["rollout_mode"]
    need(mode in ("coexist", "full"), "invalid:ROLLOUT_MODE")
    ids = [x.strip() for x in vals["channel_allowlist"].split(",") if x.strip()]
    need(all(x.isdigit() for x in ids), "invalid:CHANNEL_ALLOWLIST")
    vals["channel_allowlist"] = tuple(int(x) for x in ids)
    suffix = vals["persona_name_suffix"]
    if mode == "coexist":
        suffix = suffix if suffix else COEXIST_SUFFIX
        need(bool(suffix.strip()), "bounds:PERSONA_NAME_SUFFIX")
    vals["persona_name_suffix"] = suffix
    vals["persona_tokens"], vals["persona_app_ids"] = tokens, apps
    vals["system_token"] = vals["system_app_id"] = None  # 12.14.2
    need(vals["admin_notify_channel_id"] not in (vals["approval_channel_id"], vals["tasks_channel_id"]), "admin_channel_shared")  # S1214-04
    need(vals["settings_channel_id"] is None or vals["settings_channel_id"] != vals["admin_notify_channel_id"], "admin_channel_shared")
    if not tokens:
        return
    need(not vals["discord_bot_token"], "use_per_persona_tokens")
    for name, t in tokens.items():
        need(len(t) >= masking.MIN_SECRET_LEN, f"secret_too_short:DISCORD_BOT_TOKEN_{name}")
        need(name in apps, f"missing:DISCORD_APP_ID_{name}")
    need(len(set(tokens.values())) == len(tokens), "token_shared")
    need(len(set(apps[n] for n in tokens)) == len(tokens), "app_id_shared")
    need(1 <= vals["discord_max_clients"] <= 100, "bounds:DISCORD_MAX_CLIENTS")
    need(len(tokens) <= vals["discord_max_clients"], "too_many_clients")
    need(all(_SNOWFLAKE.fullmatch(x) for x in ids), "invalid:CHANNEL_ALLOWLIST")
    need(bool(ids) or mode == "full", "allowlist_empty")
    vals["system_token"] = tokens.pop("SYSTEM", None)  # System is no persona; masked via _secret_values
    vals["system_app_id"] = apps.get("SYSTEM") if vals["system_token"] else None
