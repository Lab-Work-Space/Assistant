"""AT-6 cap, AT-7 rollback, G033-01 render from approved ids, bound constants."""
import json
import types

import pytest

from core.agents.untrusted import wrap_untrusted
from core.growth import OVERLAY_HARD_MAX_CHARS, GrowthError
from core.growth.overlays import OverlayService

CFG = {"cap": 3000}


class S:
    async def get(self, key):
        return str(CFG["cap"])


class Log:
    def write_log(self, *a, **k):
        pass


PERSONA = types.SimpleNamespace(id="sub", dept="account")


async def lesson(db, n, body=None, status="approved", scope=("persona", "sub")):
    code = f"LSN-FIN-{n:04d}"
    await db.execute(
        "INSERT INTO lessons (id, code, dept, proposed_by, scope_kind, scope_id, category, body, status, decided_at)"
        " VALUES (?1,?2,'FIN','sub',?3,?4,'method',?5,?6, strftime('%Y-%m-%dT%H:%M:%fZ','now', ?7))",
        f"{n:036d}", code, scope[0], scope[1] if scope[0] == "persona" else "FIN", body or f"lesson body number {n} xxxxxxxxxx",
        status, f"+{n} seconds")
    return code


async def rb(o, db, **kw):
    from core.growth.overlays import max_chars
    cap = await max_chars(o.settings)  # read before the tx (DEFECT-001)
    async with db.transaction() as tx:
        return await o.rebuild(tx, "persona", "sub", add=kw.get("add"), remove=kw.get("remove"),
                               reason="lesson_removed" if kw.get("remove") else "lesson_approved", actor_ref="agent:mali", cap=cap)


async def test_bounds():
    assert 6000 + 100 <= 6500 and 2 * 6500 + 2 + 200 <= OVERLAY_HARD_MAX_CHARS
    worst = wrap_untrusted("x" * (2 * 6500 + 2), "overlay")
    assert len(worst) <= OVERLAY_HARD_MAX_CHARS


async def test_rebuild_rollback_and_block(db):
    CFG["cap"] = 3000
    o = OverlayService(db, S(), Log())
    a, b = await lesson(db, 1), await lesson(db, 2)
    assert await rb(o, db, add=a) == 1
    assert await rb(o, db, add=a) is None  # nothing changed
    assert await rb(o, db, add=b) == 2
    blk = await o.prompt_block(PERSONA)
    assert blk.startswith('<untrusted source="overlay"') and f"[{a}]" in blk and f"[{b}]" in blk and "v2" in blk
    await db.execute("UPDATE lessons SET status='rejected' WHERE code=?1", b)  # human override
    assert await rb(o, db, remove=b) == 3
    assert f"[{b}]" not in await o.prompt_block(PERSONA)
    assert await o.rollback("persona", "sub", 1, "discord:1") == (3, 1)
    assert await o.rollback("persona", "sub", 0, "discord:1") == (1, 0)
    assert await o.prompt_block(PERSONA) == ""
    with pytest.raises(GrowthError) as e:
        await o.rollback("persona", "sub", 9, "discord:1")
    assert e.value.code == "version_not_found"
    with pytest.raises(GrowthError):
        await o.rollback("persona", "sub", 0, "discord:1")
    await o.rollback("persona", "sub", 1, "discord:1")
    assert await rb(o, db, add=b) is None  # b is rejected: next rebuild starts from v1, still only a
    c = await lesson(db, 3)
    assert await rb(o, db, add=c) == 4
    ids = json.loads(await db.fetchval("SELECT lesson_ids FROM overlay_versions WHERE version=4"))
    assert ids == [a, c]
    acts = [r["action"] for r in await db.fetch("SELECT action FROM audit_log WHERE scope='overlay' ORDER BY id")]
    assert acts.count("rollback") == 3 and acts.count("activate") == 4
    assert [h["version"] for h in await o.history("persona", "sub")] == [4, 3, 2, 1]


async def test_g033_01_deleted_lesson_stays_out_after_rollback(db):
    o = OverlayService(db, S(), Log())
    a = await lesson(db, 1, body="alpha unique marker lesson body")
    await rb(o, db, add=a)
    await db.execute("UPDATE lessons SET status='deleted' WHERE code=?1", a)
    await rb(o, db, remove=a)  # v2 empty
    await o.rollback("persona", "sub", 1, "discord:1")
    assert "alpha unique marker" not in await o.prompt_block(PERSONA)  # stored v1 body still has it; render does not


async def test_cap_drops_oldest_first(db):
    CFG["cap"] = 500
    o = OverlayService(db, S(), Log())
    codes = [await lesson(db, i, body=("w%d " % i) * 40) for i in range(1, 6)]  # ~120+ chars each
    for c in codes:
        await rb(o, db, add=c)
    row = await db.fetchrow("SELECT * FROM overlay_versions ORDER BY version DESC LIMIT 1")
    kept, dropped = json.loads(row["lesson_ids"]), json.loads(row["dropped_ids"])
    assert len(row["body"]) <= 500 and dropped and kept[-1] == codes[-1]
    assert codes[0] not in kept and set(kept).isdisjoint(dropped) and kept == codes[-len(kept):]
    CFG["cap"] = 3000


async def test_dept_block_first(db):
    o = OverlayService(db, S(), Log())
    d = await lesson(db, 1, scope=("dept", "FIN"))
    p = await lesson(db, 2)
    async with db.transaction() as tx:
        await o.rebuild(tx, "dept", "FIN", add=d, remove=None, reason="lesson_approved", actor_ref="agent:mali", cap=3000)
    await rb(o, db, add=p)
    blk = await o.prompt_block(PERSONA)
    assert blk.index("dept FIN") < blk.index("persona sub")
