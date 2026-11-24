"""G2-05: secrets stay out of git. Lock is hashed and has no test deps (moved from test_container.py; spec 11.18.10)."""
import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]


@pytest.mark.skipif(not shutil.which("git"), reason="git missing")
@pytest.mark.parametrize("name", [".env.local", ".env.prod.local", "logs/x.log", "knowledge/meetings/x.md"])
def test_gitignore_covers_secrets(tmp_path, name):
    shutil.copy(ROOT / ".gitignore", tmp_path / ".gitignore")
    subprocess.run(["git", "init", "-q"], cwd=tmp_path, check=True)
    r = subprocess.run(["git", "check-ignore", name], cwd=tmp_path, capture_output=True, text=True)
    assert r.returncode == 0, f"{name} is not git-ignored"


@pytest.mark.skipif(not shutil.which("git"), reason="git missing")
@pytest.mark.parametrize("name", ["core/db/sqlite.py", "core/migration/versions/0001_phase1.sql", "deploy/install.sh",
                                  "constraints/requirements.lock", "knowledge/meetings/.gitkeep", ".env.example"])
def test_gitignore_keeps_sources(tmp_path, name):
    """Global rule 19: the secret patterns must not swallow source files."""
    shutil.copy(ROOT / ".gitignore", tmp_path / ".gitignore")
    subprocess.run(["git", "init", "-q"], cwd=tmp_path, check=True)
    r = subprocess.run(["git", "check-ignore", name], cwd=tmp_path, capture_output=True, text=True)
    assert r.returncode == 1, f"{name} is git-ignored"


def test_lock_is_hashed_and_has_no_test_deps():
    lock = (ROOT / "constraints" / "requirements.lock").read_text()
    assert "--hash=sha256:" in lock and "py-cord==2.8.1" in lock
    assert "\npytest" not in lock
