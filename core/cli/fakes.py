"""Deterministic fake providers (no network, no keys): `python -m core.cli --fake` and the Slice A acceptance run."""
import sys
import types
import re
from datetime import date, timedelta

from core.interfaces import StreamEvent, ToolCall, Usage

def card_fields() -> dict:
    """Complete approval/task card fields (spec R7): a due date tomorrow, a small honest value."""
    return {"reason": "needed to continue the work", "value_thb": 500, "priority": "normal",
            "due": (date.today() + timedelta(days=1)).isoformat()}


PNG = b"\x89PNG\r\n\x1a\nFAKE-IMAGE-BYTES"


FAKE_ENV = {  # placeholders so --fake loads with no .env; real env values still win
    "DISCORD_GUILD_ID": "1", "APPROVAL_CHANNEL_ID": "2", "ADMIN_NOTIFY_CHANNEL_ID": "3", "TASKS_CHANNEL_ID": "4",
    "DEFAULT_CHEAP_MODEL": "google/fake", "REPLY_TIER2_MODEL": "google/fake", "IMAGE_MODEL": "google/fake-image",
    "TTS_MODEL": "google/fake-tts", "TTS_VOICE": "fake", "STT_PROVIDER": "google", "STT_MODEL": "fake",
}


def fake_providers() -> dict:
    return {"google": FakeProv("[fake] "), "anthropic": FakeProv("[fake] ")}


def stub_discord() -> None:
    """The CLI has no Discord; a few tool paths build discord.Embed (plain data) - stub it when py-cord is absent."""
    try:
        import discord  # noqa: F401
    except ImportError:
        class Embed:
            def __init__(self, title="", description="", colour=0):
                self.title, self.description, self.fields = title, description, []

            def add_field(self, name, value, inline=True):
                self.fields.append(types.SimpleNamespace(name=name, value=value))
        sys.modules["discord"] = types.SimpleNamespace(Embed=Embed)


class FakeProv:
    name = "fake"

    def __init__(self, label: str = ""):
        self.label = label  # prefix of the first text chunk of every reply

    async def generate_image(self, **kw):
        return PNG

    async def stream(self, *, model, system, messages, tools, **kw):
        last, first = messages[-1], messages[0].content
        ntool = sum(1 for m in messages if m.role == "tool")
        call = None
        if last.role != "tool" and "delegate this task to" in first:
            who = first.split("delegate this task to ")[1].split()[0]
            call = ToolCall("c1", "task_create", {"assignee_agent_id": who, "title": "write the report",
                                                            "description": "Write the quarterly report for the team.",
                                                            "priority": card_fields()["priority"], "due": card_fields()["due"],
                                                            "value_thb": 500})
        elif last.role != "tool" and "NEEDAPPROVAL" in first:
            call = ToolCall("c2", "approval_request", {"title": "Use tool X", "summary": "Use tool X to finish the task.",
                                                             **card_fields()})
        elif last.role != "tool" and "KNOWQ" in first:
            call = ToolCall("k1", "knowledge_read_index", {"area": "notes"})
        elif last.role == "tool" and "KNOWQ" in first and ntool == 1:
            m = re.search(r"\]\(([a-z0-9-]+\.md)\)[^\n]*alpha|\[[^\]]*alpha[^\]]*\]\(([a-z0-9-]+\.md)\)", last.content)
            call = ToolCall("k2", "knowledge_read", {"area": "notes", "file": (m.group(1) or m.group(2)) if m else "missing.md"})
        elif last.role != "tool" and "IMAGEQ" in first:
            call = ToolCall("i1", "image_generate", {"prompt": "a cat", "aspect": "1:1"})
        if call:
            yield StreamEvent("tool_call", tool_call=call)
        else:
            if "KNOWQ" in first and ntool:
                txt = ["Found: ", "ALPHA-BODY-MARKER" if "ALPHA-BODY-MARKER" in last.content else "no body"]
            elif "IMAGEQ" in first and ntool:
                txt = ["Image sent: ", last.content[:40]]
            elif "ECHOQ" in first:  # echo user text split across chunks (masking probe)
                line = [ln for ln in first.splitlines() if "ECHOQ" in ln][-1]
                txt = ["echo: ", line[: len(line) // 2], line[len(line) // 2:], "\n"]
            elif "was approved" in first:
                txt = ["Thanks, approval received"]
            elif "was rejected" in first or "rejected" in first:
                txt = ["Understood, approval rejected"]
            else:
                txt = ["reply from ", f"{model}\n"]
            txt[0] = self.label + txt[0]
            for t in txt:
                yield StreamEvent("text", text=t)
        yield StreamEvent("usage", usage=Usage(5, 5))
        yield StreamEvent("done", stop_reason="end")
