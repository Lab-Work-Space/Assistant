import { execFile } from 'node:child_process';
import { childEnv } from '../core/child-env.js';
import type { Exec } from './binaries.js';

const TIMEOUT_MS = 15_000;
const MAX_STDOUT = 64 * 1024;

/** Production Exec for the boot binaries check: no shell, childEnv() (P8, never process.env), a timeout and an output cap. */
export const nodeExec: Exec = (file, args) =>
  new Promise((resolve) => {
    const c = childEnv();
    execFile(file, args, { env: c.env, shell: false, timeout: TIMEOUT_MS, maxBuffer: MAX_STDOUT, windowsHide: true }, (err, stdout) => {
      c.cleanup();
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? ((err as { code: number }).code) : null) : 0;
      resolve({ code, stdout: String(stdout ?? '') });
    });
  });
