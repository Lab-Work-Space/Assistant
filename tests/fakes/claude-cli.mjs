#!/usr/bin/env node
// Fake `claude` CLI for provider tests. Never talks to any model.
// Behaviour comes from `scenario.json` next to this file (not env, not argv: the provider controls both).
// scenario: { mode, dump, payload?, usage?, stderr?, code?, sleepMs?, bytes? }
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const base = JSON.parse(readFileSync(join(dirname(process.argv[1]), 'scenario.json'), 'utf8'));
// `sequence`: one scenario per attempt (the n-th start uses the n-th entry, the last one repeats); STREAM-1 retry tests.
const scenario = (() => {
  if (!Array.isArray(base.sequence)) return base;
  const counter = join(dirname(process.argv[1]), 'attempt.count');
  const n = existsSync(counter) ? Number(readFileSync(counter, 'utf8')) : 0;
  writeFileSync(counter, String(n + 1));
  return { dump: base.dump, ...base.sequence[Math.min(n, base.sequence.length - 1)] };
})();

const chunks = [];
process.stdin.on('data', (c) => chunks.push(c));
process.stdin.on('end', () => main(Buffer.concat(chunks).toString('utf8')));

function dump(rec) {
  if (scenario.dump) appendFileSync(scenario.dump, JSON.stringify(rec) + '\n');
}

function systemPromptFile(argv) {
  const a = argv.find((x) => x.startsWith('--system-prompt-file='));
  const p = a?.slice('--system-prompt-file='.length);
  return p && existsSync(p) ? readFileSync(p, 'utf8') : null;
}

function out(payload, extra = {}) {
  const body = { type: 'result', subtype: 'success', is_error: false, ...extra };
  if (payload !== undefined) body.structured_output = payload;
  if (scenario.usage) body.usage = scenario.usage;
  process.stdout.write(JSON.stringify(body));
}

function main(stdin) {
  const argv = process.argv.slice(2);
  const cwd = process.cwd();
  const rec = {
    event: 'start', pid: process.pid, t: Date.now(), argv, cwd,
    cwdMode: statSync(cwd).mode & 0o777, env: process.env, stdin, system: systemPromptFile(argv),
  };
  const done = (code) => {
    dump({ event: 'end', pid: process.pid, t: Date.now() });
    process.exitCode = code;
  };
  if (scenario.stderr) process.stderr.write(scenario.stderr);
  switch (scenario.mode) {
    case 'payload': // like the real CLI: structured_output object, plus `result` as the same JSON string
      dump(rec);
      out(scenario.payload, { result: JSON.stringify(scenario.payload) });
      return done(0);
    case 'result-string': // only `result` (JSON string), no structured_output
      dump(rec);
      out(undefined, { result: JSON.stringify(scenario.payload) });
      return done(0);
    case 'raw': // stdout verbatim
      dump(rec);
      process.stdout.write(scenario.stdout);
      return done(0);
    case 'is_error':
      dump(rec);
      process.stdout.write(JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, result: scenario.result ?? 'boom' }));
      return done(0);
    case 'stream':
    case 'stream-hang': {
      // STREAM-1: stream-json lines (objects are JSON-encoded, strings are written verbatim) with an optional gap; `splitAt` writes the bytes in two parts
      // at that offset of the whole output (a multi-byte character can straddle it); 'stream-hang' then runs until killed.
      dump(rec);
      const text = scenario.events.map((e) => (typeof e === 'string' ? e : JSON.stringify(e))).join('\n') + (scenario.noTrailingNewline ? '' : '\n');
      const all = Buffer.from(text, 'utf8');
      const cut = scenario.splitAt ?? all.length;
      const finish = () => (scenario.mode === 'stream-hang' ? setInterval(() => {}, 1000) : done(scenario.code ?? 0));
      process.stdout.write(all.subarray(0, cut));
      if (cut >= all.length) return finish();
      setTimeout(() => {
        process.stdout.write(all.subarray(cut));
        finish();
      }, scenario.gapMs ?? 30);
      return;
    }
    case 'exit':
      dump(rec);
      return done(scenario.code ?? 1);
    case 'slow':
      dump(rec);
      setTimeout(() => { out(scenario.payload); done(0); }, scenario.sleepMs ?? 300);
      return;
    case 'oversize': {
      // Writes `bytes` to stdout, then keeps running until killed.
      const grand = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
      dump({ ...rec, grandchild: grand.pid });
      const buf = Buffer.alloc(64 * 1024, 'x');
      let left = scenario.bytes ?? 2 * 1024 * 1024;
      const pump = () => {
        while (left > 0) {
          left -= buf.length;
          if (!process.stdout.write(buf)) return void process.stdout.once('drain', pump);
        }
      };
      pump();
      setInterval(() => {}, 1000);
      return;
    }
    case 'inherit-exit':
    case 'escaped-exit':
    case 'escaped-hang': {
      // A descendant that inherits (and so holds open) our stdout/stderr pipes. `escaped-*` puts it in its
      // own session (setsid via detached), out of reach of a process-group kill.
      const escaped = scenario.mode !== 'inherit-exit';
      const grand = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit', detached: escaped });
      grand.unref();
      dump({ ...rec, grandchild: grand.pid });
      if (scenario.mode === 'escaped-hang') return void setInterval(() => {}, 1000);
      out(scenario.payload);
      return done(0);
    }
    case 'hang':
    case 'hang-stubborn': {
      // Runs until killed; the stubborn variant ignores SIGTERM, so only SIGKILL ends it.
      if (scenario.mode === 'hang-stubborn') process.on('SIGTERM', () => {});
      const grand = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: 'ignore' });
      dump({ ...rec, grandchild: grand.pid });
      setInterval(() => {}, 1000);
      return;
    }
    default:
      dump(rec);
      process.stderr.write('unknown scenario');
      return done(2);
  }
}
