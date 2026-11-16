import { changedChars } from './diff.js';
import { renderBlock, SKILLS_HEADER, type SkillBody } from '../skills/render.js';
import { INVISIBLE } from './screen.js';

/** Caps (K8c). */
export const PROMPT_BODY_MAX = 12_000;
export const PROMPT_DIFF_MAX = 2_000;

/** Characters that look like Latin letters (UTS #39 style skeleton, the ones that matter for English rule text). */
const CONFUSABLES: Record<string, string> = {
  'а': 'a', 'е': 'e', 'о': 'o', 'р': 'p', 'с': 'c', 'у': 'y', 'х': 'x', 'і': 'i', 'ј': 'j', 'ѕ': 's', 'ԁ': 'd', 'ԛ': 'q', 'ԝ': 'w', 'ӏ': 'l', 'һ': 'h', 'к': 'k', 'м': 'm', 'н': 'h', 'т': 't', 'в': 'b',
  'α': 'a', 'β': 'b', 'ε': 'e', 'ι': 'i', 'κ': 'k', 'ο': 'o', 'ρ': 'p', 'τ': 't', 'υ': 'u', 'ν': 'v', 'χ': 'x', 'γ': 'y', 'η': 'n', 'μ': 'u', 'ω': 'w',
  'ı': 'i', 'ɡ': 'g', 'ƅ': 'b', 'ɑ': 'a', 'ɩ': 'i', 'ǀ': 'l', 'ⅰ': 'i', 'ⅼ': 'l', 'ℓ': 'l', 'ß': 'ss',
};
const digitsToLetters: Record<string, string> = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '@': 'a', '$': 's' };

/**
 * K7: the form the denylist is matched against: NFKC, case-folded, invisible characters dropped, confusables mapped to Latin, apostrophes
 * removed, every non-letter/digit turned into a space and whitespace collapsed (so headings and list markers between two halves of a rule
 * do not hide it). Leetspeak inside a word is folded too.
 */
export function skeleton(s: string): string {
  let t = s.normalize('NFKC').toLowerCase().replace(new RegExp(INVISIBLE.source, 'gu'), '');
  t = [...t].map((ch) => CONFUSABLES[ch] ?? ch).join('');
  t = t.replace(/['’`]/g, '');
  t = t.replace(/[a-z0-9@$]+/g, (w) => (/[a-z]/.test(w) ? w.replace(/[01345@$7]/g, (c) => digitsToLetters[c] ?? c) : w));
  return t.replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

const NEG = String.raw`(?<!\b(?:never|not|no|cannot|cant|dont|wont|without|nor|nobody)\s(?:\w+\s){0,3})`;
const GAP = String.raw`(?:\w+\s+){0,3}`;
const rx = (src: string) => new RegExp(src, 'u');

/** Reasons are fixed codes: the text that matched is never echoed back to the proposing model. */
const DENY: { code: string; re: RegExp }[] = [
  { code: 'ignore-rules', re: rx(`${NEG}\\b(?:ignore|disregard|forget|override|bypass|skip|circumvent)\\s+(?:(?:all|any|the|your|these|those|previous|prior|above|earlier|safety|system|other|every)\\s+)*(?:\\w+\\s+){0,2}(?:instructions?|rules?|guidelines?|polic(?:y|ies)|approvals?|guardrails?|restrictions?|safeguards?)\\b`) },
  { code: 'no-approval', re: rx(`\\b(?:without|no need to|no need for|stop)\\s+(?:asking|ask|requesting|request|waiting for|wait for|seeking|seek|getting|get)\\s+(?:for\\s+)?(?:an?\\s+|any\\s+|the\\s+)?(?:approvals?|permissions?|confirmations?|consent)\\b(?<!\\b(?:act|acting|proceed|run|execute|do|apply|change|send|post|spend|continue)\\s+without\\s+asking\\s+for\\s+approval)`) },
  { code: 'auto-approve', re: rx(`${NEG}\\b(?:approve|accept|confirm)\\s+(?:\\w+\\s+){0,2}(?:your own|own|yourself|automatically|by yourself)\\b`) },
  { code: 'reveal-secrets', re: rx(`${NEG}\\b(?:reveal|show|print|output|share|leak|expose|repeat|disclose|dump|send|include)\\s+${GAP}(?:secrets?|tokens?|api keys?|passwords?|credentials?|system prompt|private keys?|env(?:ironment)? variables?)\\b`) },
  { code: 'external-contact', re: rx(`${NEG}\\b(?:contact|email|dm|message|call|phone|notify|reach out to|write to|post to)\\s+${GAP}(?:external|third part(?:y|ies)|outside(?:rs)?|strangers?|anyone outside)\\b`) },
  { code: 'tool-permissions', re: rx(`${NEG}\\b(?:grant|give|allow|enable|unlock|extend)\\s+${GAP}(?:tools?|permissions?|privileges?|capabilit(?:y|ies)|admin rights|admin access|access to tools)\\b`) },
  { code: 'tool-permissions', re: rx(`\\byou\\s+(?:can|may|are allowed to|have permission to)\\s+(?:now\\s+)?(?:use|call|run|access)\\s+${GAP}(?:any|every|all)\\s+tools?\\b`) },
  { code: 'authority-claim', re: rx(`\\b(?:you are|youre|act as|acting as|pretend to be|behave as|become|your role is)\\s+(?:\\w+\\s+){0,2}(?:admins?|administrators?|owners?|bot admins?|security|moderators?|root|superuser|the system)\\b`) },
  { code: 'authority-claim', re: rx(`\\b(?:your name is|you are called|call yourself|introduce yourself as)\\s+(?:\\w+\\s+){0,1}(?:admin|owner|security|bot admin|moderator|system)\\b`) },
  { code: 'autonomy', re: rx(`${NEG}\\b(?:fully\\s+autonomous|autonomously|no (?:human|admin|owner)\\s+(?:oversight|approval|review|confirmation)|without (?:any )?(?:human|admin|owner) (?:oversight|approval|review|confirmation))\\b`) },
  { code: 'autonomy', re: rx(`\\b(?:never|dont|do not)\\s+(?:asks?|check with|consult)\\s+(?:a\\s+|the\\s+|any\\s+)?(?:human|admin|owner|anyone)\\b`) },
  { code: 'weaken-safety', re: rx(`${NEG}\\b(?:disable|remove|weaken|relax|turn off|switch off|stop following|stop obeying|drop|lift|override)\\s+${GAP}(?:safety|guardrails?|untrusted|denylist|off ?days?|tiers?|protections?|filters?|masking|redaction|safeguards?)\\b`) },
  { code: 'weaken-safety', re: rx(`\\b(?:treat|consider|regard)\\s+${GAP}untrusted\\s+${GAP}(?:as\\s+)?(?:trusted|instructions?|commands?)\\b`) },
  { code: 'protected-text', re: rx(`\\b(?:safety rules?|highest priority|cannot be overridden|take precedence over|protected (?:section|block|rules?)|begin protected|end protected)\\b`) },
];
/** Thai counterparts of the main refusals, matched on the raw (case-folded) text. */
const DENY_TH: { code: string; re: RegExp }[] = [
  { code: 'no-approval', re: /ไม่ต้อง(?:ขอ|รอ)(?:การ)?(?:อนุมัติ|ยืนยัน|อนุญาต)/u },
  { code: 'ignore-rules', re: /(?:เพิกเฉย|ละเลย|ไม่สนใจ|ข้าม)(?:ต่อ)?(?:กฎ|คำสั่งก่อนหน้า|ข้อห้าม|ความปลอดภัย)/u },
  { code: 'reveal-secrets', re: /(?:เปิดเผย|บอก|แสดง|ส่ง)(?:ให้)?(?:รหัสผ่าน|โทเคน|ความลับ|api ?key|คีย์)/u },
  { code: 'authority-claim', re: /(?:คุณคือ|เธอคือ|คุณเป็น|เธอเป็น)\s*(?:แอดมิน|เจ้าของ|ผู้ดูแลระบบ|ระบบ)/u },
];
const MARKERS = [/<!--/, /-->/, /<\s*\/?\s*untrusted/i, /\bprotected\s*:/i];

const PRAW_NAME = /(?:\byou are\s+(?:\w+\s+){0,2}praw\b|\bpraw\b.{0,12}\byou are\b|\byour name is\s+praw\b|\bcall yourself praw\b|\bintroduce yourself as praw\b)/u;
const PRAW_NAME_TH = /(?:คุณคือ|เธอคือ|คุณเป็น|เธอเป็น|ชื่อของคุณคือ|ชื่อของเธอคือ|ให้แนะนำตัวว่า)\s*(?:น้อง\s*)?(?:พราว|praw)/iu;

export type LintResult = { ok: true } | { ok: false; reasons: string[] };

/**
 * The text rules shared by role text and skills (SK4): invisible characters, frontmatter, markers, the denylist (English and Thai) and
 * identity claims. The whole text is matched on its skeleton, so zero-width characters, homoglyphs and a rule split across sections do not hide it.
 */
export function lintPolicyText(next: string, o: { ref: string }): LintResult {
  const reasons = new Set<string>();
  if (INVISIBLE.test(next)) reasons.add('invisible-characters');
  if (/^---\s*$/m.test(next) && /^(?:tools|model|provider|fragments)\s*:/m.test(next)) reasons.add('frontmatter');
  for (const m of MARKERS) if (m.test(next)) reasons.add('protected-text');
  const flat = skeleton(next);
  for (const d of DENY) if (d.re.test(flat)) reasons.add(d.code);
  const raw = next.normalize('NFKC').toLowerCase();
  for (const d of DENY_TH) if (d.re.test(raw)) reasons.add(d.code);
  // K9: a persona or role text that makes the model claim to be Praw (the assistant everyone talks to). Praw's own head text may name itself.
  if (o.ref !== 'heads/praw' && (PRAW_NAME.test(flat) || PRAW_NAME_TH.test(raw))) reasons.add('identity-claim');
  return reasons.size ? { ok: false, reasons: [...reasons].sort() } : { ok: true };
}

/**
 * K7/K8/K9 backstop for a proposed prompt or persona body. The whole resulting body is matched (not per section) on its skeleton, so
 * zero-width characters, homoglyphs and a rule split across sections do not hide it; invisible characters are refused outright. This is
 * not the control by itself: the classifier and the Bot Admin card stand behind it.
 */
export function lintPromptBody(next: string, o: { ref: string; prev: string }): LintResult {
  const reasons = new Set<string>();
  const policy = lintPolicyText(next, { ref: o.ref });
  if (!policy.ok) for (const r of policy.reasons) reasons.add(r);
  if (!next.trim()) reasons.add('empty');
  if (next.length > PROMPT_BODY_MAX) reasons.add('too-long');
  if (changedChars(o.prev, next) > PROMPT_DIFF_MAX) reasons.add('diff-too-large');
  return reasons.size ? { ok: false, reasons: [...reasons].sort() } : { ok: true };
}

/** NFKC, case-folded and with the Latin look-alikes mapped, line structure kept: the form a forged header is matched on (SK4). */
const headerForm = (s: string): string => [...s.normalize('NFKC').toLowerCase().replace(new RegExp(INVISIBLE.source, 'gu'), '')].map((ch) => CONFUSABLES[ch] ?? ch).join('');
/**
 * G2SK-03: markup-agnostic header shapes, on the normalised line start: a markdown heading of any indent whose first word is skill(s) or template(s) (no word boundary,
 * so plurals count); an HTML heading opening with that word; or, after any run of markup characters (`#`, `*`, `_`, `>`, `-`, backticks, spaces), a bare line of
 * the form `Skill <id> v<n>`. Ordinary prose ("Skills matter: ...", "Our template for notes ...") has none of these shapes.
 */
const HEADER_LINE = /^(?:\s*#{1,6}\s*(?:skill|template)|\s*<h\d[^>]*>\s*(?:skill|template)|[\s#*_>~`|-]*(?:<\/?h\d[^>]*>\s*)?skills?\s+[a-z0-9][a-z0-9-]*\s+v\d+\b)/gmu;
const SETEXT = /^\s{0,3}(?:skill|template)[^\n]*\n\s{0,3}(?:=+|-+)\s*$/mu;
const headerLines = (s: string): number => headerForm(s).match(HEADER_LINE)?.length ?? 0;
const forged = (s: string): boolean => headerLines(s) > 0 || SETEXT.test(headerForm(s));

/**
 * SK4: lint of a skill version, on exactly what is injected. The rendered block goes through the shared policy lint; every field is
 * checked on its own for a forged skill or template header (a field cannot add a header line), title and template names must be one
 * line, and the code header sentence and "approved by a Bot Admin" are refused. The bare phrase "team skills" is ordinary prose and passes.
 */
export function lintSkillText(v: SkillBody, o: { ref: string }): LintResult {
  const reasons = new Set<string>();
  const block = renderBlock(v);
  const policy = lintPolicyText(block, o);
  if (!policy.ok) for (const r of policy.reasons) reasons.add(r);
  const fields = [v.title, v.instructions, ...v.templates.flatMap((t) => [t.name, t.body])];
  if (fields.some(forged)) reasons.add('skill-header');
  if ([v.title, ...v.templates.map((t) => t.name)].some((x) => /[\r\n\u2028\u2029]/.test(x))) reasons.add('skill-header');
  if (headerLines(block) !== 1 + v.templates.length || SETEXT.test(headerForm(block))) reasons.add('skill-header');
  const flat = skeleton(block);
  if (flat.includes('approved by a bot admin') || flat.includes(skeleton(SKILLS_HEADER).slice(0, 60))) reasons.add('skill-header');
  return reasons.size ? { ok: false, reasons: [...reasons].sort() } : { ok: true };
}
