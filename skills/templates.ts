import type { SkillTemplate } from './render.js';

/** Modal text <-> templates: each template starts with a `## <name>` line; the body is the lines up to the next such line. */
export function parseTemplates(text: string): SkillTemplate[] | null {
  const t = text.replace(/\r\n/g, '\n').trim();
  if (!t) return [];
  const out: SkillTemplate[] = [];
  let cur: { name: string; lines: string[] } | null = null;
  for (const line of t.split('\n')) {
    const m = /^##[ \t]+(.+?)\s*$/.exec(line);
    if (m) {
      if (cur) out.push({ name: cur.name, body: cur.lines.join('\n').trim() });
      cur = { name: m[1]!, lines: [] };
    } else if (cur) cur.lines.push(line);
    else return null; // text before the first "## name" line
  }
  if (cur) out.push({ name: cur.name, body: cur.lines.join('\n').trim() });
  return out;
}

export const templatesToText = (ts: readonly SkillTemplate[]): string => ts.map((t) => `## ${t.name}\n${t.body}`).join('\n\n');
