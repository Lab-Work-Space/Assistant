from __future__ import annotations

from dataclasses import dataclass, field
from decimal import Decimal
from typing import TYPE_CHECKING, Any, AsyncIterator, Awaitable, Callable, Literal, Protocol

if TYPE_CHECKING:
    from core.db.sqlite import Database
    import discord

Effort = Literal["low", "medium", "high"]
Trigger = Literal["human_message", "task_assigned", "brainstorm_turn", "brainstorm_summary",
                  "approval_decided", "voice_note", "approval_review"]
BudgetLevel = Literal["ok", "warn", "fallback", "stop"]
GateRule = Literal["dm", "mention", "reply_to_agent", "active_conversation", "name_tier1",
                   "name_tier2", "silent", "ignored"]

Surface = Literal["discord", "cli"]
ApprovalAction = Literal["approve", "reject"]
DecisionOutcome = Literal["approved", "rejected", "not_approver", "already_decided", "expired", "not_found"]
SetLimitOutcome = Literal["ok", "not_approver", "invalid_agent", "out_of_range"]

import re as _re

_ACTOR_ID = {"discord": _re.compile(r"^[0-9]{17,20}$"), "cli": _re.compile(r"^[a-z][a-z0-9_-]{0,31}$")}


@dataclass(frozen=True)
class Actor:
    """A human who acts on the system. Built by the surface (Discord interaction or CLI); carries no roles.
    Authorisation is decided only by ApproverPolicy, which fetches fresh role data itself."""
    kind: Surface
    user_id: str            # discord: snowflake digits; cli: "admin" | "user"
    display_name: str = ""  # untrusted, display only, never used for decisions

    def __post_init__(self) -> None:
        if self.kind not in _ACTOR_ID or not _ACTOR_ID[self.kind].fullmatch(self.user_id):
            raise ValueError("invalid_actor")

    @property
    def ref(self) -> str:
        return f"{self.kind}:{self.user_id}"   # stored in approvals.decided_by / budgets.updated_by


@dataclass(frozen=True)
class Persona:
    id: str
    name: str
    aliases: tuple[str, ...]
    role: str
    dept: str
    model: str
    cheap_model: str
    effort: Effort
    tools: tuple[str, ...]
    traits: tuple[str, ...]
    color: int
    avatar_url: str | None
    fragments: tuple[str, ...]
    body: str
    path: str


class PersonaRegistry(Protocol):
    def get(self, agent_id: str) -> Persona | None: ...
    def all(self) -> list[Persona]: ...
    def by_name(self, display_name: str) -> Persona | None: ...


@dataclass
class ToolCall:
    id: str
    name: str
    arguments: dict[str, Any]
    signature: bytes | None = None  # Gemini 3 thought_signature: must be echoed back on the next turn or the API 400s


@dataclass
class ChatMessage:
    role: Literal["user", "assistant", "tool"]
    content: str = ""
    tool_calls: list[ToolCall] = field(default_factory=list)
    tool_call_id: str | None = None
    name: str | None = None


@dataclass
class Usage:
    input_tokens: int = 0
    output_tokens: int = 0


@dataclass
class StreamEvent:
    kind: Literal["text", "tool_call", "usage", "done"]
    text: str = ""
    tool_call: ToolCall | None = None
    usage: Usage | None = None
    stop_reason: str | None = None  # done: end | tool_use | max_tokens | safety


class ProviderError(Exception):
    """code: timeout | rate_limited | auth | bad_request | model_not_found | safety | unavailable"""

    def __init__(self, code: str, message: str = "", retryable: bool = False):
        super().__init__(f"{code}: {message}")
        self.code = code
        self.retryable = retryable


@dataclass
class ToolResult:
    ok: bool
    content: str = ""
    error: str | None = None
    data: dict[str, Any] = field(default_factory=dict)


class ReplySink(Protocol):
    async def start(self) -> None: ...
    async def write(self, delta: str) -> None: ...
    async def finish(self) -> list[int]: ...
    async def fail(self, user_text: str) -> None: ...
    async def send_embed(self, embed: "discord.Embed", view: Any | None = None) -> int: ...
    async def send_file(self, filename: str, data: bytes, content: str = "") -> int: ...


@dataclass
class ToolContext:
    agent: Persona
    run_id: str
    guild_id: int | None
    channel_id: int
    thread_id: int | None
    trigger: Trigger
    human_user_id: int | None
    sink: ReplySink
    origin: Surface
    human_actor: Actor | None = None
    thread_record_id: str | None = None
    approval_id: str | None = None  # server-set, only on approval_review runs




ToolHandler = Callable[[ToolContext, dict[str, Any]], Awaitable[ToolResult]]


@dataclass(frozen=True)
class ToolSpec:
    name: str
    description: str
    parameters: dict[str, Any]
    handler: ToolHandler
    timeout_s: float = 30.0
    needs_human_trigger: bool = False
    override_only: bool = False  # offered only when named exactly in tools_override, never via "*" / "x_*" (T031-01)


class ToolRegistry(Protocol):
    def register(self, spec: ToolSpec) -> None: ...
    def for_agent(self, persona: Persona, override: tuple[str, ...] | None = None) -> list[ToolSpec]: ...
    async def invoke(self, ctx: ToolContext, call: ToolCall,
                     allowed: list[ToolSpec]) -> ToolResult: ...


class ProviderAdapter(Protocol):
    name: str

    def stream(self, *, model: str, system: str, messages: list[ChatMessage], tools: list[ToolSpec],
               max_output_tokens: int, effort: Effort, timeout_s: float) -> AsyncIterator[StreamEvent]: ...

    async def complete(self, *, model: str, system: str, prompt: str, max_output_tokens: int,
                       timeout_s: float) -> tuple[str, Usage]: ...


@dataclass
class AgentRequest:
    agent_id: str
    trigger: Trigger
    guild_id: int | None
    channel_id: int
    thread_id: int | None
    human_user_id: int | None
    text: str
    origin: Surface
    human_actor: Actor | None = None
    author_name: str = ""
    context: list[tuple[str, str]] = field(default_factory=list)
    sink: ReplySink | None = None
    thread_record_id: str | None = None
    max_output_tokens: int | None = None
    tools_override: tuple[str, ...] | None = None
    system_extra: str = ""
    approval_id: str | None = None


@dataclass
class AgentResult:
    ok: bool
    text: str
    message_ids: list[int]
    usage: Usage
    tool_calls: list[str]
    run_id: str
    error: str | None = None


class AgentEngine(Protocol):
    async def run(self, req: AgentRequest) -> AgentResult: ...


class BudgetGuard(Protocol):
    async def level(self, agent_id: str) -> BudgetLevel: ...
    async def record(self, agent_id: str, provider: str, model: str, usage: Usage, purpose: str,
                     units: int = 0, ref: str | None = None) -> None: ...
    async def set_limit(self, agent_id: str, usd: Decimal, actor: Actor) -> SetLimitOutcome: ...


class NoopBudgetGuard:
    """Tests only. init_core refuses to start with this guard when any provider is registered."""

    async def level(self, agent_id: str) -> BudgetLevel:
        return "ok"

    async def record(self, agent_id: str, provider: str, model: str, usage: Usage, purpose: str,
                     units: int = 0, ref: str | None = None) -> None:
        return None

    async def set_limit(self, agent_id: str, usd: Decimal, actor: Actor) -> SetLimitOutcome:
        return "not_approver"


@dataclass
class GateDecision:
    reply: bool
    agent_id: str | None
    rule: GateRule


class ConversationState(Protocol):
    async def touch(self, channel_id: int, user_id: int, agent_id: str) -> None: ...


@dataclass
class JobKind:
    name: str
    timeout_s: int
    env_secrets: tuple[str, ...] = ()
    on_done: Callable[[dict[str, Any]], Awaitable[None]] | None = None


class JobRunner(Protocol):
    def register_kind(self, kind: JobKind) -> None: ...
    async def enqueue(self, kind: str, payload: dict[str, Any], created_by: str,
                      timeout_s: int | None = None) -> str: ...
    async def cancel(self, job_id: str) -> bool: ...
    async def wait(self, job_id: str, timeout_s: float | None = None) -> dict[str, Any]: ...


class ApproverPolicy(Protocol):
    surface: Surface

    async def is_approver(self, actor: Actor) -> bool: ...   # must fail closed (False) on any lookup error


@dataclass(frozen=True)
class Decision:
    outcome: DecisionOutcome
    approval: dict[str, Any] | None = None   # row after the update (approved/rejected only)


class ApprovalPresenter(Protocol):
    async def show_request(self, approval: dict[str, Any]) -> tuple[int | None, int | None]: ...  # (channel_id, message_id)
    async def show_decision(self, approval: dict[str, Any], actor: Actor | None) -> None: ...     # actor None = expired
    # optional: show_moved(old_channel_id, old_message_id, approval) edits the old card after an escalation to HQ


class ApprovalService(Protocol):
    def register_handler(self, kind: str, handler: Callable[[dict[str, Any]], Awaitable[None]]) -> None: ...
    async def request(self, *, kind: str, title: str, summary: str, access: list[str], requested_by: str,
                      origin: Surface, human_user_id: int | None,
                      origin_channel_id: int, origin_thread_id: int | None,
                      payload: dict[str, Any], **card: Any) -> str: ...
    async def decide(self, approval_id: str, action: ApprovalAction, actor: Actor) -> Decision: ...


ButtonHandler = Callable[["discord.Interaction", str, str], Awaitable[None]]  # (interaction, action, entity_id)


class ButtonRouter(Protocol):
    def register(self, kind: str, handler: ButtonHandler) -> None: ...


class TargetError(Exception):
    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


class SinkFactory(Protocol):
    def for_channel(self, channel: Any, persona: Persona) -> ReplySink: ...
    def for_dm(self, user: Any, persona: Persona) -> ReplySink: ...
    def null(self) -> ReplySink: ...
    async def for_target(self, kind: Literal["thread", "dm"], target_id: int, persona: Persona,
                         ctx: ToolContext) -> ReplySink: ...   # raises TargetError(code)


class VoiceHooks(Protocol):
    async def after_reply(self, guild_id: int | None, user_id: int, persona: Persona, text: str, channel_id: int | None = None) -> None: ...


@dataclass
class AppContext:
    config: Any
    log: Any
    db: "Database"
    personas: PersonaRegistry
    surface: Surface
    approver_policy: ApproverPolicy
    bot: "discord.Bot | None" = None   # None in the CLI
    budget: BudgetGuard = field(default_factory=NoopBudgetGuard)
    providers: dict[str, ProviderAdapter] = field(default_factory=dict)
    tools: ToolRegistry | None = None
    engine: AgentEngine | None = None
    sinks: SinkFactory | None = None
    buttons: ButtonRouter | None = None   # None in the CLI
    jobs: JobRunner | None = None
    approvals: ApprovalService | None = None
    conversation: ConversationState | None = None
    voice: VoiceHooks | None = None
    knowledge: Any | None = None             # set by core.agent_tools.knowledge
    task_service: Any | None = None          # set by core.tasks.ext
    threads: Any | None = None               # ThreadPort, set by the surface
    approval_presenter: Any | None = None    # ApprovalPresenter, set by the surface
    settings: Any | None = None              # SettingsService, set by core.settings.ext


def require_real_budget(ctx: AppContext) -> None:
    if ctx.providers and isinstance(ctx.budget, NoopBudgetGuard):
        raise RuntimeError("budget_guard_missing")


# RC-1 (spec 10.17): lives here, never in core/cli. Never collide with Discord snowflakes (>= 17 digits).
CLI_HUMAN_IDS = {"admin": 1, "user": 2}
