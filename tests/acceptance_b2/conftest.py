import pytest_asyncio

from tests.voice.vfakes import make_world


@pytest_asyncio.fixture
async def w(tmp_path, db):
    """Fake world (FakeBudget). TTS_MODEL carries the real price key so usage rows can be checked."""
    return make_world(tmp_path, db, TTS_MODEL="google/gemini-3.8-flash-tts")


@pytest_asyncio.fixture
async def wr(tmp_path, db):
    """Same world, but the REAL budget Guard over the real SQLite schema."""
    from types import SimpleNamespace as NS
    from core.budget.guard import Guard
    x = make_world(tmp_path, db, TTS_MODEL="google/gemini-3.8-flash-tts")
    x.ctx.budget = Guard(NS(config=x.cfg, log=x.log, db=db, personas=x.ctx.personas, approver_policy=x.ctx.approver_policy))
    return x
