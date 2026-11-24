"""split_message (spec 3.3): greedy, prefix-stable, never breaks code fences or Thai combining marks."""
import unicodedata

_MARKS = {"Mn", "Mc"}
_INFO_MAX = 50


def _scan(seg: str, state: str | None, at_start: bool) -> str | None:
    """Fence state after seg: None = closed, else the info string of the open fence."""
    for i, line in enumerate(seg.split("\n")):
        if (i or at_start) and line.startswith("```"):
            state = None if state is not None else line[3:].strip()[:_INFO_MAX]
    return state


def split_message(text: str, limit: int = 2000, soft: int = 1900) -> list[str]:
    out: list[str] = []
    pos, state, at_start, n = 0, None, True, len(text)
    while True:
        head = f"```{state}\n" if state is not None else ""
        if len(head) + n - pos <= limit:
            out.append(head + text[pos:])
            return out
        room = soft - len(head)
        win = text[pos:pos + room]
        for sep in ("\n\n", "\n", " "):
            k = win.rfind(sep)
            if k > 0:
                c, skip = pos + k, len(sep)
                break
        else:
            c, skip = pos + room, 0
            while c > pos + 1 and unicodedata.category(text[c]) in _MARKS:
                c -= 1
        seg = text[pos:c]
        state = _scan(seg, state, at_start)
        out.append(head + seg + ("\n```" if state is not None else ""))
        at_start = skip > 0 and text[c] == "\n"
        pos = c + skip
