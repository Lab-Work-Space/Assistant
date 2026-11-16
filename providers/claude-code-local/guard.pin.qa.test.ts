import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { localProviderAllowed, nodeGuardExec, nodeGuardFs, PROBE_PIN_FILE, sha256File } from './guard.js';
import { argvDigest } from './protocol.js';

/** STREAM-1 tester (j): the real guard over the real fs, but in a scratch HOME and a scratch PATH (never ~/.config/assistant). */
let root: string;
let home: string;
let bin: string;
let claude: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'pin-qa-')));
  home = join(root, 'home');
  bin = join(root, 'bin');
  mkdirSync(home, { mode: 0o700 });
  mkdirSync(bin, { mode: 0o700 });
  claude = join(bin, 'claude');
  writeFileSync(claude, '#!/bin/sh\necho "2.1.319 (Claude Code)"\n', { mode: 0o755 });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const writePin = async (fields: Record<string, string | undefined>, mode = 0o600) => {
  const p = join(home, PROBE_PIN_FILE);
  mkdirSync(join(p, '..'), { recursive: true, mode: 0o700 });
  chmodSync(join(p, '..'), 0o700);
  const all = { version: '2.1.319 (Claude Code)', realpath: claude, sha256: await sha256File(claude), ...fields };
  writeFileSync(p, Object.entries(all).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}=${v}`).join('\n') + '\n', { mode });
  chmodSync(p, mode);
};
const run = () => localProviderAllowed({ vars: { ALLOW_LOCAL_PROVIDERS: '1', PATH: bin }, platform: 'darwin', execArgv: [], home }, nodeGuardFs, nodeGuardExec);
const OLD = 'the probe pin is in an old format (it does not bind the CLI arguments); run: bash scripts/probe-local-cli.sh --yes';

describe('probe pin and argv_sha256 (S16)', () => {
  it('a pin without argv_sha256 is refused with the owner message', async () => {
    await writePin({});
    expect(await run()).toEqual({ ok: false, reason: OLD, code: 'pin_old_format' });
  });
  it('an empty argv_sha256 value is refused the same way', async () => {
    await writePin({ argv_sha256: '' });
    expect(await run()).toEqual({ ok: false, reason: OLD, code: 'pin_old_format' });
  });
  it('a wrong digest is refused, with the re-run instruction', async () => {
    await writePin({ argv_sha256: '0'.repeat(64) });
    expect(await run()).toEqual({ ok: false, reason: 'the provider CLI arguments changed since the last probe; run: bash scripts/probe-local-cli.sh --yes', code: 'argv_changed' });
  });
  it('the digest of the provider argv is accepted (positive control), also in upper case', async () => {
    await writePin({ argv_sha256: argvDigest() });
    expect(await run()).toMatchObject({ ok: true });
    await writePin({ argv_sha256: argvDigest().toUpperCase() });
    expect(await run()).toMatchObject({ ok: true });
  });
  it('a group-readable pin (0640) is not trusted even with a correct digest', async () => {
    await writePin({ argv_sha256: argvDigest() }, 0o640);
    expect(await run()).toMatchObject({ ok: false });
  });
  it('the digest does not depend on a per-request model or effort (it is one fixed value)', () => {
    expect(argvDigest()).toMatch(/^[0-9a-f]{64}$/);
    expect(argvDigest()).toBe(argvDigest());
  });
});
