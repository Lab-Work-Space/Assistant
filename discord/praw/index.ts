import type { Client } from 'discord.js';
import { PRAW_COMMANDS } from './definitions.js';

export * from './commands.js';
export * from './context.js';
export * from './definitions.js';
export { AUTO_OCR_INSTRUCTION, hasReadableAttachment } from './ocr.js';

/** Guild commands on Praw's own client (network; kept tiny, untested beyond the call). Never the config COMMANDS (R7). */
export async function registerPrawCommands(praw: Client, guildId: string): Promise<void> {
  if (!praw.application) throw new Error('praw client not ready');
  await praw.application.commands.set(PRAW_COMMANDS, guildId);
}
