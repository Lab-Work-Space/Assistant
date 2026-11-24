"""Runtime settings (spec R9, Gate 1 T031-07). Effective value = DB row -> config/constant seed.
Read from the DB on every call (no cache). Must not import core.discord: the channel resolver is injected."""
import re

from core.approvals.depts import CHANNEL_SEEDS, DEFAULT_HEADS, DEPT_CODES, DEPT_SLUGS, HQ_ONLY, code_of

_INT = re.compile(r"^[0-9]{1,12}$")
_SNOW = re.compile(r"^[0-9]{17,20}$")
THRESHOLD_DEFAULT = 10_000
_INTS = {"approval.hq_threshold_thb": (1, 100_000_000), "approval.ttl_h": (1, 168),
         "approval.rate_per_day": (1, 100), "approval.ai_daily_max": (0, 200),
         "growth.lessons_per_day": (0, 50), "growth.overlay_max_chars": (500, 6000),
         "mcp.calls_per_min": (1, 120), "mcp.writes_per_min": (1, 60), "mcp.calls_per_day": (10, 5000)}
_CODES = tuple(DEPT_CODES[s].lower() for s in DEPT_SLUGS)
# a list: register_dept extends it in place, so every importer sees new departments (TASK-033 R21)
KEYS = [*_INTS, "approval.ai_enabled", "mcp.enabled", *(f"approval.channel.{c}" for c in _CODES), *(f"approval.head.{c}" for c in _CODES)]


def register_dept(slug: str, code: str) -> None:
    """Idempotent; mutates DEPT_CODES, DEPT_SLUGS and KEYS in place."""
    DEPT_CODES[slug] = code
    if slug not in DEPT_SLUGS:
        DEPT_SLUGS.append(slug)
    for k in (f"approval.channel.{code.lower()}", f"approval.head.{code.lower()}"):
        if k not in KEYS:
            KEYS.append(k)


class SettingsError(Exception):
    """code: unknown_key | invalid_value"""

    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


class SettingsService:
    def __init__(self, db, config, log, personas=None):
        self.db, self.cfg, self.log, self.personas = db, config, log, personas
        self.channel_ok = None   # injected by the Discord layer: (channel_id) -> bool; None = refuse every channel
        self.is_disabled = lambda pid: False  # injected: persona client disabled

    # -- seeds / reads -----------------------------------------------------------------------------------
    def seed(self, key: str) -> str:
        if key == "approval.ttl_h":
            return str(getattr(self.cfg, "approval_ttl_h", 24))
        if key == "approval.hq_threshold_thb":
            return str(THRESHOLD_DEFAULT)
        if key == "approval.rate_per_day":
            return "10"
        if key == "approval.ai_daily_max":
            return "20"
        if key == "approval.ai_enabled":
            return "on"
        if key == "mcp.enabled":
            return "on"
        if key == "mcp.calls_per_min":
            return "20"
        if key == "mcp.writes_per_min":
            return "6"
        if key == "mcp.calls_per_day":
            return "500"
        if key == "growth.lessons_per_day":
            return "3"
        if key == "growth.overlay_max_chars":
            return "3000"
        code = key.rsplit(".", 1)[1]
        slug = next(s for s in DEPT_SLUGS if DEPT_CODES[s].lower() == code)
        if key.startswith("approval.channel."):
            return str(CHANNEL_SEEDS.get(slug, "hq"))
        return DEFAULT_HEADS.get(slug, "none")

    async def get(self, key: str) -> str:
        if key not in KEYS:
            raise SettingsError("unknown_key")
        v = await self.db.fetchval("SELECT value FROM settings WHERE key=?1", key)
        return v if v is not None else self.seed(key)

    async def _int(self, key: str) -> int:
        try:
            return int(await self.get(key))
        except ValueError:
            return int(self.seed(key))

    async def threshold(self) -> int: return await self._int("approval.hq_threshold_thb")
    async def ttl_h(self) -> int: return await self._int("approval.ttl_h")
    async def rate_per_day(self) -> int: return await self._int("approval.rate_per_day")
    async def ai_daily_max(self) -> int: return await self._int("approval.ai_daily_max")
    async def lessons_per_day(self) -> int: return await self._int("growth.lessons_per_day")
    async def overlay_max_chars(self) -> int: return await self._int("growth.overlay_max_chars")
    async def ai_enabled(self) -> bool: return await self.get("approval.ai_enabled") == "on"
    async def mcp_enabled(self) -> bool: return await self.get("mcp.enabled") == "on"

    async def approval_channel(self, code: str) -> str:
        """'hq' or a snowflake text. Unknown code -> hq."""
        k = f"approval.channel.{code.lower()}"
        return await self.get(k) if k in KEYS else "hq"

    async def head(self, code: str) -> str | None:
        k = f"approval.head.{code.lower()}"
        v = await self.get(k) if k in KEYS else "none"
        return None if v == "none" else v

    # -- validation --------------------------------------------------------------------------------------
    def validate_channel(self, raw: str) -> str:
        """'hq' or an allowlisted snowflake that is neither the settings nor the admin channel."""
        raw = (raw or "").strip()
        if raw.lower() == "hq":
            return "hq"
        if not _SNOW.fullmatch(raw):
            raise SettingsError("invalid_value")
        cid = int(raw)
        if cid in (getattr(self.cfg, "settings_channel_id", None), self.cfg.admin_notify_channel_id) \
                or self.channel_ok is None or not self.channel_ok(cid):
            raise SettingsError("invalid_value")
        return str(cid)

    def validate(self, key: str, raw: str) -> str:
        if key not in KEYS:
            raise SettingsError("unknown_key")
        raw = (raw or "").strip()
        bad = SettingsError("invalid_value")
        if key in _INTS:
            s = raw.replace(",", "")
            lo, hi = _INTS[key]
            if not _INT.fullmatch(s) or not lo <= int(s) <= hi:
                raise bad
            return str(int(s))
        if key in ("approval.ai_enabled", "mcp.enabled"):
            if raw.lower() not in ("on", "off"):
                raise bad
            return raw.lower()
        code = key.rsplit(".", 1)[1]
        if key.startswith("approval.channel."):
            return self.validate_channel(raw)
        if raw.lower() == "none":
            return "none"
        p = self.personas.get(raw) if self.personas is not None else None
        if p is None or code_of(p.dept) != code.upper() or p.dept in HQ_ONLY or self.is_disabled(p.id):
            raise bad
        return p.id

    # -- writes ------------------------------------------------------------------------------------------
    async def set(self, key: str, raw: str, actor_ref: str) -> tuple[str, str]:
        val = self.validate(key, raw)
        async with self.db.transaction() as tx:
            old = await tx.fetchval("SELECT value FROM settings WHERE key=?1", key)
            await tx.execute(
                "INSERT INTO settings (key, value, updated_by) VALUES (?1,?2,?3) ON CONFLICT(key) DO UPDATE SET "
                "value=excluded.value, updated_by=excluded.updated_by, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')",
                key, val, actor_ref)
            await tx.execute("INSERT INTO audit_log (scope, ref, action, old_value, new_value, actor) "
                             "VALUES ('setting', ?1, 'set', ?2, ?3, ?4)", key, old, val, actor_ref)
        self.log.write_log("settings", "settings.changed", "WARNING", id=key, by=actor_ref, status="set")
        return old if old is not None else self.seed(key), val

    async def reset(self, key: str, actor_ref: str) -> str:
        if key not in KEYS:
            raise SettingsError("unknown_key")
        async with self.db.transaction() as tx:
            old = await tx.fetchval("SELECT value FROM settings WHERE key=?1", key)
            await tx.execute("DELETE FROM settings WHERE key=?1", key)
            await tx.execute("INSERT INTO audit_log (scope, ref, action, old_value, new_value, actor) "
                             "VALUES ('setting', ?1, 'reset', ?2, ?3, ?4)", key, old, self.seed(key), actor_ref)
        self.log.write_log("settings", "settings.changed", "WARNING", id=key, by=actor_ref, status="reset")
        return self.seed(key)

    async def view(self, key: str | None = None) -> list[tuple[str, str, str]]:
        """(key, effective value, 'db'|'default')."""
        keys = KEYS if key is None else (key,)
        if key is not None and key not in KEYS:
            raise SettingsError("unknown_key")
        rows = {r["key"]: r["value"] for r in await self.db.fetch("SELECT key, value FROM settings")}
        return [(k, rows.get(k, self.seed(k)), "db" if k in rows else "default") for k in keys]
