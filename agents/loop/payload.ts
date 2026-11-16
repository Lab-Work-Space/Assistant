import { z } from 'zod';

export type PayloadType = 'chat' | 'task' | 'report' | 'approval' | 'alert' | 'config';

/** What an agent asks the Discord layer to post. Embed rendering and splitting is Task 11. */
export type OutboundPayload = {
  type: PayloadType;
  title?: string;
  body: string;
  fields?: { name: string; value: string }[];
  footer?: { model: string; costUsd: number; ms: number };
  buttons?: { approvalId: string; /** WEBGRANT-1: also show 'Allow web reading for this task tree' (system-only). */ grant?: true; /** TREEGRANT-1: or 'Approve the whole task' (system-only; never together with `grant`). */ task?: true };
  /** System-only (APPROVAL-BATCH-1): the batched approval card; rendered as ONE embed with its own button rows (never the single-card `buttons`). */
  batchButtons?: { batchId: number; digest: string; items: { id: number; pending: boolean }[]; /** WEBGRANT-1: 'Approve all + allow web reading' (every member qualifies). */ grant?: true; /** WEBGRANT-1: the live grant made on this card; its revoke button replaces the grant button. */ revokeGrantId?: number; /** WEBGRANT-1 (W-C9/W-C10): the closing text of that grant, shown as the card message's content (code-written). */ grantNote?: string; /** TREEGRANT-1: 'Approve all + whole task' (every member qualifies; exclusive with `grant`). */ task?: true; /** TREEGRANT-1: the live task grant made on this card; its revoke button replaces the other grant buttons. */ revokeTaskGrantId?: number };
  /** System-only (OT-1): the overtime request card; ONE embed (like the batch card) with its own button row. mode `request` = Approve OT / Deny / Make today a workday; `granted` = the Revoke OT button. `note` = the card message content (code-written). Never produced by a model payload. */
  otButtons?: { id: number; digest: string; mode: 'request' | 'granted'; note?: string };
  /** System-only: Confirm/Cancel row of an admin console card (custom ids `admincfg:<id>:confirm|cancel`, Gate 1 C4). Type `approval`. */
  adminCardId?: string;
  /** System-only (SPEND-1): the raise card of a department budget; Approve/Reject row with custom ids `spendovr:<id>:approve|reject`. Type `approval`. Never produced by a model payload. */
  spendOverrideId?: string;
  /** System-only (GROW-1): the tool request card; Approve/Reject row with custom ids `toolreq:<token>:approve|reject` (32 hex token). Type `approval`. Never produced by a model payload (toPayload drops it). */
  toolRequestId?: string;
  /** System-only (R5 RELEASE-1): the release card; Approve/Reject row with custom ids `relcard:<token>:approve|reject` (32 hex token). Type `approval`. Never produced by a model payload (toPayload drops it). */
  releaseCardId?: string;
  /** System-only (AUTO-1): the project proposal card; Approve/Reject row with custom ids `projcard:<token>:approve|reject` (32 hex token). Type `approval`. Never produced by a model payload (toPayload drops it). */
  projectCardId?: string;
  /** System-only (AUTO-1): the project budget notice; Raise/Close row with custom ids `projbud:<token>:raise|close` (32 hex token). Type `approval`. Never produced by a model payload (toPayload drops it). */
  projectBudgetId?: string;
  /** Who produced it. Absent means 'model'. Only 'governance' alerts may ping the admin role (Gate 1 D11). */
  origin?: 'governance' | 'model';
  /** System-only (the welcome post, Gate 1 S11): user ids to ping, exactly these and no other mention. Never produced by a model payload. */
  mentionUsers?: string[];
  /**
   * System-only (TEAMTALK-1 T1): a code-written relay of model text (handoff line, subtask report, room line, board). The port neutralises raw mentions,
   * DEFANGS every handle (no live `@CFO` anywhere, code spans and URLs included), never converts a handle to `<@id>`, suppresses link embeds, and
   * refuses to send when handle text or mention markup survives. Never produced by a model payload.
   */
  noHandles?: true;
};

/** Discord embed limits (constraints): 25 fields, title 256, field name 256, field value 1024. */
export const MAX_FIELDS = 25;
const TITLE_MAX = 256;
const FIELD_NAME_MAX = 256;
const FIELD_VALUE_MAX = 1024;

/** Types a model may produce. `config` embeds, buttons and footers are system-only (Gate 1 D16). */
export const MODEL_PAYLOAD_TYPES = ['chat', 'task', 'report', 'approval', 'alert'] as const;

export const modelPayloadSchema = z.object({
  type: z.enum(MODEL_PAYLOAD_TYPES),
  title: z.string().optional(),
  body: z.string(),
  fields: z.array(z.object({ name: z.string(), value: z.string() })).optional(),
});

const nonEmpty = (s: string, max: number) => (s.trim() === '' ? '-' : s.slice(0, max));

/**
 * Validates model-authored output into a payload. Over-long titles and field lists are truncated to the
 * Discord limits; unknown keys (footer, buttons) are dropped. Anything invalid falls back to a chat payload.
 */
export function toPayload(raw: unknown): OutboundPayload {
  const res = modelPayloadSchema.safeParse(raw);
  if (!res.success) return { type: 'chat', body: fallbackBody(raw) };
  const { type, title, body, fields } = res.data;
  // Owner rule (2026-11-05): a model answer is never a card. 'approval' stays accepted on input but renders as chat (plain text);
  // real approval cards are built by code with buttons.
  const out: OutboundPayload = { type: type === 'approval' ? 'chat' : type, body };
  if (title !== undefined && title.trim() !== '') out.title = title.slice(0, TITLE_MAX);
  if (fields?.length) {
    out.fields = fields.slice(0, MAX_FIELDS).map((f) => ({ name: nonEmpty(f.name, FIELD_NAME_MAX), value: nonEmpty(f.value, FIELD_VALUE_MAX) }));
  }
  return out;
}

function fallbackBody(raw: unknown): string {
  if (typeof raw === 'string') return raw;
  if (raw && typeof raw === 'object' && typeof (raw as { body?: unknown }).body === 'string') return (raw as { body: string }).body;
  try {
    return JSON.stringify(raw) ?? String(raw);
  } catch {
    return String(raw);
  }
}

const LEAK_FALLBACK = '(the answer could not be delivered; please ask again)';

function unwrapLeakedToolCalls(t: string): OutboundPayload {
  try {
    const obj = JSON.parse(t) as { tool_calls?: unknown };
    const calls = Array.isArray(obj.tool_calls) ? (obj.tool_calls as { name?: unknown; input?: unknown }[]) : [];
    const respond = calls.find((c) => c && c.name === 'respond' && c.input && typeof c.input === 'object');
    if (respond && modelPayloadSchema.safeParse(respond.input).success) return toPayload(respond.input);
  } catch {
    // broken JSON: never posted raw
  }
  return { type: 'chat', body: LEAK_FALLBACK };
}

/** Final text of a turn: a JSON object matching the payload schema is honoured (spec §11), otherwise plain chat. */
export function textToPayload(text: string): OutboundPayload {
  const t = text.trim();
  // Safety net (TW12): a respond tool call that leaked into text is unwrapped; other tool-call JSON is never posted raw.
  if (/^\{\s*"tool_calls"\s*:/.test(t)) return unwrapLeakedToolCalls(t);
  if (t.startsWith('{')) {
    try {
      const parsed: unknown = JSON.parse(t);
      if (modelPayloadSchema.safeParse(parsed).success) return toPayload(parsed);
    } catch {
      // not JSON: plain chat below
    }
  }
  return { type: 'chat', body: t === '' ? '(no answer)' : text };
}

/**
 * TW19: the silence token. Only a plain chat payload whose trimmed body is exactly `NO_REPLY` counts (no title, no fields); an alert, a
 * card or any other payload type is always posted. The caller applies it to bot-triggered turns only.
 */
export const isNoReply = (p: OutboundPayload): boolean =>
  p.type === 'chat' && p.origin !== 'governance' && p.title === undefined && !p.fields?.length && p.body.trim() === 'NO_REPLY';

export const alertPayload = (title: string, body: string): OutboundPayload => ({ type: 'alert', title, body });
