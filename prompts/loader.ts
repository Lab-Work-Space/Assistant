import { readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import matter from 'gray-matter';
import { z } from 'zod';
import { DEPT_IDS, type DeptId } from '../core/index.js';
import type { PromptOverrideRepo } from '../db/repos/index.js';
import { isProtectedRef } from './protected.js';

export interface PromptMeta {
  name: string;
  role: string;
  /** Required for heads/ and members/; absent for system/ and fragments/. */
  dept?: DeptId;
  model?: string;
  effort?: 'low' | 'medium' | 'high';
  tools: string[];
  traits: string[];
  color?: string;
  /** Names under fragments/ (without prefix). */
  fragments: string[];
}
export interface PromptDoc {
  ref: string;
  meta: PromptMeta;
  body: string;
}

/** A tool name, or the "*" wildcard (only heads/praw.md may use it; enforced in loadPrompts). */
const toolPattern = z.string().regex(/^(?:[a-z][a-z0-9_]*|\*)$/, 'tool name must match ^[a-z][a-z0-9_]*$ or be "*"');
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
const WILDCARD_REF = 'heads/praw';
const base = {
  name: z.string().min(1),
  role: z.string().min(1),
  model: z.string().optional(),
  effort: z.enum(['low', 'medium', 'high']).optional(),
  tools: z.array(toolPattern).default([]),
  traits: z.array(z.string()).default([]),
  color: z.string().regex(HEX_COLOR, 'color must be #RRGGBB').optional(),
  fragments: z.array(z.string()).default([]),
};
const actorSchema = z.object({ ...base, dept: z.enum(DEPT_IDS), traits: z.array(z.string()).min(1) });
const plainSchema = z.object({ ...base, name: z.string().default(''), role: z.string().default('') });

const SECTIONS = ['system', 'heads', 'members', 'fragments'] as const;

export function loadPrompts(dir: string): Map<string, PromptDoc> {
  const docs = new Map<string, PromptDoc>();
  for (const section of SECTIONS) {
    let files: string[];
    try {
      files = readdirSync(join(dir, section)).filter((f) => f.endsWith('.md')).sort();
    } catch {
      continue;
    }
    for (const file of files) {
      const ref = `${section}/${basename(file, '.md')}`;
      let parsed: matter.GrayMatterFile<string>;
      try {
        parsed = matter(readFileSync(join(dir, section, file), 'utf8'));
      } catch (e) {
        const hint = /alias/i.test(String(e)) ? ' (a bare * is a YAML alias: quote it as "*")' : '';
        throw new Error(`invalid prompt frontmatter in ${ref}: ${(e as Error).message.split('\n')[0]}${hint}`);
      }
      const schema = section === 'heads' || section === 'members' ? actorSchema : plainSchema;
      const res = schema.safeParse(parsed.data);
      if (!res.success) throw new Error(`invalid prompt frontmatter in ${ref}: ${res.error.message}`);
      const meta = res.data as PromptMeta;
      if (meta.tools.includes('*') && ref !== WILDCARD_REF) {
        throw new Error(`invalid prompt ${ref}: tools "*" is allowed only in ${WILDCARD_REF}`);
      }
      if (section === 'heads' && meta.dept !== basename(file, '.md')) {
        throw new Error(`invalid prompt ${ref}: dept must equal file name`);
      }
      docs.set(ref, { ref, meta, body: parsed.content.trim() });
    }
  }
  for (const doc of docs.values()) {
    for (const f of doc.meta.fragments) {
      if (!docs.has(`fragments/${f}`)) throw new Error(`prompt ${doc.ref} references missing fragment ${f}`);
    }
  }
  return docs;
}

/** Active override body replaces the file body; meta always comes from the file. K6: a protected ref is never overridden. */
export async function resolvePrompt(
  ref: string,
  docs: Map<string, PromptDoc>,
  overrides: Pick<PromptOverrideRepo, 'getActive'>,
): Promise<PromptDoc> {
  const doc = docs.get(ref);
  if (!doc) throw new Error(`unknown prompt ref: ${ref}`);
  if (isProtectedRef(ref)) return doc;
  const active = await overrides.getActive(ref);
  return active ? { ...doc, body: active.body } : doc;
}
