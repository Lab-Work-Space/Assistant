/**
 * R7 PLUGIN-FORGE (spec 5.7): fixed texts. All of it is code text; nothing here echoes model text, plugin content, stderr or a zod error.
 */

/** The closed list of build failure codes (spec 5.7): also INCIDENT_CODES.forge_failed and the S9 filter. */
export const BUILD_CODES = [
  'base_missing', 'stage_dir', 'create_failed', 'copy_failed', 'commit_failed', 'verify_failed', 'image_too_big', 'image_cap', 'stuck', 'timeout', 'interrupted', 'attempts', 'zip_invalid',
  'stage_probe', 'stage_seccomp', 'stage_tools', 'stage_schema', 'stage_screen', 'stage_name', 'stage_exists', 'stage_max', 'stage_image', 'stage_state', 'stage_other',
] as const;
export type BuildCode = (typeof BUILD_CODES)[number];

/** Validator code -> text lives in validate.ts (releases/ may import it; it may not import this file). Re-exported for the existing callers. */
export { PLUGIN_TEXT, pluginText } from './validate.js';

export const FORGE_BASE_ALERT = 'Plugin forge: the base image is missing or changed; builds wait.';
export const FORGE_STUCK_ALERT = 'Plugin forge: a build container could not be removed; builds are paused until the service restarts.';

const id12 = (id: string): string => id.replace(/^sha256:/, '').slice(0, 12);
/** To the software head. */
export const NOTICE_STAGED_SOFTWARE = (slug: string, releaseId: number): string =>
  `Plugin ${slug} (release #${releaseId}) was built and staged. A Bot Admin must install it with /mcp approve; until then do not say it is installed.`;
/** To the HQ alert in #setting. */
export const NOTICE_STAGED_HQ = (forgeId: number, slug: string, releaseId: number, imageId: string, tools: number, config12: string): string =>
  `Forge #${forgeId}: plugin ${slug} from release #${releaseId} was built by code (image ${id12(imageId)}) and staged with ${tools} tool(s). Review: /mcp show slug:${slug}. Install: /mcp approve slug:${slug} hash:${config12}. Every call will ask a Bot Admin.`;
/** The same alert for an adopted build (a crash after the stage lost the first one): no McpAdmin is in reach here, so the text points to `/mcp show`, which prints the approve token. */
export const NOTICE_STAGED_HQ_ADOPTED = (forgeId: number, slug: string, releaseId: number, imageId: string): string =>
  `Forge #${forgeId}: plugin ${slug} from release #${releaseId} was built by code (image ${id12(imageId)}) and staged earlier; it waits for a Bot Admin. Review and get the install token: /mcp show slug:${slug}. Every call will ask a Bot Admin.`;
export const NOTICE_FAILED_SOFTWARE = (releaseId: number, code: string): string =>
  `The build of release #${releaseId} failed (${code}). Nothing was installed. Fix the workspace and request a new release with target install_plugin.`;
export const NOTICE_INSTALLED = (ideaId: number, name: string, slug: string, tools: number): string =>
  `Tool idea #${ideaId} (${name}) is installed as MCP server ${slug} (${tools} tool(s), names start with mcp_w_${slug}_). Every call asks a Bot Admin.`;
