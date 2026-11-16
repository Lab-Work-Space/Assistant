import { systemResolver, systemTransport } from '../../../net/system.js';
import type { GroupFactory } from '../index.js';
import type { WebNetOptions } from './browser.js';
import { fetchPageTool } from './fetchPage.js';
import { openSearchBackend, searchChain } from './openSearch.js';
import { ddgBackend, webSearchTool } from './webSearch.js';

export type { WebNetOptions, WebBrowser } from './browser.js';

/**
 * `fetch_page` + `web_search` (Task 14). Needs no keys. With a browser configured (local mode, Chrome only) the group is off when the
 * boot check of the browser failed (`browserDisabled`); it never falls back to plain HTTP then. `extraPorts` is read per call.
 */
export const webGroup: GroupFactory = (deps) => {
  if (deps.browserDisabled) return { id: 'web', disabled: deps.browserDisabled };
  const o: WebNetOptions = {
    ...(deps.browser ? { browser: deps.browser } : {}),
    resolver: deps.net?.resolver ?? systemResolver,
    transport: deps.net?.transport ?? systemTransport,
    extraPorts: () => deps.cfg.get('net.extraPorts'),
  };
  return { id: 'web', tools: [fetchPageTool(o), webSearchTool(searchChain(ddgBackend(o), openSearchBackend(o), {
    // SEARCH-1: read live on every call (kill switch); a read error counts as off.
    enabled: () => { try { return deps.cfg.get('web.search.openSources') === true; } catch { return false; } },
  }))] };
};
