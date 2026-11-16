import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const FAKE_SRC = join(dirname(fileURLToPath(import.meta.url)), 'claude-cli.mjs');

/** One line the fake CLI appends to its dump file per process start/end. */
export type FakeClaudeRecord = {
  event: 'start' | 'end'; pid: number; t: number; argv?: string[]; cwd?: string; cwdMode?: number;
  env?: Record<string, string>; stdin?: string; system?: string | null; grandchild?: number;
};

export type FakeClaude = {
  path: string;
  dump: string;
  records: () => FakeClaudeRecord[];
  starts: () => FakeClaudeRecord[];
  /** Writes scenario.json next to the fake: its only control channel (the provider owns env and argv). */
  scenario: (s: object) => void;
};

/** Installs the fake `claude` in `dir` (which must not be group/world-writable), shebang pinned to this node. */
export function installFakeClaude(dir: string): FakeClaude {
  const path = join(dir, 'claude');
  const dump = join(dir, 'dump.jsonl');
  writeFileSync(path, readFileSync(FAKE_SRC, 'utf8').replace(/^#!.*\n/, `#!${process.execPath}\n`));
  chmodSync(path, 0o755);
  const records = () =>
    existsSync(dump) ? readFileSync(dump, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as FakeClaudeRecord) : [];
  return {
    path,
    dump,
    records,
    starts: () => records().filter((r) => r.event === 'start'),
    scenario: (s) => writeFileSync(join(dir, 'scenario.json'), JSON.stringify({ dump, ...s })),
  };
}
