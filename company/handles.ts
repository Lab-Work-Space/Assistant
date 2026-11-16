import type { DeptId } from '../core/index.js';

/**
 * Teamwork C / Gate 1 TW8: the fixed handle table. Models write `@CTO`; the port turns a handle into a real `<@id>` mention for
 * a head that is online, and the inbound mapper reads handles (bot and persona authors only). The ids never come from text.
 */
export const HANDLE_DEPTS: Readonly<Record<string, DeptId>> = {
  CEO: 'hq', CTO: 'software', 'R&D': 'rnd', IT: 'it', Marketing: 'marketing', Sales: 'sales', HR: 'hr', CFO: 'finance', Ops: 'ops', Praw: 'praw',
};
export const HANDLE_LIST: readonly string[] = Object.keys(HANDLE_DEPTS).map((h) => `@${h}`);

const ZWJ = '‍';
/** Code fences (also an unterminated one), inline code and URLs: text in them is never converted. */
const PROTECTED = /```[\s\S]*?(?:```|$)|`[^`\n]*`|https?:\/\/[^\s<>]+/g;
/**
 * Case-exact handle with explicit boundaries (`\b` fails around `&`): not after a word character, `.` or `@` (so `a@IT.com` and
 * `x@@IT` are not handles), not before a word character or `&`, and not before `.word` (a domain such as `@IT.com`).
 */
const HANDLE = /(?<![\w.@])@(CEO|CTO|R&D|IT|Marketing|Sales|HR|CFO|Ops|Praw)(?![\w&]|\.\w)/g;
const SNOWFLAKE = /^\d{17,20}$/;
/** `@` right before a handle name, with no boundary checks (TEAMTALK T1 / G2TT-01). */
const ANY_HANDLE_AT = /@(?=CEO|CTO|R&D|IT|Marketing|Sales|HR|CFO|Ops|Praw)/g;

/** Raw user, nickname and role mentions, `@everyone` and `@here` in model text are broken with a zero-width joiner so they can neither ping nor route. */
export function neutralise(text: string): string {
  return text.replace(/<@/g, `<${ZWJ}@`).replace(/@(everyone|here)/gi, `@${ZWJ}$1`);
}

/**
 * TEAMTALK-1 T1: breaks every handle (`@CFO` becomes `@` + ZWJ + `CFO`) everywhere, INCLUDING inside code spans, fences and URLs. A code-written relay
 * (handoff line, subtask report, room line, board) never needs a live handle, and `handlesIn` (which skips protected spans) must read none of them,
 * so neutralise (raw mentions only) is not enough. Idempotent; text with no `@` right before a handle name is returned unchanged.
 */
export function defangHandles(text: string): string {
  // G2TT-01: context-free. Every `@` directly followed by a handle name gets the ZWJ, whatever is around it, so no segmentation (code / URL spans), no
  // join of fields (the send check, inbound `embedText`) and no cut or split can ever make a handle of it. A ZWJ in `@ITEM` or an email is invisible.
  return text.replace(ANY_HANDLE_AT, `@${ZWJ}`);
}

/** Applies `fn` to the parts of `text` outside code and URLs. */
function outsideProtected(text: string, fn: (plain: string) => string): string {
  let out = '';
  let last = 0;
  for (const m of text.matchAll(PROTECTED)) {
    out += fn(text.slice(last, m.index)) + m[0];
    last = m.index + m[0].length;
  }
  return out + fn(text.slice(last));
}

/** Handles outside code and URLs, in order of appearance, one per department. */
export function handlesIn(text: string): DeptId[] {
  const found: DeptId[] = [];
  outsideProtected(text, (plain) => {
    for (const m of plain.matchAll(HANDLE)) {
      const d = HANDLE_DEPTS[m[1]!]!;
      if (!found.includes(d)) found.push(d);
    }
    return plain;
  });
  return found;
}

/** Handle -> `<@id>` for heads whose id is in `idOf` (the live bot ids of the online heads); any other handle stays plain text. */
export function toMentions(text: string, idOf: (dept: DeptId) => string | undefined): string {
  return outsideProtected(text, (plain) =>
    plain.replace(HANDLE, (whole, h: string) => {
      const id = idOf(HANDLE_DEPTS[h]!);
      return id && SNOWFLAKE.test(id) ? `<@${id}>` : whole;
    }));
}

/** The handle text of a department (`@CTO` for `software`), or null. */
export const handleOf = (dept: DeptId): string | null => {
  const h = Object.keys(HANDLE_DEPTS).find((k) => HANDLE_DEPTS[k] === dept);
  return h ? `@${h}` : null;
};

/** Length of `text` after its handles became mentions (every id is at most 20 digits, so a mention is 23 characters). */
export const convertedLength = (text: string): number => toMentions(text, () => '1'.repeat(20)).length;
