"""Growth package (TASK-033): reviewed lessons -> versioned overlay prompts; runtime staff/departments."""

# Worst case wrapped block is 2*6500 + 2 + 200 = 13202 (G033-04), so the cap must sit above it; an overlay over the cap is dropped, never sliced.
OVERLAY_HARD_MAX_CHARS = 13300


class GrowthError(Exception):
    def __init__(self, code: str, message: str = ""):
        super().__init__(message or code)
        self.code = code
