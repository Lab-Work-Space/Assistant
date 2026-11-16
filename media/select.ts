import { NOT_CONFIGURED, type MediaBackend } from './backend.js';

/**
 * Which media backend the app uses (spec 4.4, R5). Pure: the container check and both constructors are injected. A socket always
 * wins (the sidecar). Without one, the local binaries are used only outside a container; in a container the app fails closed with
 * no backend at all, and app.ts disables music and voice with this reason. Only the chosen factory is called.
 */
export function selectMediaBackend(o: {
  mediaSocket?: string;
  inContainer: () => string | null;
  local: () => MediaBackend;
  socket: (p: string) => MediaBackend;
}): { backend: MediaBackend } | { disabled: string } {
  if (o.mediaSocket) return { backend: o.socket(o.mediaSocket) };
  if (o.inContainer()) return { disabled: NOT_CONFIGURED };
  return { backend: o.local() };
}
