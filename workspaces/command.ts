import { WsError } from './errors.js';
import { wsRel } from './files.js';
import { SandboxError } from '../tools/plugins/workspace/sandbox.js';

/**
 * The ws_run command allowlist (SA-1 5.3, Gate 1 WS-C1/WS-C3). The model never builds argv: it writes one string, this parser accepts exactly
 * the forms below (or throws E_CMD), and `cmdFor` maps the verb to a fixed command. There is no shell anywhere.
 */
export type Verb = 'ci' | 'install' | 'test' | 'run' | 'tsc' | 'node';
export type Parsed = { verb: Verb; specs: string[]; script?: string; noEmit?: boolean; rel?: string };

export const REGISTRY_URL = 'http://10.88.80.2:4873';
const FORBIDDEN = /[^A-Za-z0-9@/._:= -]/;
const SPEC = /^(@[a-z0-9][a-z0-9._-]{0,213}\/)?[a-z0-9][a-z0-9._-]{0,213}@\d{1,6}\.\d{1,6}\.\d{1,6}(-[0-9A-Za-z.-]{1,64})?$/;
export const SCRIPT_RE = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,63}$/;
const NODE_BIN = '/usr/local/bin/node';
const NPM_BIN = '/usr/local/bin/npm';

export function parseCommand(raw: string): Parsed {
  const no = (): never => {
    throw new WsError('E_CMD');
  };
  if (typeof raw !== 'string' || raw.length > 600 || FORBIDDEN.test(raw)) return no();
  const t = raw.trim().split(/ +/);
  const [a, b, ...rest] = t;
  if (a === 'npm' && b === 'ci' && rest.length === 0) return { verb: 'ci', specs: [] };
  if (a === 'npm' && b === 'test' && rest.length === 0) return { verb: 'test', specs: [] };
  if (a === 'npm' && b === 'install') {
    if (rest.length > 10 || !rest.every((s) => SPEC.test(s))) return no();
    return { verb: 'install', specs: rest };
  }
  if (a === 'npm' && b === 'run' && rest.length === 1 && SCRIPT_RE.test(rest[0]!)) return { verb: 'run', specs: [], script: rest[0]! };
  if (a === 'npx' && b === 'tsc' && rest.length === 0) return { verb: 'tsc', specs: [], noEmit: false };
  if (a === 'npx' && b === 'tsc' && rest.length === 1 && rest[0] === '--noEmit') return { verb: 'tsc', specs: [], noEmit: true };
  if (a === 'node' && b !== undefined && rest.length === 0 && /\.(js|mjs)$/.test(b)) {
    try {
      wsRel(b);
    } catch (e) {
      if (e instanceof SandboxError) return no();
      throw e;
    }
    return { verb: 'node', specs: [], rel: b };
  }
  return no();
}

export const needsNetwork = (v: Verb): boolean => v === 'ci' || v === 'install';

/**
 * The fixed command inside the container, per verb (SA-1 5.3; the install flags are those of docker/devjob/prep.sh, with ONE change found by the
 * P4 probe: npm 12 refuses `--userconfig /dev/null --globalconfig /dev/null` ("double-loading config /dev/null"), so the global config points at a
 * path that does not exist on the read-only root and cannot be created. Both files are still empty.)
 */
export function cmdFor(p: Parsed): string[] {
  switch (p.verb) {
    case 'ci':
    case 'install':
      return [NPM_BIN, p.verb, '--ignore-scripts', '--no-audit', '--no-fund', '--registry', REGISTRY_URL, '--userconfig', '/dev/null', '--globalconfig', '/nonexistent/npmrc', '--replace-registry-host=always', ...p.specs];
    case 'test':
      return [NPM_BIN, 'test'];
    case 'run':
      return [NPM_BIN, 'run', p.script!];
    case 'tsc':
      return [NODE_BIN, '/work/node_modules/typescript/bin/tsc', ...(p.noEmit ? ['--noEmit'] : [])];
    case 'node':
      return [NODE_BIN, `/work/${p.rel!}`];
  }
}
