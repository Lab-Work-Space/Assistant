import json
import logging
import os
import stat

import pytest

from core.functions.logs import logsystem, masking
from core.functions.logs.masking import mask_secrets as M

TOKEN = "MTIzNDU2Nzg5MDEyMzQ1Njc4" + ".abcdef." + "abcdefghijklmnopqrstuvwxyz0"  # shape only, fake
SHAPES = [
    TOKEN, "sk-ant-api03-abcdefghij", "AIza" + "a" * 35, "discord.com/api/webhooks/123/abc_DEF-1",
    "postgresql://u:secretpw@h/db", "Bearer abc.def", "Authorization: Basic xyz\nx-api-key: k1", "ya29.a0Afoo-bar",
    "https://x/webhooks/123/" + "a" * 64, "plain words", "",
]


def mklog(tmp_path):
    return logsystem.Log(str(tmp_path / "app.jsonl"))


def lines(tmp_path, capsys):
    capsys.readouterr()
    return [json.loads(x) for x in (tmp_path / "app.jsonl").read_text().splitlines()]


def test_shapes_masked_and_idempotent():
    for s in SHAPES:
        assert M(M(s)) == M(s)
    for s in SHAPES[:9]:
        assert M(s) != s
    assert M("postgresql://u:secretpw@h/db") == "postgresql://u:***@h/db"
    assert "secretpw" not in M(SHAPES[6]) and "k1" not in M(SHAPES[6])
    assert M("hello world input_tokens") == "hello world input_tokens"


def test_exact_forms_and_short_ignored():
    masking.set_exact(["abc", "", None, "p@ss word/1234"])
    assert M("abc stays") == "abc stays"  # short ignored
    for form in ("p@ss word/1234", "p%40ss%20word%2F1234"):
        assert M(f"x {form} y") == "x *** y"
    masking.set_exact(['pa"ss\\word123'])
    assert M(json_dump('pa"ss\\word123')) == "***"


def json_dump(s):
    return json.dumps(s)[1:-1]


def test_write_log_masks_nested_keys_and_fields(tmp_path, capsys):
    masking.set_exact(["supersecretvalue-1"])
    lg = mklog(tmp_path)
    lg.write_log("svc", "evt", "WARNING", a="supersecretvalue-1", b={"access_token": [1, 2], "input_tokens": 5,
                 "n": [{"api-key": None, "ok": "x"}]}, c=7)
    rec = lines(tmp_path, capsys)[0]
    assert rec["system"] == "svc" and rec["level"] == "WARNING" and rec["event"] == "evt"
    assert rec["fields"] == {"a": "***", "b": {"access_token": "***", "input_tokens": 5,
                             "n": [{"api-key": "***", "ok": "x"}]}, "c": 7}


def test_no_masking_failure_when_unset_or_short(tmp_path, capsys):
    masking.set_exact(["", "ab"])
    lg = mklog(tmp_path)
    lg.write_log("s", "e", note="ab cd")
    r = lines(tmp_path, capsys)[0]
    assert r["event"] == "e" and r["fields"] == {"note": "ab cd"}


def test_masking_failure_fails_closed(tmp_path, capsys):
    masking.set_exact(["supersecretvalue-1"])
    lg = mklog(tmp_path)
    # a secret hidden in a KEY survives field masking, whole-line check catches it
    lg.write_log("s", "e", **{"supersecretvalue-1": 1})
    r = lines(tmp_path, capsys)[0]
    assert r == {"event": "log.masking_failure", "system": "s"}


def test_library_records_masked_and_levels(tmp_path, capsys):
    masking.set_exact(["supersecretvalue-1"])
    lg = mklog(tmp_path)
    h = logsystem.install_logging(lg, "INFO")
    try:
        logging.getLogger("somelib").warning("tok %s %s", "supersecretvalue-1", {"password": "x"})
        logging.getLogger("somelib").warning("d %(a)s", {"a": {"token": "q"}})
        r = lines(tmp_path, capsys)
        assert "supersecretvalue-1" not in json.dumps(r) and "***" in r[0]["fields"]["msg"]
        assert "'q'" not in r[1]["fields"]["msg"]
        for n in logsystem.LIBRARY_LOGGERS:
            assert logging.getLogger(n).getEffectiveLevel() >= logging.WARNING
    finally:
        logging.getLogger().removeHandler(h)


def test_file_modes_and_dir_checks(tmp_path):
    d = tmp_path / "logs"
    logsystem.prepare_log_dir(str(d))
    assert stat.S_IMODE(os.stat(d).st_mode) == 0o700
    lg = logsystem.Log(str(d / "app.jsonl"))
    assert stat.S_IMODE(os.stat(d / "app.jsonl").st_mode) == 0o600
    lg.close()
    (tmp_path / "ln").symlink_to(d)
    with pytest.raises(logsystem.LogDirError):
        logsystem.prepare_log_dir(str(tmp_path / "ln"))
    os.chmod(d, 0o755)
    with pytest.raises(logsystem.LogDirError):
        logsystem.prepare_log_dir(str(d))
    (tmp_path / "evil").symlink_to(tmp_path / "x")
    with pytest.raises(OSError):
        logsystem.Log(str(tmp_path / "evil"))  # O_NOFOLLOW (dangling symlink)
    os.link(d / "app.jsonl", tmp_path / "hard")
    with pytest.raises(logsystem.LogDirError):
        logsystem.Log(str(d / "app.jsonl"))  # nlink 2


def test_backslash_tail_probe():
    assert "TAIL" not in M("Authorization: abc\\TAIL")
    assert "TAIL" not in M("Bearer abc\\TAIL")
    assert "TAIL" not in M("postgresql://u:abc\\TAIL@h/d")
