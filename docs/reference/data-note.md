# Data note

Where the messages the bots see are sent, and whose account and terms apply.

## Data note

When the local provider (`claude-code-local`) is on, every message the bots see from guild members is sent to Anthropic through **your consumer account**. Its data and training settings apply (check Settings > Privacy in Claude and turn model-improvement off if you do not want chats used for training). Also confirm that the subscription terms allow an automated multi-user bot like this one; if they do not, use the Claude API with `ANTHROPIC_API_KEY` instead (the default provider, also used on the VPS). Re-run the probe after every CLI upgrade (Gate 1 L11).

The consumer-account settings above apply only to the local provider. The default Claude API provider uses `ANTHROPIC_API_KEY` instead (see [Providers and models](../configuration/providers-and-models.md)). Praw's messages go to Google under the terms described in [Praw](../features/praw.md#gemini-data-terms-p12).

Back to the [documentation index](../_index.md).
