import type Anthropic from '@anthropic-ai/sdk';
import { ProviderError, type ChatMessage, type ChatRequest, type ContentBlock } from '../types.js';

export const PROVIDER_ID = 'claude';
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

type Blk = Anthropic.Beta.BetaContentBlockParam;
type ImageType = Anthropic.Beta.BetaBase64ImageSource['media_type'];
const IMAGE_TYPES: ReadonlySet<string> = new Set<ImageType>(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

/** Images become base64 image blocks; PDFs and other media are refused here (attachments are read by Gemini, PF21). */
function media(b: Extract<ContentBlock, { type: 'media' }>): Blk {
  if (IMAGE_TYPES.has(b.mimeType)) return { type: 'image', source: { type: 'base64', media_type: b.mimeType as ImageType, data: b.data } };
  const what = b.mimeType === 'application/pdf' ? 'PDF attachments' : 'this media type';
  throw new ProviderError(`claude: ${what} cannot be sent to this provider`, { retryable: false });
}

function block(b: ContentBlock): Blk[] {
  switch (b.type) {
    case 'text':
      return [{ type: 'text', text: b.text }];
    case 'tool_use':
      return [{ type: 'tool_use', id: b.id, name: b.name, input: b.input }];
    case 'tool_result':
      return [{ type: 'tool_result', tool_use_id: b.toolUseId, content: b.content, ...(b.isError ? { is_error: true } : {}) }];
    case 'media':
      return [media(b)];
    case 'raw':
      return b.provider === PROVIDER_ID ? [b.block as Blk] : [];
  }
}

function messages(ms: ChatMessage[]): ClaudeParams['messages'] {
  return ms
    .map((m) => ({ role: m.role, content: m.content.flatMap(block) }))
    .filter((m) => m.content.length > 0);
}

export function isSonnet(model: string): boolean {
  return model.includes('sonnet');
}

/** Builds Messages API params. No sampling params (rejected by 5.5 models); thinking omitted = adaptive. */
export type ClaudeParams = Anthropic.Beta.Messages.MessageCreateParamsNonStreaming;

export function buildParams(req: ChatRequest): ClaudeParams {
  return {
    model: req.model,
    max_tokens: req.maxTokens,
    system: [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }],
    messages: messages(req.messages),
    ...(req.tools.length
      ? {
          tools: req.tools.map((t) => ({
            name: t.name,
            description: t.description,
            input_schema: t.inputSchema as Anthropic.Beta.BetaTool['input_schema'], // validated later by the tool registry
            eager_input_streaming: true,
          })),
        }
      : {}),
    ...(req.effort ? { output_config: { effort: req.effort } } : {}),
    // R8 PV-C04: the backup route never asks for the server-side fallback (a refusal then ends as "Declined", like local, and the meter prices what it reserved)
    ...(isSonnet(req.model) && req.route !== 'fallback' ? { betas: [FALLBACK_BETA], fallbacks: 'default' } : {}),
  };
}
