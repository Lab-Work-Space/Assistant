"""Extension entry: reply gate plugged into the Discord on_message path via ctx.discord_message_handler."""
from core.gate.conversation import Conversation
from core.gate.reply_gate import ReplyGate


def init(ctx) -> None:
    ctx.conversation = Conversation(ctx.db)
    ctx.discord_message_handler = ReplyGate(ctx).handle
