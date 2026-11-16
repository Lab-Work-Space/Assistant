/** The @discordjs/voice module. Loaded on demand, so a DAVE/opus native module failure turns voice off instead of failing the boot (R13). */
export type VoiceLib = typeof import('@discordjs/voice');

let cached: Promise<VoiceLib> | null = null;

export function loadVoiceLibrary(): Promise<VoiceLib> {
  return (cached ??= import('@discordjs/voice'));
}

/** Boot probe: null when the library (and with it @snazzah/davey) loads, else the reason for the one tool-groups alert. */
export async function probeVoiceLibrary(load: () => Promise<unknown> = loadVoiceLibrary): Promise<string | null> {
  try {
    await load();
    return null;
  } catch (err) {
    return `voice library failed to load (${err instanceof Error ? err.name : 'error'}); DAVE/opus unavailable`;
  }
}
