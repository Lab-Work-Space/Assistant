import type { Env } from '../../../core/env.js';
import type { Logger } from '../../../core/index.js';
import { loopbackUrl } from '../web/boot.js';
import { ChromeRenderer, type RendererOptions } from './render.js';

export type RenderBoot = { renderer?: ChromeRenderer; disabled?: string; /** the check ran and failed (vs. not configured) */ failed?: true };

/** RF15: the fixed text when this host has no renderer (the VPS today). There is no fallback renderer. */
export const RENDERER_OFF = 'the document renderer is not available on this host; doc_create is off (start it with npm run local:render on the owner Mac)';

/**
 * RFMD P3 / RF15: `RENDER_CDP_URL` (+ `RENDER_ACCESS_TOKEN`) point at the DevTools forwarder of docker-compose.render.yml, a Chrome that is NOT the web Chrome.
 * Without them, or when the renderer does not answer or is too old, the docs group is off with a fixed message; nothing falls back to another browser.
 * `seam` replaces the real connection (tests).
 */
export async function bootRenderer(env: Pick<Env, 'render'>, log: Pick<Logger, 'warn'>, seam?: { connect?: RendererOptions['connect'] }): Promise<RenderBoot> {
  const r = env.render;
  if (!r?.cdpUrl) return { disabled: RENDERER_OFF };
  if (!r.token) return { disabled: 'RENDER_ACCESS_TOKEN is not set; run the app with npm run dev after npm run local:render' };
  const cdpUrl = loopbackUrl(r.cdpUrl);
  if (!cdpUrl) return { disabled: 'RENDER_CDP_URL must be http://127.0.0.1:<port>' };
  const renderer = new ChromeRenderer({ cdpUrl, token: r.token, ...(seam?.connect ? { connect: seam.connect } : {}) });
  const c = await renderer.check();
  if (!c.ok) {
    log.warn({ why: c.why }, 'document renderer check failed; docs group disabled');
    return { disabled: c.why, failed: true };
  }
  renderer.startMaintenance();
  return { renderer };
}
