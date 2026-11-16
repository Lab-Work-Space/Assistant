import { z } from 'zod';
import { MeteredError } from '../../../agents/call/metered.js';
import { systemResolver, systemTransport } from '../../../net/system.js';
import { toolError, type ToolPlugin } from '../../types.js';
import type { GroupFactory } from '../index.js';
import { extractReceiptTool } from './receipt.js';
import { sheetsAppendTool, sheetsConfigured } from './sheets.js';
import { AttachmentError, describeImage, extractText, takeVision, VISION_REFUSED, type OcrDeps, type OcrLanguage } from './extract.js';

/** Discord allows at most 10 attachments per message. */
const MAX_INDEX = 9;

// Strict: a `url` or `messageId` key is a validation error, so the model can only pick an attachment of the current message (PF20).
const Input = z.strictObject({
  attachmentIndex: z.number().int().min(0).max(MAX_INDEX).optional().describe('Which attachment of the current message to read (0 = first, the default)'),
  language: z.enum(['th', 'en', 'auto']).optional().describe('Main language of the text (default auto)'),
});
type OcrInput = { attachmentIndex?: number; language?: OcrLanguage };

/**
 * `ocr_image` (Task 32): reads the text of an image or PDF attached to the message that started this run. The attachment
 * comes only from `ctx.source.attachments` (set by the inbound path), never from a url or message id the model gives.
 * The result is untrusted (P2/P19): the registry wraps it and taints the run.
 */
export function ocrImageTool(d: OcrDeps): ToolPlugin<OcrInput> {
  return {
    name: 'ocr_image',
    description: 'Read the text in an image or PDF attached to the current message (PNG, JPEG, WebP or PDF, up to 10 MB). Returns the transcribed text.',
    kind: 'read',
    untrustedOutput: true,
    untrustedSource: 'ocr',
    inputSchema: Input,
    requiresApproval: () => false,
    async run(input, ctx) {
      const i = input.attachmentIndex ?? 0;
      const att = ctx.source.attachments[i];
      if (!att) return toolError(ctx.source.attachments.length ? `ocr_image: the current message has no attachment ${i}.` : 'ocr_image: the current message has no attachment.');
      if (!takeVision(d, ctx.source.userId)) return toolError(`ocr_image: ${VISION_REFUSED}`);
      try {
        return { content: await extractText(d, { url: att.url, language: input.language ?? 'auto', actor: ctx.actor, task: ctx.task }) };
      } catch (err) {
        if (err instanceof AttachmentError || err instanceof MeteredError) return toolError(`ocr_image: ${err.message}`);
        return toolError('ocr_image failed.');
      }
    },
  };
}

/** RF13: images per run. */
export const MAX_IMAGES_PER_RUN = 4;
const ReadImageInput = z.strictObject({
  from: z.enum(['message', 'reply', 'forward']).optional().describe('Where the image is: the current message (default), the message being replied to, or the forwarded message'),
  index: z.number().int().min(0).max(MAX_INDEX).optional().describe('Which attachment there (0 = first, the default)'),
});
type ReadImageInput = { from?: 'message' | 'reply' | 'forward'; index?: number };

/**
 * `read_image` (RFMD P2): any head reads a picture from the trigger, the RF1-verified replied-to message or the RF7-verified forward snapshot. The model
 * picks `from` + `index` only (strict schema, no url or message id); the lists come from `ctx.source`, set by code. The grant is `tools.byDept` (RF14, checked
 * by the registry at every call). Each image takes one VisionCap slot of the human behind the run (system bucket when none), at most 4 per run. The text is untrusted and taints the run and task.
 */
export function readImageTool(d: OcrDeps): ToolPlugin<ReadImageInput> {
  return {
    name: 'read_image',
    description: 'Look at one image (PNG, JPEG or WebP, up to 10 MB) attached to the current message, the message being replied to, or the forwarded message. Returns a short description and any text in it. At most 4 images per run.',
    kind: 'read',
    untrustedOutput: true,
    untrustedSource: 'ocr',
    inputSchema: ReadImageInput,
    requiresApproval: () => false,
    async run(input, ctx) {
      const from = input.from ?? 'message';
      const i = input.index ?? 0;
      const list = from === 'reply' ? ctx.source.replyAttachments : from === 'forward' ? ctx.source.forwardAttachments : ctx.source.attachments;
      const att = list?.[i];
      if (!att) return toolError(list?.length ? `read_image: there is no image ${i} there.` : `read_image: there is no attachment on ${from === 'message' ? 'the current message' : from === 'reply' ? 'the replied-to message' : 'the forwarded message'}.`);
      if (ctx.run.images >= MAX_IMAGES_PER_RUN) return toolError(`read_image: at most ${MAX_IMAGES_PER_RUN} images can be read in one run.`);
      if (!takeVision(d, ctx.source.userId)) return toolError(`read_image: ${VISION_REFUSED}`);
      ctx.run.images++;
      try {
        return { content: await describeImage(d, { url: att.url, actor: ctx.actor, task: ctx.task }) };
      } catch (err) {
        if (err instanceof AttachmentError || err instanceof MeteredError) return toolError(`read_image: ${err.message}`);
        return toolError('read_image failed.');
      }
    },
  };
}

/** Off without the metered model service (built in app.ts); no key is needed here. */
export const ocrGroup: GroupFactory = (deps) => {
  if (!deps.metered) return { id: 'ocr', disabled: 'the metered model service is not available' };
  const sheets = sheetsConfigured(deps.env?.googleSheets) ? deps.env.googleSheets : undefined;
  const net = {
    metered: deps.metered, resolver: deps.net?.resolver ?? systemResolver, transport: deps.net?.transport ?? systemTransport,
    ...(deps.vision ? { vision: deps.vision } : {}), ...(deps.halt ? { halt: deps.halt } : {}),
  };
  return {
    id: 'ocr',
    // Sheets is optional: without both env keys (or with a url of the wrong shape) there is no sheets_append_receipt tool.
    tools: [ocrImageTool(net), readImageTool(net), extractReceiptTool({ ...net, port: deps.port, sheetsTool: !!sheets }), ...(sheets ? [sheetsAppendTool(net, sheets)] : [])],
  };
};
