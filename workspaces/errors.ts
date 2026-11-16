/**
 * WS-1 (SA-1 5.7): every refusal is a fixed text chosen by code. No model text, host path or docker stderr is ever put in one
 * (a SandboxError carries its own fixed message and passes through the tool layer). Codes for ws_run / ws_export (WS-BE2) are at the end.
 */
export const WS_TEXT = {
  E_OFF: 'Workspaces are switched off.',
  E_HALTED: 'The company is halted; nothing was run.',
  E_DEPT: 'Workspaces are for the software team only.',
  E_HEAD: 'Only the software head can create a workspace.',
  E_SLUG: 'No such workspace.',
  E_ARCHIVED: 'That workspace is archived (read-only).',
  E_LIMIT: 'At most 5 active workspaces.',
  E_EXISTS: 'A workspace with that name exists.',
  E_DIR: 'A folder with that name already exists on disk; ask the owner.',
  E_BUSY: 'A run is in progress in this workspace; try again after it ends.',
  E_NPMRC: 'A .npmrc file is not allowed in a workspace.',
  E_QUOTA: 'The workspace is over its size or file limit; delete files first.',
  E_IO: 'The workspace operation failed.',
  E_NOTASK: 'ws_run and ws_export work only inside a task.',
  E_NOSOURCE: 'ws_export posts the zip in the thread of the task; there is no thread here.',
  E_CMD: 'That command is not allowed. Allowed: npm ci, npm install [name@x.y.z ...], npm test, npm run <script>, npx tsc [--noEmit], node <file.js|.mjs>.',
  E_SCRIPT: 'That npm script is not defined in package.json of the workspace.',
  E_TSC: 'TypeScript is not installed in this workspace (run npm install typescript@x.y.z first).',
  E_SPEC: 'package.json holds a dependency that is not a plain registry version (git, URL, file, alias and path specs are not allowed).',
  E_PROXY: 'The package proxy is not running (owner: npm run local:ws).',
  E_GLOBAL: 'Two sandbox runs are already active; try again later.',
  E_CAP_TREE: 'The run limit for this task is reached.',
  E_CAP_DAY: 'The run limit for today is reached.',
  E_START: 'The sandbox could not start (exit <n>).',
  E_TIMEOUT: 'The run hit the 5-minute limit and was stopped (exit 137).',
  E_MEMORY: 'The run used more than 2 GB and was stopped (exit <n>).',
  E_STUCK: 'The sandbox could not be cleaned up; the workspace stays locked until the owner restarts the bot.',
  E_EXPORT_SIZE: 'The export is empty or too large (at most 2000 files, 5 MB per file, 10,000,000 bytes in the zip).',
  E_EXPORT_SECRET: 'The export was refused: <n> file(s) contain a company secret; remove it first.',
  E_EXPORT_POST: 'The zip was not posted (the bot may lack Attach Files here).',
} as const;
export type WsCode = keyof typeof WS_TEXT;

/** Carries only a code (and a number for the texts with `<n>`: an exit status or a file count); the text comes from WS_TEXT. */
export class WsError extends Error {
  constructor(readonly code: WsCode, readonly n?: number) {
    super(WS_TEXT[code].replace('<n>', String(n ?? 0)));
    this.name = 'WsError';
  }
}
