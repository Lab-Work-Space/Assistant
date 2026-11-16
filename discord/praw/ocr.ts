import { ATTACHMENT_MAX_BYTES, declaredType } from '../../services/attachments.js';
import { ephemeral, type InteractionLike, type Reply } from '../commands/types.js';
import type { Handler } from './commands.js';
import { outcomeReply, syntheticMessage, type PrawCommandDeps } from './context.js';

/** Appended by code to a human's image post in the auto-OCR channel (the human's own message; origin chat). */
export const AUTO_OCR_INSTRUCTION = '(Automatic reading is on in this channel: call ocr_image on the attached image or PDF and reply with the text it contains.)';

/** Whether any attachment is a type the readers support, by its declared type or suffix (the download decides by magic bytes, P19). */
export const hasReadableAttachment = (atts: { name: string; contentType?: string | null }[]): boolean => atts.some((a) => declaredType(a) !== null);

const LIMIT_TEXT = 'You have used up the daily limit for reading images and receipts. Try again tomorrow.';

/** Early refusals, before any Praw slot or model call: missing file, over 10 MB, not an image/PDF by its declared type, over the daily cap. */
function check(i: InteractionLike, deps: PrawCommandDeps): Reply | null {
  const a = i.options.attachment('file');
  if (!a) return ephemeral('Attach a file with the file option.');
  if (a.size > ATTACHMENT_MAX_BYTES) return ephemeral('That file is larger than 10 MB.');
  if (!declaredType(a)) return ephemeral('Only PNG, JPEG, WebP or PDF files can be read.');
  if (deps.vision && !deps.vision.peek(i.userId)) return ephemeral(LIMIT_TEXT);
  return null;
}

const LANGUAGES = ['th', 'en', 'auto'];

function viaPraw(action: 'ocr' | 'receipt', instruction: (i: InteractionLike) => string): Handler {
  return {
    check,
    async run(i, deps) {
      const a = i.options.attachment('file')!;
      const msg = syntheticMessage(i, deps.isBotAdmin(i), instruction(i), [{ name: a.name, url: a.url, size: a.size, ...(a.contentType ? { contentType: a.contentType } : {}) }]);
      const out = await deps.ask(msg, { deliver: false, preCharged: true });
      await deps.audit({ actor: `user:${i.userId}`, action: `praw.${action}`, outcome: out ? (out.stopped ?? 'ok') : 'refused' });
      if (!out || out.stopped === 'halted') return ephemeral('Praw is not taking requests right now (halted, paused or busy). Try again later.');
      return outcomeReply(out);
    },
  };
}

/** `/ocr file [language]`: Praw reads the text with ocr_image (the attachment rides on the message, never a url in the prompt). */
export const ocrCmd = viaPraw('ocr', (i) => {
  const lang = i.options.string('language');
  const l = lang && LANGUAGES.includes(lang) && lang !== 'auto' ? ` The text is mostly ${lang === 'th' ? 'Thai' : 'English'} (language ${lang}).` : '';
  return `Call ocr_image on attachment 0 and reply with only the text it contains.${l}`;
});

/** `/receipt file`: Praw reads the receipt with extract_receipt (table in the answer, CSV file posted by the tool). */
export const receiptCmd = viaPraw('receipt', () => 'Call extract_receipt on attachment 0 and reply with the receipt table and the total.');
