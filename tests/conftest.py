import os

import pytest
import pytest_asyncio

from core.db.sqlite import open_database
from core.functions.logs import masking
from core.migration.runner import migrate


@pytest.fixture(autouse=True)
def _reset_masking():
    masking.set_exact([])
    yield
    masking.set_exact([])


def make_db_path(base) -> str:
    d = os.path.join(str(base), "data")
    os.makedirs(d, mode=0o700, exist_ok=True)
    os.chmod(d, 0o700)
    p = os.path.join(d, "emp.db")
    migrate(p)
    return p


@pytest_asyncio.fixture
async def db(tmp_path):
    d = await open_database(make_db_path(tmp_path))
    yield d
    await d.close()


def base_env(tmp_path):
    return {
        "DATABASE_PATH": str(tmp_path / "data" / "emp.db"),
        "DISCORD_GUILD_ID": "1", "APPROVAL_CHANNEL_ID": "2", "ADMIN_NOTIFY_CHANNEL_ID": "3", "TASKS_CHANNEL_ID": "4",
        "DEFAULT_CHEAP_MODEL": "google/x", "REPLY_TIER2_MODEL": "google/x", "IMAGE_MODEL": "google/i",
        "TTS_MODEL": "google/t", "TTS_VOICE": "v", "STT_PROVIDER": "google", "STT_MODEL": "s",
        "VOICE_TMP_DIR": str(tmp_path / "voice"), "KNOWLEDGE_DIR": str(tmp_path / "k"),
    }


def task_card(**over) -> dict:
    """Complete task_create card fields (spec R7); due is tomorrow so it never goes stale."""
    from datetime import date, timedelta
    return {"description": "Do the work described in this card.", "priority": "normal",
            "due": (date.today() + timedelta(days=1)).isoformat(), "value_thb": 500, **over}
