import { HOLDBACK, PREVIEW_MAX } from './stream-holdback.js';

/**
 * STREAM-1 (Gate 1 S20): a strict, incremental JSON scanner that decodes only the top-level `"body"` string of ONE `respond` tool input as it
 * arrives. Shapes:
 *  - `input`: the fragments are the tool input object itself (Claude API `input_json_delta` of a `respond` block).
 *  - `local`: the fragments are claude-code-local's structured output `{"tool_calls":[{"name":..,"input":{..}}]}`; the model controls key
 *    order, so an item streams only when `"name"` was seen before `"input"`, decodes to exactly `respond`, `respond` is an offered tool and no
 *    `name` key is repeated (JSON.parse keeps the last one).
 * Anything unexpected freezes the scanner (it stops emitting; what was already decoded stays). Work is linear and incremental (no re-parse
 * of the accumulated text); the decoded body, the nesting depth and every captured key are bounded. Display only: the final answer never
 * comes from here.
 */
export const BODY_LIMIT = PREVIEW_MAX + HOLDBACK + 4096;
const MAX_DEPTH = 32;
const NAME_CAP = 64;
const MAX_ITEMS = 8;
const LITERAL = /^(?:-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)$/;
const LONG = '\0long';

type Role = 'root' | 'calls' | 'item' | 'input' | 'other';
type Frame = {
  t: 'o' | 'a';
  role: Role;
  /** object: 'key' (expect key or `}`), 'colon', 'value', 'comma'; array: 'value' (value or `]`), 'comma'. */
  ph: 'key' | 'keyonly' | 'colon' | 'value' | 'comma';
  key: string;
  idx: number;
  /** role-specific bookkeeping */
  seenCalls?: boolean;
  nameSeen?: boolean;
  name?: string | undefined;
  nameDup?: boolean;
  inputSeen?: boolean;
  bodySeen?: boolean;
  ok?: boolean;
};

export type ExtractorOptions = { shape: 'input' } | { shape: 'local'; tools: ReadonlySet<string> };
export type ExtractStatus = 'idle' | 'streaming' | 'done' | 'frozen';

export class RespondExtractor {
  private readonly shape: 'input' | 'local';
  private readonly respondOffered: boolean;
  private stack: Frame[] = [];
  private dead = false;
  private finished = false;
  private started = false;
  private doneStreaming = false;
  // string state
  private inStr = false;
  private strIsKey = false;
  private strTarget = false; // the body value being decoded into `body`
  private strCapture = false; // key or name: decoded into `cap`
  private cap = '';
  private esc = false;
  private hexLeft = 0;
  private hexAcc = 0;
  // literal state
  private lit: string | null = null;
  private text = '';
  private changed = false;
  private _status: ExtractStatus = 'idle';

  constructor(opts: ExtractorOptions) {
    this.shape = opts.shape;
    this.respondOffered = opts.shape === 'input' ? true : opts.tools.has('respond');
  }

  /** The decoded body so far (raw model text; the caller redacts and holds back). */
  get body(): string {
    return this.text;
  }
  get status(): ExtractStatus {
    return this._status;
  }

  /** Feeds the next fragment; returns whether the body grew. O(fragment). */
  feed(chunk: string): boolean {
    if (this.dead || this.finished || this.doneStreaming) return false;
    this.changed = false;
    const n = chunk.length;
    let i = 0;
    while (i < n && !this.dead && !this.doneStreaming) {
      if (this.inStr) {
        i = this.strChars(chunk, i);
        continue;
      }
      const c = chunk[i]!;
      if (this.lit !== null) {
        if (/[0-9eE+\-.a-z]/.test(c)) {
          this.lit += c;
          if (this.lit.length > 64) return this.freeze();
          i++;
          continue;
        }
        if (!this.endLiteral()) return this.freeze();
        continue; // re-handle c as structure
      }
      i++;
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r') continue;
      if (this.finished) return this.freeze(); // trailing non-whitespace after the root value
      this.structural(c);
    }
    return this.changed;
  }

  private freeze(): boolean {
    this.dead = true;
    if (this._status !== 'done') this._status = 'frozen';
    return this.changed;
  }

  private top(): Frame | undefined {
    return this.stack[this.stack.length - 1];
  }

  /** Marks that a value was completed in the current container. */
  private valueDone(): void {
    const f = this.top();
    if (!f) {
      this.finished = true;
      return;
    }
    f.ph = 'comma';
    if (f.t === 'a') f.idx++;
  }

  private endLiteral(): boolean {
    const l = this.lit!;
    this.lit = null;
    if (!LITERAL.test(l)) return false;
    this.nonStringValue();
    this.valueDone();
    return true;
  }

  /** A number, literal or container as the value of a role-relevant key. */
  private nonStringValue(): void {
    const f = this.top();
    if (!f || f.t !== 'o') return;
    if (f.role === 'item' && f.key === 'name') {
      f.nameSeen = true;
      f.name = undefined; // not a string: never `respond`
    }
    if (f.role === 'input' && f.key === 'body' && f.ok) this.freezeBody();
  }

  private freezeBody(): void {
    // a non-string body: nothing (more) is shown
    this.dead = true;
    if (this._status !== 'done') this._status = 'frozen';
  }

  private structural(c: string): void {
    const f = this.top();
    if (!this.started) {
      if (c !== '{') return void this.freeze();
      this.started = true;
      this.pushFrame('o');
      return;
    }
    if (!f) return void this.freeze();
    if (f.t === 'o') {
      switch (f.ph) {
        case 'key':
        case 'keyonly':
          if (c === '"') return this.openString(true);
          if (c === '}' && f.ph === 'key') return this.closeFrame();
          return void this.freeze();
        case 'colon':
          if (c === ':') f.ph = 'value';
          else this.freeze();
          return;
        case 'value':
          return this.valueStart(c, f);
        case 'comma':
          if (c === ',') f.ph = 'keyonly';
          else if (c === '}') this.closeFrame();
          else this.freeze();
          return;
      }
    }
    // array
    switch (f.ph) {
      case 'value':
        if (c === ']' && f.idx === 0) return this.closeFrame();
        return this.valueStart(c, f);
      case 'comma':
        if (c === ',') f.ph = 'value';
        else if (c === ']') this.closeFrame();
        else this.freeze();
        return;
      default:
        this.freeze();
    }
  }

  private valueStart(c: string, f: Frame): void {
    if (c === '"') return this.openString(false);
    if (c === '{' || c === '[') {
      this.nonStringValue();
      return this.pushFrame(c === '{' ? 'o' : 'a');
    }
    if (/[0-9\-tfn]/.test(c)) {
      this.lit = c;
      return;
    }
    void f;
    this.freeze();
  }

  private roleOf(t: 'o' | 'a'): Role {
    const p = this.top();
    if (this.shape === 'input') return !p ? 'input' : 'other';
    if (!p) return t === 'o' ? 'root' : 'other';
    if (p.role === 'root' && p.t === 'o' && p.key === 'tool_calls' && t === 'a') return 'calls';
    if (p.role === 'calls' && t === 'o' && p.idx < MAX_ITEMS) return 'item';
    if (p.role === 'item' && p.t === 'o' && p.key === 'input' && t === 'o') return 'input';
    return 'other';
  }

  private pushFrame(t: 'o' | 'a'): void {
    if (this.stack.length >= MAX_DEPTH) return void this.freeze();
    const role = this.roleOf(t);
    const f: Frame = { t, role, ph: t === 'o' ? 'key' : 'value', key: '', idx: 0 };
    if (role === 'input') {
      const parent = this.top();
      if (this.shape === 'local') {
        // the item's `input` key: judged now (name must already be known and be exactly `respond`)
        f.ok = !!parent && parent.nameSeen === true && parent.name === 'respond' && parent.nameDup !== true && this.respondOffered;
      } else f.ok = true;
    }
    this.stack.push(f);
  }

  private closeFrame(): void {
    const f = this.stack.pop()!;
    if (f.role === 'input' && f.ok && this.shape === 'local' && f.bodySeen) {
      this.doneStreaming = true;
      if (this._status === 'streaming') this._status = 'done';
    }
    if (this.shape === 'input' && this.stack.length === 0) {
      if (this._status === 'streaming') this._status = 'done';
    }
    this.valueDone();
  }

  private openString(isKey: boolean): void {
    this.inStr = true;
    this.strIsKey = isKey;
    this.esc = false;
    this.hexLeft = 0;
    this.cap = '';
    this.strTarget = false;
    this.strCapture = isKey;
    const f = this.top()!;
    if (!isKey && f.t === 'o') {
      if (f.role === 'item' && f.key === 'name') this.strCapture = true;
      if (f.role === 'input' && f.key === 'body' && f.ok) {
        if (f.bodySeen) return void this.freeze(); // duplicate body
        f.bodySeen = true;
        this.strTarget = true;
        this._status = 'streaming';
      }
    }
  }

  private emit(s: string): void {
    if (!s) return;
    if (this.strTarget) {
      if (this.text.length + s.length > BODY_LIMIT) {
        this.text += s.slice(0, BODY_LIMIT - this.text.length);
        this.changed = true;
        this.doneStreaming = true; // enough for any preview
        this._status = 'done';
        return;
      }
      this.text += s;
      this.changed = true;
    } else if (this.strCapture) {
      if (this.cap !== LONG) {
        this.cap += s;
        if (this.cap.length > NAME_CAP) this.cap = LONG;
      }
    }
  }

  /** Decodes string characters from `i`; returns the next index. Handles escapes (also split across fragments). */
  private strChars(s: string, i: number): number {
    const n = s.length;
    let run = i;
    const flush = (to: number) => {
      if (to > run && (this.strTarget || this.strCapture)) this.emit(s.slice(run, to));
    };
    while (i < n) {
      if (this.doneStreaming) return n;
      if (this.hexLeft > 0) {
        const d = parseInt(s[i]!, 16);
        if (Number.isNaN(d) || !/[0-9a-fA-F]/.test(s[i]!)) {
          this.freeze();
          return n;
        }
        this.hexAcc = this.hexAcc * 16 + d;
        i++;
        if (--this.hexLeft === 0) {
          this.emit(String.fromCharCode(this.hexAcc));
          run = i;
        } else run = i;
        if (this.doneStreaming) return n;
        continue;
      }
      if (this.esc) {
        const c = s[i]!;
        this.esc = false;
        i++;
        run = i;
        switch (c) {
          case '"': this.emit('"'); break;
          case '\\': this.emit('\\'); break;
          case '/': this.emit('/'); break;
          case 'b': this.emit('\b'); break;
          case 'f': this.emit('\f'); break;
          case 'n': this.emit('\n'); break;
          case 'r': this.emit('\r'); break;
          case 't': this.emit('\t'); break;
          case 'u':
            this.hexLeft = 4;
            this.hexAcc = 0;
            break;
          default:
            this.freeze();
            return n;
        }
        if (this.doneStreaming) return n;
        continue;
      }
      const code = s.charCodeAt(i);
      if (code === 0x22) {
        flush(i);
        i++;
        this.endString();
        return i;
      }
      if (code === 0x5c) {
        flush(i);
        this.esc = true;
        i++;
        run = i;
        continue;
      }
      if (code < 0x20) {
        flush(i);
        this.freeze();
        return n;
      }
      i++;
    }
    flush(n);
    return n;
  }

  private endString(): void {
    this.inStr = false;
    const f = this.top()!;
    const captured = this.strCapture ? this.cap : '';
    if (this.strIsKey) {
      const key = captured;
      f.key = key;
      f.ph = 'colon';
      this.onKey(f, key);
      return;
    }
    if (f.t === 'o' && f.role === 'item' && f.key === 'name') {
      f.nameSeen = true;
      f.name = captured === LONG ? undefined : captured;
    }
    this.strTarget = false;
    this.valueDone();
  }

  private onKey(f: Frame, key: string): void {
    if (f.role === 'root' && key === 'tool_calls') {
      if (f.seenCalls) return void this.freeze();
      f.seenCalls = true;
    } else if (f.role === 'item') {
      if (key === 'name') {
        if (f.nameSeen) f.nameDup = true;
      } else if (key === 'input') {
        if (f.inputSeen) return void this.freeze(); // a second input: the last one wins in JSON.parse
        f.inputSeen = true;
      }
    }
    if (f.nameDup && this._status === 'streaming') this.freeze();
  }
}
