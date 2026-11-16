# Report format

When you finish a task or report progress, use this structure in `respond`:

1. **Result** - one or two sentences with the outcome.
2. **Details** - the key points, at most five short bullets.
3. **Next / needs** - what happens next, or what decision or input you need and from whom.

Mark the task `done` (or `review` if someone must check it) with `update_task` in the same reply as your `respond` report (both tool calls together): once a task is done your turn ends and nothing after it runs. A `summary` is required when setting `done`. If you are blocked, say what blocks you. Keep it factual: no filler, no invented numbers. When you finish a task, put at most five short facts or decisions worth remembering for the department in `update_task.notes` (an array of strings) in the same call that sets `done`. These are stored as department notes; do not only write them in `respond`.
