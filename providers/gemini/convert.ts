import { wrapUntrusted } from '../../prompts/assemble.js';
import type { ChatMessage, ChatRequest, ContentBlock, StopReason } from '../types.js';
import type { GeminiContent, GeminiPart, GeminiRequest } from './types.js';

export const PROVIDER_ID = 'gemini';

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

// Keys of the SDK `Schema` (OpenAPI 3.0 subset). Everything else ($schema, additionalProperties, const,
// exclusive*, oneOf, not, patternProperties, ...) is rewritten or dropped.
const KEEP = new Set([
  'anyOf', 'default', 'description', 'enum', 'example', 'format', 'items', 'maxItems', 'maxLength',
  'maxProperties', 'maximum', 'minItems', 'minLength', 'minProperties', 'minimum', 'nullable', 'pattern',
  'properties', 'propertyOrdering', 'required', 'title', 'type',
]);
const TYPES = new Set(['string', 'number', 'integer', 'boolean', 'array', 'object']);
const FORMATS = new Set(['enum', 'date-time', 'int32', 'int64', 'float', 'double']);
const MAX_DEPTH = 32;

function resolveRef(ref: string, root: Json): Json {
  const m = /^#\/(\$defs|definitions)\/(.+)$/.exec(ref);
  const target = m && isObj(root[m[1]!]) ? (root[m[1]!] as Json)[m[2]!] : undefined;
  if (!isObj(target)) throw new Error(`unresolvable $ref ${ref}`);
  return target;
}

function conv(node: unknown, root: Json, depth: number): Json {
  if (depth > MAX_DEPTH) throw new Error('schema too deep or recursive $ref');
  if (!isObj(node)) return {};
  let s: Json = node;
  if (typeof s.$ref === 'string') {
    const { $ref, ...rest } = s;
    s = { ...resolveRef($ref, root), ...rest };
  }
  if (Array.isArray(s.allOf)) {
    const { allOf, ...rest } = s;
    s = Object.assign({}, ...(allOf as unknown[]).map((p) => conv(p, root, depth + 1)), rest);
  }
  const out: Json = {};
  let nullable = s.nullable === true;

  // const -> single-value enum (Gemini enums are string lists)
  if ('const' in s && !('enum' in s)) {
    out.enum = [String(s.const)];
    out.type = 'STRING';
  }

  let t = s.type;
  if (Array.isArray(t)) {
    if (t.includes('null')) nullable = true;
    const rest = t.filter((x) => x !== 'null');
    t = rest.length === 1 ? rest[0] : undefined;
  }
  if (t === 'null') {
    nullable = true;
    t = undefined;
  }
  if (typeof t === 'string' && TYPES.has(t)) out.type = t.toUpperCase();

  const union = (s.anyOf ?? s.oneOf) as unknown;
  if (Array.isArray(union)) {
    const members: Json[] = [];
    for (const m of union) {
      if (isObj(m) && m.type === 'null') nullable = true;
      else members.push(conv(m, root, depth + 1));
    }
    if (members.length === 1) Object.assign(out, members[0]);
    else if (members.length > 1) out.anyOf = members;
  }

  for (const [k, v] of Object.entries(s)) {
    if (!KEEP.has(k) || k === 'type' || k === 'anyOf' || k === 'nullable') continue;
    if (k === 'properties' && isObj(v)) {
      out.properties = Object.fromEntries(Object.entries(v).map(([n, p]) => [n, conv(p, root, depth + 1)]));
    } else if (k === 'items') {
      out.items = conv(v, root, depth + 1);
    } else if (k === 'enum' && Array.isArray(v)) {
      out.enum = v.map(String);
      out.type ??= 'STRING';
    } else if (k === 'format') {
      if (typeof v === 'string' && FORMATS.has(v)) out.format = v;
    } else if (k === 'default' || k === 'example') {
      // defaults are advisory; drop objects the API may not parse
      if (!isObj(v) && !Array.isArray(v)) out[k] = v;
    } else {
      out[k] = v;
    }
  }

  // exclusive bounds (draft 2020-12 numbers) -> inclusive bounds
  if (typeof s.exclusiveMinimum === 'number') out.minimum ??= s.exclusiveMinimum;
  if (typeof s.exclusiveMaximum === 'number') out.maximum ??= s.exclusiveMaximum;
  if (s.exclusiveMinimum === true && typeof s.minimum === 'number') out.minimum = s.minimum;
  if (s.exclusiveMaximum === true && typeof s.maximum === 'number') out.maximum = s.maximum;

  if (nullable) out.nullable = true;
  if (isObj(out.properties) && Array.isArray(out.required)) {
    const names = out.properties;
    out.required = (out.required as unknown[]).filter((r) => typeof r === 'string' && r in names);
    if ((out.required as unknown[]).length === 0) delete out.required;
  }
  return out;
}

/** JSON Schema (as produced by zod `toJSONSchema`) -> Gemini `parameters` Schema (OpenAPI 3.0 subset). */
export function toGeminiSchema(schema: object): object {
  return conv(schema, schema as Json, 0);
}

function parts(b: ContentBlock, toolNames: Map<string, string>, rawCallIds: Set<string>): GeminiPart[] {
  switch (b.type) {
    case 'text':
      return b.text ? [{ text: b.text }] : [];
    case 'tool_use':
      // a replayed raw gemini functionCall part (it carries the signature) already stands for this call
      if (rawCallIds.has(b.id)) return [];
      return [{ functionCall: { id: b.id, name: b.name, args: isObj(b.input) ? b.input : {} } }];
    case 'tool_result': {
      const text = wrapUntrusted({ author: 'tool', authorKind: 'model', source: 'tool_result', content: b.content });
      return [{ functionResponse: { name: toolNames.get(b.toolUseId) ?? 'unknown_tool', response: b.isError ? { error: text } : { output: text } } }];
    }
    case 'media':
      // Step 0 (Task 32): Part.inlineData is a Blob {mimeType, data: base64}; images, PDFs and (Task 37) audio/wav go inline as-is.
      return [{ inlineData: { mimeType: b.mimeType, data: b.data } }];
    case 'raw':
      return b.provider === PROVIDER_ID && isObj(b.block) ? [b.block as GeminiPart] : []; // never other providers' blocks
  }
}

/**
 * Raw gemini blocks are whole Part objects (thought parts, or functionCall parts with their thoughtSignature)
 * stored by the provider; they are replayed unchanged, in position, to Gemini only.
 */
function contents(ms: ChatMessage[]): GeminiContent[] {
  const toolNames = new Map<string, string>();
  const rawCallIds = new Set<string>();
  for (const m of ms) {
    for (const b of m.content) {
      if (b.type === 'tool_use') toolNames.set(b.id, b.name);
      else if (b.type === 'raw' && b.provider === PROVIDER_ID && isObj(b.block)) {
        const id = (b.block as GeminiPart).functionCall?.id;
        if (id) rawCallIds.add(id);
      }
    }
  }
  const out: GeminiContent[] = [];
  for (const m of ms) {
    const ps = m.content.flatMap((b) => parts(b, toolNames, rawCallIds));
    if (ps.length === 0) continue;
    const role = m.role === 'assistant' ? 'model' : 'user';
    const last = out[out.length - 1];
    if (last && last.role === role) last.parts.push(...ps);
    else out.push({ role, parts: ps });
  }
  return out;
}

export function toGeminiRequest(req: ChatRequest): GeminiRequest {
  return {
    model: req.model,
    systemInstruction: req.system,
    contents: contents(req.messages),
    functionDeclarations: req.tools.map((t) => {
      const parameters = toGeminiSchema(t.inputSchema) as { type?: string; properties?: object };
      // Step 0 (Task 3): an OBJECT schema with no properties is omitted; the API's docs do not promise it accepts one.
      const empty = parameters.type === 'OBJECT' && Object.keys(parameters.properties ?? {}).length === 0;
      return { name: t.name, description: t.description, ...(empty ? {} : { parameters }) };
    }),
    maxOutputTokens: req.maxTokens,
  };
}

const REFUSALS = new Set(['SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII', 'IMAGE_SAFETY', 'IMAGE_PROHIBITED_CONTENT', 'IMAGE_RECITATION', 'blocked']);

/** Candidate finishReason (or 'blocked' for a prompt block) -> StopReason. */
export function mapFinish(reason: string | undefined, sawFunctionCall: boolean): StopReason {
  if (reason !== undefined && REFUSALS.has(reason)) return 'refusal';
  if (reason === 'MAX_TOKENS') return 'max_tokens';
  if (sawFunctionCall && (reason === undefined || reason === 'STOP' || reason === 'FINISH_REASON_UNSPECIFIED')) return 'tool_use';
  return 'end_turn';
}
