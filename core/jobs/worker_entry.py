"""Job subprocess entry (spec 3.10 as amended by 10.4.3 and 10.6.2). stdin: one JSON line; stdout: JSON lines."""
import importlib
import json
import os
import re
import sys

KIND_RE = re.compile(r"^[a-z][a-z0-9_]{0,63}$")
TYPE_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{0,80}$")


def _emit(obj) -> None:
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def _limits() -> None:
    try:
        import resource
        mem = int(os.environ.get("JOB_MEMORY_LIMIT_MB", "0")) * 1024 * 1024
        cpu = int(os.environ.get("JOB_CPU_LIMIT_S", "0"))
        if mem:
            resource.setrlimit(resource.RLIMIT_AS, (mem, mem))  # best-effort: macOS ignores/rejects it
        if cpu:
            resource.setrlimit(resource.RLIMIT_CPU, (cpu, cpu))
    except (ImportError, ValueError, OSError):
        pass


def main() -> int:
    req = json.loads(sys.stdin.readline())
    kind, allowed = req.get("kind"), req.get("allowed_kinds") or []
    if not isinstance(kind, str) or not KIND_RE.match(kind) or kind not in allowed:
        _emit({"type": "result", "ok": False, "data": {}, "error": "kind_not_allowed"})
        return 0
    _limits()
    try:
        mod = importlib.import_module(f"core.jobs.kinds.{kind}")
        data = mod.run(req.get("payload") or {}, lambda msg: _emit({"type": "progress", "msg": msg}))
        _emit({"type": "result", "ok": True, "data": data or {}, "error": None})
    except Exception as e:
        from core.jobs.kinds import JobError
        name = type(e).__name__
        name = name if TYPE_RE.match(name) else "Exception"
        code = e.code if isinstance(e, JobError) else "worker_exception"
        if os.environ.get("LOG_LEVEL") == "DEBUG":
            from core.functions.logs.masking import mask_secrets
            sys.stderr.write(mask_secrets(str(e)))
        _emit({"type": "result", "ok": False, "data": {}, "error": f"{name}:{code}"})
    return 0


if __name__ == "__main__":
    sys.exit(main())
