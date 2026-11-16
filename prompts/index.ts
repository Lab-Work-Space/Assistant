import { fileURLToPath } from 'node:url';

export * from './loader.js';
export * from './assemble.js';

/** Directory holding the prompt Markdown files (same layout in source and dist). */
export const PROMPTS_DIR = fileURLToPath(new URL('.', import.meta.url));
export * from './protected.js';
