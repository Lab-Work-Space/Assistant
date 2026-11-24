"""Versioned overlay prompts (R14-R15, R19, G033-01). The prompt is always rendered from the active version's lesson_ids
filtered to approved lessons; overlay_versions.body is history only."""
import json

from core.agents.untrusted import wrap_untrusted
from core.approvals.depts import code_of
from core.growth import GrowthError

_KINDS = ("persona", "dept")
_AUDIT = ("INSERT INTO audit_log (scope, ref, action, field, old_value, new_value, actor) "
          "VALUES ('overlay',?1,?2,'version',?3,?4,?5)")


async def max_chars(settings) -> int:
    try:  # T4 adds the key; until then (or on a bad value) use the default
        return min(6000, max(500, int(await settings.get("growth.overlay_max_chars"))))
    except Exception:
        return 3000


def _render(kind, sid, n, lessons, cap):
    """lessons: [(code, body)] oldest first. -> (body, kept codes, dropped codes)."""
    lessons = list(lessons)
    dropped = []

    def text():
        return "\n".join([f"Learned guidance ({kind} {sid}, v{n})", *(f"- [{c}] {b}" for c, b in lessons)])
    while lessons and len(text()) > cap:
        dropped.append(lessons.pop(0)[0])
    return text(), [c for c, _ in lessons], dropped


def _ref(kind, sid):
    return f"{kind}:{sid}"


class OverlayService:
    def __init__(self, db, settings, log):
        self.db, self.settings, self.log = db, settings, log

    async def _approved(self, q, kind, sid, codes):
        """[(code, body)] for codes that are approved lessons of this scope, oldest decision first."""
        if not codes:
            return []
        rows = await q.fetch(
            "SELECT code, body FROM lessons WHERE scope_kind=?1 AND scope_id=?2 AND status='approved' "
            "AND code IN (SELECT value FROM json_each(?3)) ORDER BY decided_at, code", kind, sid, json.dumps(list(codes)))
        return [(r["code"], r["body"]) for r in rows]

    async def _active(self, q, kind, sid):
        """(version, lesson_ids) of the active version; (0, []) when none."""
        v = await q.fetchval("SELECT version FROM overlay_active WHERE scope_kind=?1 AND scope_id=?2", kind, sid)
        if not v:
            return 0, []
        ids = await q.fetchval("SELECT lesson_ids FROM overlay_versions WHERE scope_kind=?1 AND scope_id=?2 AND version=?3",
                               kind, sid, v)
        return v, json.loads(ids or "[]")

    async def _block(self, kind, sid, cap) -> str:
        v, ids = await self._active(self.db, kind, sid)
        lessons = await self._approved(self.db, kind, sid, ids)
        return _render(kind, sid, v, lessons, cap)[0] if lessons else ""

    async def prompt_block(self, persona) -> str:
        cap = await max_chars(self.settings)
        parts = [b for b in (await self._block("dept", code_of(persona.dept), cap),
                             await self._block("persona", persona.id, cap)) if b]
        return wrap_untrusted("\n\n".join(parts), "overlay") if parts else ""

    async def rebuild(self, tx, scope_kind, scope_id, *, add, remove, reason, actor_ref, cap: int) -> int | None:
        """cap: read with max_chars() BEFORE opening tx; settings.get inside a tx self-deadlocks (DEFECT-001)."""
        cur, base = await self._active(tx, scope_kind, scope_id)
        codes = (set(base) | ({add} if add else set())) - ({remove} if remove else set())
        lessons = await self._approved(tx, scope_kind, scope_id, codes)
        n = (await tx.fetchval("SELECT COALESCE(MAX(version),0) FROM overlay_versions WHERE scope_kind=?1 AND scope_id=?2",
                               scope_kind, scope_id)) + 1
        body, kept, dropped = _render(scope_kind, scope_id, n, lessons, cap)
        if kept == base and not dropped:
            return None
        await tx.execute("INSERT INTO overlay_versions (scope_kind, scope_id, version, body, lesson_ids, dropped_ids, reason,"
                         " created_by) VALUES (?1,?2,?3,?4,?5,?6,?7,?8)", scope_kind, scope_id, n, body, json.dumps(kept),
                         json.dumps(dropped), reason, actor_ref)
        await self._point(tx, scope_kind, scope_id, n, actor_ref)
        await tx.execute(_AUDIT, _ref(scope_kind, scope_id), "activate", str(cur), str(n), actor_ref)
        return n

    async def _point(self, tx, kind, sid, n, actor_ref):
        await tx.execute("INSERT INTO overlay_active (scope_kind, scope_id, version, updated_by) VALUES (?1,?2,?3,?4) "
                         "ON CONFLICT (scope_kind, scope_id) DO UPDATE SET version=excluded.version, "
                         "updated_by=excluded.updated_by, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')", kind, sid, n, actor_ref)

    async def history(self, scope_kind, scope_id, limit=15) -> list[dict]:
        act = (await self._active(self.db, scope_kind, scope_id))[0]
        rows = await self.db.fetch(
            "SELECT version, reason, created_by, created_at, lesson_ids, dropped_ids FROM overlay_versions "
            "WHERE scope_kind=?1 AND scope_id=?2 ORDER BY version DESC LIMIT ?3", scope_kind, scope_id, limit)
        return [{**r, "lesson_ids": json.loads(r["lesson_ids"]), "dropped_ids": json.loads(r["dropped_ids"]),
                 "active": r["version"] == act} for r in rows]

    async def rollback(self, scope_kind, scope_id, version: int, actor_ref: str) -> tuple[int, int]:
        if scope_kind not in _KINDS:
            raise GrowthError("bad_scope")
        async with self.db.transaction() as tx:
            old = (await self._active(tx, scope_kind, scope_id))[0]
            if version != 0 and not await tx.fetchval(
                    "SELECT 1 FROM overlay_versions WHERE scope_kind=?1 AND scope_id=?2 AND version=?3", scope_kind, scope_id, version):
                raise GrowthError("version_not_found")
            if version == old:
                raise GrowthError("same_version")
            await self._point(tx, scope_kind, scope_id, version, actor_ref)
            await tx.execute(_AUDIT, _ref(scope_kind, scope_id), "rollback", str(old), str(version), actor_ref)
        self.log.write_log("growth", "growth.overlay_rollback", "INFO", scope=_ref(scope_kind, scope_id), to=version)
        return old, version
