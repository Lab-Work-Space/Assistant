"""Tool registry (spec 3.4 as amended by 10.4.1-2). Never logs arguments, messages or exception text."""
import asyncio
import os
import re
import time
import traceback

import jsonschema
from jsonschema.exceptions import best_match

from core.interfaces import Persona, ToolCall, ToolContext, ToolResult, ToolSpec

_NAME = re.compile(r"^[a-z][a-z0-9_]{0,63}$")
_EXC = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{0,80}$")


def _allows(entry: str, name: str) -> bool:
    return entry == "*" or entry == name or (entry.endswith("_*") and name.startswith(entry[:-1]))


class Registry:
    """Implements interfaces.ToolRegistry."""

    def __init__(self, log):
        self._log = log
        self._tools: dict[str, ToolSpec] = {}
        self._validators: dict[str, jsonschema.Draft202012Validator] = {}

    def register(self, spec: ToolSpec) -> None:
        if not _NAME.fullmatch(spec.name):
            raise ValueError("bad_tool_name")
        if spec.name in self._tools:
            raise ValueError("duplicate_tool")
        if spec.parameters.get("additionalProperties") is not False:
            raise ValueError("schema_must_forbid_additional_properties")
        jsonschema.Draft202012Validator.check_schema(spec.parameters)
        self._tools[spec.name] = spec
        self._validators[spec.name] = jsonschema.Draft202012Validator(spec.parameters)

    def for_agent(self, persona: Persona, override: tuple[str, ...] | None = None) -> list[ToolSpec]:
        entries = persona.tools if override is None else override
        # override-only tools (approval_decide/escalate) match an exact name in the override, never a wildcard
        return [s for n, s in self._tools.items()
                if (override is not None and n in entries if s.override_only else any(_allows(e, n) for e in entries))]

    def _log_call(self, ctx: ToolContext, name: str, ok: bool, error: str | None, t0: float) -> None:
        self._log.write_log("tools", "tool.call", agent=ctx.agent.id, run=ctx.run_id, name=name, ok=ok,
                            error=error, ms=int((time.monotonic() - t0) * 1000))

    async def invoke(self, ctx: ToolContext, call: ToolCall, allowed: list[ToolSpec]) -> ToolResult:
        t0 = time.monotonic()
        spec = next((s for s in allowed if s.name == call.name), None)
        res = await self._invoke(ctx, call, spec)
        self._log_call(ctx, call.name if _NAME.fullmatch(call.name) else "invalid", res.ok, res.error, t0)
        return res

    async def _invoke(self, ctx: ToolContext, call: ToolCall, spec: ToolSpec | None) -> ToolResult:
        if spec is None or self._tools.get(spec.name) is not spec:
            return ToolResult(ok=False, error="tool_not_allowed")
        err = best_match(self._validators[spec.name].iter_errors(call.arguments))
        if err is not None:
            path = "/".join(map(str, err.absolute_path)) or "$"
            self._log.write_log("tools", "tool.invalid_arguments", agent=ctx.agent.id, run=ctx.run_id,
                                name=spec.name, path=path, validator=err.validator)
            return ToolResult(ok=False, error=f"invalid_arguments path={path} validator={err.validator}")
        if spec.needs_human_trigger and ctx.human_user_id is None:
            return ToolResult(ok=False, error="needs_human")
        try:
            res = await asyncio.wait_for(spec.handler(ctx, call.arguments), spec.timeout_s)
            if not isinstance(res, ToolResult):
                raise TypeError("bad_tool_result")
            return res
        except asyncio.TimeoutError:
            return ToolResult(ok=False, error="tool_timeout")
        except Exception as e:
            tn = type(e).__name__ if _EXC.fullmatch(type(e).__name__) else "Exception"
            frames = [f"{f.filename}:{f.lineno}:{f.name}" for f in traceback.extract_tb(e.__traceback__)]
            fields = {"name": spec.name, "exc_type": tn, "frames": frames}
            if os.environ.get("LOG_LEVEL") == "DEBUG":
                fields["message"] = str(e)  # Log masks every field
            self._log.write_log("tools", "tool.error", level="ERROR", **fields)
            return ToolResult(ok=False, error=f"tool_error:{tn}")
