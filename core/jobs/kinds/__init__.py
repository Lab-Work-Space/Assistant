"""Job kinds: one module per kind exposing run(payload, progress) -> dict. Spec 10.4.3."""
import re


class JobError(Exception):
    """Fixed-code failure; only `code` ever reaches logs/DB (never free text)."""

    def __init__(self, code: str):
        if not re.fullmatch(r"[a-z_]{1,40}", str(code)):
            code = "worker_exception"
        super().__init__(code)
        self.code = code
