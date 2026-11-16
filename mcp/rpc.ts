import type { Readable } from 'node:stream';
import { McpError } from './errors.js';

/**
 * R6 MCP-1 (D6, MC-C11): the minimal, capped JSON-RPC 2.0 stdio client. No SDK. Everything the server writes is attacker text:
 *  - the byte caps are enforced on Buffer chunks before the newline split and before `JSON.parse` (1 MiB per line, 4 MiB in all, 64 lines in all, blank lines
 *    and server requests included);
 *  - nesting is capped at 32 by a string-aware bracket scan of the raw line BEFORE `JSON.parse`, so a 200k-deep array is E_PROTOCOL, never a RangeError;
 *  - a line is one JSON object (an array, a batch, is E_PROTOCOL for every protocol version); a response must match exactly one outstanding integer id;
 *    `result` must be a plain object; a JSON-RPC error response is E_PROTOCOL and its text is dropped;
 *  - server requests: `ping` gets `{}`, everything else (sampling, elicitation, roots) gets -32601; notifications are ignored.
 * Any violation is fatal: every pending request fails with it, `onFatal` fires once (the sandbox kills the container) and nothing more is written.
 */
export interface McpProc {
  stdin: { write(data: string): unknown; end(): void; on(ev: 'error', cb: () => void): unknown };
  stdout: Readable;
  stderr: Readable;
  /** Resolves when the process and its pipes are closed. */
  exited: Promise<{ code: number | null; spawnFailed: boolean }>;
  kill(): void;
}
export type McpSpawner = (argv: readonly string[]) => McpProc;

export const PROTOCOL_VERSION = '2025-11-25';
export const ACCEPTED_VERSIONS: readonly string[] = ['2025-11-25', '2025-06-18', '2025-03-26'];
export const RPC_LIMITS = { line: 1024 * 1024, total: 4 * 1024 * 1024, lines: 64, toolsBytes: 256 * 1024, depth: 32, pages: 4, cursor: 256 } as const;
export const INIT_TIMEOUT_MS = 20_000;
export const LIST_TIMEOUT_MS = 10_000;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/** True when the raw line nests deeper than `max` (brackets outside strings). One pass over the bytes, no recursion. */
export function nestsDeeperThan(b: Buffer, max: number): boolean {
  let depth = 0;
  let inStr = false;
  for (let i = 0; i < b.length; i++) {
    const c = b[i]!;
    if (inStr) {
      if (c === 0x5c) i++;
      else if (c === 0x22) inStr = false;
    } else if (c === 0x22) inStr = true;
    else if (c === 0x5b || c === 0x7b) {
      if (++depth > max) return true;
    } else if ((c === 0x5d || c === 0x7d) && depth > 0) depth--;
  }
  return false;
}

interface Pending { resolve(v: Obj): void; reject(e: McpError): void; timer: NodeJS.Timeout }

export class RpcClient {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private parts: Buffer[] = [];
  private lineBytes = 0;
  private total = 0;
  private lines = 0;
  private dead: McpError | null = null;
  private ended = false;

  constructor(private readonly proc: McpProc, private readonly o: { onFatal?: (e: McpError) => void } = {}) {
    proc.stdout.on('data', (c: Buffer | string) => this.onData(typeof c === 'string' ? Buffer.from(c) : c));
    proc.stdout.on('error', () => this.fail(new McpError('E_EXIT')));
    proc.stderr.on('data', () => undefined); // drained and discarded by the sandbox ring; never read here
    proc.stderr.on('error', () => undefined);
    proc.stdin.on('error', () => this.fail(new McpError('E_EXIT')));
    void proc.exited.then(() => this.fail(new McpError('E_EXIT')));
  }

  get fatal(): McpError | null { return this.dead; }

  private fail(e: McpError): void {
    if (this.dead || this.ended) return;
    this.dead = e;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(e); }
    this.pending.clear();
    this.parts = [];
    try { this.o.onFatal?.(e); } catch { /* never throws out of a stream handler */ }
  }

  private write(msg: Obj): void {
    try { this.proc.stdin.write(`${JSON.stringify(msg)}\n`); } catch { this.fail(new McpError('E_EXIT')); }
  }

  /** Ends stdin (the sandbox calls this in `finally`); after it nothing more is written and a later exit is not an error. */
  closeStdin(): void {
    this.ended = true;
    for (const p of this.pending.values()) clearTimeout(p.timer);
    this.pending.clear();
    try { this.proc.stdin.end(); } catch { /* already closed */ }
  }

  private onData(chunk: Buffer): void {
    if (this.dead || this.ended) return;
    this.total += chunk.length;
    if (this.total > RPC_LIMITS.total) return this.fail(new McpError('E_TOO_BIG'));
    let pos = 0;
    while (pos <= chunk.length) {
      const nl = chunk.indexOf(0x0a, pos);
      const end = nl < 0 ? chunk.length : nl;
      this.lineBytes += end - pos;
      if (this.lineBytes > RPC_LIMITS.line) return this.fail(new McpError('E_TOO_BIG'));
      if (nl < 0) {
        if (end > pos) this.parts.push(chunk.subarray(pos, end));
        return;
      }
      const piece = chunk.subarray(pos, end);
      const line = this.parts.length > 0 ? Buffer.concat([...this.parts, piece]) : piece;
      this.parts = [];
      this.lineBytes = 0;
      pos = nl + 1;
      if (++this.lines > RPC_LIMITS.lines) return this.fail(new McpError('E_TOO_BIG'));
      this.onLine(line);
      if (this.dead || this.ended) return;
    }
  }

  private onLine(raw: Buffer): void {
    const line = raw.length > 0 && raw[raw.length - 1] === 0x0d ? raw.subarray(0, raw.length - 1) : raw;
    if (line.length === 0) return;
    if (nestsDeeperThan(line, RPC_LIMITS.depth)) return this.fail(new McpError('E_PROTOCOL'));
    let msg: unknown;
    try { msg = JSON.parse(line.toString('utf8')); } catch { return this.fail(new McpError('E_PROTOCOL')); }
    if (!isObj(msg) || msg['jsonrpc'] !== '2.0') return this.fail(new McpError('E_PROTOCOL'));
    if ('method' in msg) {
      if (typeof msg['method'] !== 'string') return this.fail(new McpError('E_PROTOCOL'));
      if (!('id' in msg)) return; // a notification (list_changed included): ignored
      const id = msg['id'];
      if (typeof id !== 'string' && !(typeof id === 'number' && Number.isFinite(id))) return this.fail(new McpError('E_PROTOCOL'));
      if (msg['method'] === 'ping') this.write({ jsonrpc: '2.0', id, result: {} });
      else this.write({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } });
      return;
    }
    const id = msg['id'];
    if (typeof id !== 'number' || !Number.isSafeInteger(id)) return this.fail(new McpError('E_PROTOCOL'));
    const p = this.pending.get(id);
    if (!p) return this.fail(new McpError('E_PROTOCOL')); // no such outstanding id, or a duplicate
    const hasResult = 'result' in msg;
    const hasError = 'error' in msg;
    const e = msg['error'];
    const valid = hasResult !== hasError && (hasResult ? isObj(msg['result']) : isObj(e) && typeof e['code'] === 'number');
    if (!valid) return this.fail(new McpError('E_PROTOCOL')); // rejects every pending request, this one included
    clearTimeout(p.timer);
    this.pending.delete(id);
    if (hasError) {
      const err = new McpError('E_PROTOCOL'); // the server's error text is dropped, and an error response ends the conversation
      p.reject(err);
      return this.fail(err);
    }
    p.resolve(msg['result'] as Obj);
  }

  request(method: string, params: unknown, timeoutMs: number): Promise<Obj> {
    if (this.dead) return Promise.reject(this.dead);
    const id = this.nextId++;
    return new Promise<Obj>((resolve, reject) => {
      const timer = setTimeout(() => this.fail(new McpError('E_TIMEOUT')), timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.write({ jsonrpc: '2.0', id, method, params });
    });
  }

  notify(method: string): void {
    if (!this.dead) this.write({ jsonrpc: '2.0', method });
  }

  /** `initialize` (20 s), the version check, then `notifications/initialized`. */
  async handshake(): Promise<void> {
    const r = await this.request('initialize', { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'assistant', version: '1' } }, INIT_TIMEOUT_MS);
    if (typeof r['protocolVersion'] !== 'string' || !ACCEPTED_VERSIONS.includes(r['protocolVersion'])) throw this.stop(new McpError('E_PROTOCOL'));
    this.notify('notifications/initialized');
  }

  private stop(e: McpError): McpError {
    this.fail(e);
    return e;
  }

  /** `tools/list` (10 s per page): at most 4 pages, a cursor of at most 256 characters, the raw total at most 256 KiB. Returns the raw tool objects. */
  async listTools(): Promise<unknown[]> {
    const tools: unknown[] = [];
    let cursor: string | undefined;
    let bytes = 0;
    for (let page = 0; page < RPC_LIMITS.pages; page++) {
      const r = await this.request('tools/list', cursor === undefined ? {} : { cursor }, LIST_TIMEOUT_MS);
      if (!Array.isArray(r['tools'])) throw this.stop(new McpError('E_PROTOCOL'));
      bytes += JSON.stringify(r['tools']).length;
      if (bytes > RPC_LIMITS.toolsBytes) throw this.stop(new McpError('E_TOO_BIG'));
      tools.push(...r['tools']);
      const next = r['nextCursor'];
      if (next === undefined || next === null) return tools;
      if (typeof next !== 'string' || next.length > RPC_LIMITS.cursor || next === cursor) throw this.stop(new McpError('E_PROTOCOL'));
      cursor = next;
    }
    throw this.stop(new McpError('E_PROTOCOL')); // a fifth page was still offered
  }

  callTool(name: string, args: unknown, timeoutMs: number): Promise<Obj> {
    return this.request('tools/call', { name, arguments: args }, timeoutMs);
  }
}
