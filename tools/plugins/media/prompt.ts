/**
 * RFMD P5 / Gate 1 RF32: the real-person check for generation prompts. Simple on purpose: a code-owned denylist of well-known names (Thai and Latin script) and
 * likeness phrases, matched after NFKC, with zero-width and control characters stripped, lower case, marks removed and whitespace collapsed (also with spaces removed, so
 * "e l o n" or "elonmusk" are caught). Defence in depth only (OD-5i: the image model has no person control; the approval card, the fixed prompt suffix and the provider safety filters sit beside it). A match REFUSES the call.
 */
const NAMES = [
  // Latin script
  'donald trump', 'joe biden', 'biden', 'barack obama', 'obama', 'kamala harris', 'vladimir putin', 'putin', 'xi jinping', 'kim jong', 'zelensky', 'netanyahu', 'macron',
  'elon musk', 'mark zuckerberg', 'jeff bezos', 'bill gates', 'steve jobs', 'sam altman', 'taylor swift', 'beyonce', 'rihanna', 'justin bieber', 'ariana grande', 'kanye', 'cristiano ronaldo',
  'lionel messi', 'neymar', 'tom cruise', 'brad pitt', 'angelina jolie', 'scarlett johansson', 'keanu reeves', 'emma watson', 'leonardo dicaprio', 'johnny depp', 'jackie chan', 'bruce lee',
  'prayut', 'prayuth', 'thaksin', 'yingluck', 'paetongtarn', 'anutin', 'srettha', 'pita limjaroenrat', 'lisa blackpink', 'jennie kim', 'bnk48', 'mario maurer', 'baifern', 'nadech', 'yaya urassaya',
  // Thai script
  'ทรัมป์', 'ไบเดน', 'โอบามา', 'ปูติน', 'สี จิ้นผิง', 'อีลอน มัสก์', 'อีลอนมัสก์', 'มาร์ค ซักเคอร์เบิร์ก', 'บิล เกตส์', 'สตีฟ จ็อบส์', 'เทย์เลอร์ สวิฟต์', 'ประยุทธ์', 'ทักษิณ', 'ยิ่งลักษณ์', 'แพทองธาร',
  'อนุทิน', 'เศรษฐา', 'พิธา', 'ลิซ่า', 'มาริโอ้ เมาเร่อ', 'ณเดชน์', 'ญาญ่า', 'ใบเฟิร์น', 'พระมหากษัตริย์', 'พระบาทสมเด็จ', 'สมเด็จพระ',
];
const PHRASES = ['deepfake', 'face swap', 'faceswap', 'look like a real person', 'likeness of', 'in the likeness', 'photo of a real person', 'ใบหน้าของคนจริง', 'หน้าเหมือน', 'สวมหน้า', 'ดีปเฟค'];

const STRIP = /[\p{Cf}\p{Cc}\p{Co}\p{M}\u{E0000}-\u{E007F}]/gu;
export const normalizePrompt = (s: string): string => s.normalize('NFKC').replace(STRIP, '').toLowerCase().replace(/\s+/g, ' ').trim();

const NORM_NAMES = [...NAMES, ...PHRASES].map(normalizePrompt);
const isThai = (x: string): boolean => /[\u0E00-\u0E7F]/u.test(x);
const LATIN = NORM_NAMES.filter((n) => !isThai(n));
const THAI = NORM_NAMES.filter(isThai);
const esc = (x: string): string => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// G2RF5-04: a Latin entry matches only as whole word(s): no letter or digit directly before or after it ("computing" is not putin, "macronutrient" is not macron).
const WORD = LATIN.map((n) => new RegExp(`(?<![\\p{L}\\p{N}])${esc(n).replace(/ /g, '[^\\p{L}\\p{N}]+')}(?![\\p{L}\\p{N}])`, 'u'));
// Spelled out with single letters or separators ("e l o n  m u s k", "e.l.o.n musk"): collapse runs of single-letter tokens, then match as words again.
const collapseSingles = (t: string): string => t.replace(/(?<![\p{L}\p{N}])(?:\p{L}[^\p{L}\p{N}]+){2,}\p{L}(?![\p{L}\p{N}])/gu, (m) => m.replace(/[^\p{L}\p{N}]+/gu, ''));
const SQUASHED = NORM_NAMES.filter((n) => !isThai(n)).map((n) => n.replace(/ /g, '')).filter((n) => n.length >= 6);

/** True when the prompt names a real person (or asks for a likeness). */
export function namesRealPerson(prompt: string): boolean {
  const n = normalizePrompt(prompt);
  if (WORD.some((r) => r.test(n))) return true;
  // Thai has no spaces between words, so a Thai entry is matched as a substring of the Thai text (the list holds distinctive names only).
  if (THAI.some((x) => n.includes(x) || n.replace(/ /g, '').includes(x.replace(/ /g, '')))) return true;
  // "elonmusk" written as one token, or spelled out letter by letter
  const tokens = n.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  if (tokens.some((t) => SQUASHED.includes(t))) return true;
  const c = collapseSingles(n);
  return c !== n && (WORD.some((r) => r.test(c)) || c.split(/[^\p{L}\p{N}]+/u).some((t) => SQUASHED.includes(t)));
}

/** Prompt rules the schema cannot express: printable text only (no control characters), see also the HIDDEN check for tainted runs. */
export const PROMPT_MAX = 400;
