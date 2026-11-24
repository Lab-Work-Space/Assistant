import pytest_asyncio

from tests.voice.vfakes import make_world


@pytest_asyncio.fixture
async def w(tmp_path, db):
    return make_world(tmp_path, db)
