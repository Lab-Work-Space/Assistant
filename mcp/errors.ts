/**
 * R6 MCP-1: the closed code set and the fixed texts. An McpError carries a code (and, for E_SCHEMA and E_SCREEN, the index of the tool in the sorted snapshot) and
 * nothing else: its message is the code, so no server text, model text or zod issue can ride in an error (MC-C18).
 */
export type CallCode =
  | 'E_OFF' | 'E_HALTED' | 'E_GONE' | 'E_INPUT' | 'E_CAP_TREE' | 'E_CAP_DAY' | 'E_CAP_SERVER' | 'E_BUSY' | 'E_CHANGED' | 'E_CONFIG' | 'E_STALE'
  | 'E_TIMEOUT' | 'E_OOM' | 'E_EXIT' | 'E_PROTOCOL' | 'E_TOO_BIG' | 'E_SPAWN' | 'E_STUCK' | 'E_INTERNAL';
export type AdminCode =
  | 'E_SLUG' | 'E_EXISTS' | 'E_IMAGE' | 'E_COMMAND' | 'E_ENV' | 'E_CLASS' | 'E_DEPT' | 'E_MAX_SERVERS' | 'E_PROBE' | 'E_TOOLS_NONE' | 'E_TOOLS_MANY'
  | 'E_NAME' | 'E_COLLISION' | 'E_SCHEMA' | 'E_SCREEN' | 'E_HASH' | 'E_STATE' | 'E_FIELD' | 'E_SECCOMP';
export type McpCode = CallCode | AdminCode;

export class McpError extends Error {
  constructor(readonly code: McpCode, readonly index?: number) {
    super(code);
    this.name = 'McpError';
  }
}

/** What the model reads after a call (spec 5.13). Nothing echoes input or server text. */
export const MCP_TEXT: Record<CallCode, string> = {
  E_OFF: 'External tools are switched off.',
  E_HALTED: 'The company is halted; nothing was run.',
  E_GONE: 'This external tool is no longer installed.',
  E_INPUT: 'The input was refused (a secret-like value, hidden characters or over 8000 characters). Nothing was run.',
  E_CAP_TREE: 'The daily (or task) limit for external tools is reached. Nothing was run.',
  E_CAP_DAY: 'The daily (or task) limit for external tools is reached. Nothing was run.',
  E_CAP_SERVER: 'The daily (or task) limit for external tools is reached. Nothing was run.',
  E_BUSY: 'External tools are busy; try again shortly. Nothing was run.',
  E_CHANGED: 'The server changed its tool list, so it is quarantined until a Bot Admin re-approves it. Nothing was run.',
  E_CONFIG: 'The server configuration changed since it was approved, so it is quarantined until a Bot Admin re-approves it. Nothing was run.',
  E_STALE: 'The server configuration was changed by a Bot Admin since this was requested, so nothing was run. Ask again if it is still needed.',
  E_TIMEOUT: 'The external tool failed (E_TIMEOUT).',
  E_OOM: 'The external tool failed (E_OOM).',
  E_EXIT: 'The external tool failed (E_EXIT).',
  E_PROTOCOL: 'The external tool failed (E_PROTOCOL).',
  E_TOO_BIG: 'The external tool failed (E_TOO_BIG).',
  E_SPAWN: 'The external tool failed (E_SPAWN).',
  E_STUCK: 'The external tool failed (E_STUCK).',
  E_INTERNAL: 'The external tool could not be started. Nothing was run.',
};

/** One fixed line per admin code (the Bot Admin's reply). */
export const ADMIN_TEXT: Record<AdminCode | 'E_HALTED' | 'E_INTERNAL' | 'E_CHANGED', string> = {
  E_SLUG: 'The slug must be 2 to 16 lowercase letters or digits, starting with a letter.',
  E_EXISTS: 'A server with that slug is already pending or active; disable it first.',
  E_IMAGE: 'The image id must be sha256:<64 hex>, present on this host, and declare no volumes.',
  E_COMMAND: 'The command must be a JSON array of at most 16 safe words (at most 1000 characters in all).',
  E_ENV: 'The env must be KEY=VALUE pairs (at most 16) with safe keys and non-secret values.',
  E_CLASS: 'The class must be read or write.',
  E_DEPT: 'Departments must be 1 to 10 existing department ids.',
  E_MAX_SERVERS: 'At most 8 servers may be pending or active.',
  E_PROBE: 'The server could not be started or did not answer the handshake.',
  E_TOOLS_NONE: 'The server lists no tools.',
  E_TOOLS_MANY: 'The server lists more than 32 tools.',
  E_NAME: 'A tool name is not usable (letters, digits, _ . - only, and it must normalize to a short lowercase name).',
  E_COLLISION: 'Two tools have the same normalized name.',
  E_SCHEMA: 'A tool schema is outside the supported subset or over a size limit.',
  E_SCREEN: 'A tool description, enum value or title was refused (hidden characters or a secret-like value).',
  E_HASH: 'The token does not match the current configuration; run /mcp show and use the token it prints.',
  E_STATE: 'That server is not in a state that allows this.',
  E_SECCOMP: 'Docker does not report a seccomp filter (or it is unconfined), or the check could not be read; no server was started. Check docker info.',
  E_FIELD: 'A field is out of range (timeout 5 to 120 seconds, daily 1 to 1000, ref a safe string).',
  E_HALTED: 'The company is halted; nothing was done.',
  E_INTERNAL: 'That could not be done now; nothing was changed.',
  E_CHANGED: 'The server no longer matches its approved snapshot; it stays pending.',
};
