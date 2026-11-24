"""usage_events / budgets / budget_notices access (SQLite, spec §11.7). `day` is bound as 'YYYY-MM-DD'."""
from datetime import date


async def spent(pool, agent: str, day: date) -> int:
    return int(await pool.fetchval(
        "SELECT COALESCE(SUM(cost_micro_usd), 0) FROM usage_events WHERE agent_id=?1 AND day=?2", agent, day.isoformat()))


async def limit(pool, agent: str) -> int | None:
    return await pool.fetchval("SELECT daily_limit_micro_usd FROM budgets WHERE agent_id=?1", agent)


async def insert_usage(pool, agent, day, provider, model, purpose, tin, tout, units, cost, ref) -> None:
    await pool.execute(
        "INSERT INTO usage_events (agent_id, day, provider, model, purpose, input_tokens, output_tokens, units,"
        " cost_micro_usd, ref) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",
        agent, day.isoformat(), provider, model, purpose, tin, tout, units, cost, ref)


async def first_notice(pool, agent: str, day: date, level: str) -> bool:
    """True only for the caller that inserted the row (once per agent/day/level)."""
    return await pool.fetchval(
        "INSERT INTO budget_notices (agent_id, day, level) VALUES (?1,?2,?3) ON CONFLICT DO NOTHING RETURNING 1",
        agent, day.isoformat(), level) is not None


async def upsert_limit(pool, agent: str, micro: int, by: str) -> None:
    await pool.execute(
        "INSERT INTO budgets (agent_id, daily_limit_micro_usd, updated_by) VALUES (?1,?2,?3) "
        "ON CONFLICT (agent_id) DO UPDATE SET daily_limit_micro_usd=excluded.daily_limit_micro_usd, "
        "updated_by=excluded.updated_by, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')",
        agent, micro, by)
