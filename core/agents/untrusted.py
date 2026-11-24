import re

# Single optional group so whitespace cannot backtrack quadratically (a 200 KB "<" + spaces input stays linear).
# Gate 2 (G2-01): also small/fullwidth "<" (U+FE64), fullwidth "/" and zero-width chars (U+200B-D, U+2060, U+FEFF).
_TAG = re.compile(r"[<＜﹤][\s​-‍⁠﻿]*(?:([/／])[\s​-‍⁠﻿]*)?(untrusted|tool_result)",
                  re.IGNORECASE)
_ATTR = re.compile(r'[<>"\r\n＜＞]')
_SOURCE = re.compile(r"^[a-z_]{1,32}$")
_AUTHOR_ID = re.compile(r"^[0-9]{0,20}$")
_TOOL = re.compile(r"^[a-z][a-z0-9_]{0,63}$")


def _escape(text: str) -> str:
    return _TAG.sub(lambda m: "&lt;" + (m.group(1) or "") + m.group(2), text)


def wrap_untrusted(text: str, source: str, author_id: str = "", author_name: str = "") -> str:
    if not _SOURCE.fullmatch(source) or not _AUTHOR_ID.fullmatch(author_id):
        raise ValueError("bad_untrusted_attr")
    name = _ATTR.sub("", author_name)[:80]
    return f'<untrusted source="{source}" author_id="{author_id}" author_name="{name}">\n{_escape(text)}\n</untrusted>'


def wrap_tool_result(name: str, ok: bool, text: str) -> str:
    if not _TOOL.fullmatch(name):
        raise ValueError("bad_tool_name")
    return f'<tool_result name="{name}" ok="{"true" if ok else "false"}">\n{_escape(text)}\n</tool_result>'
