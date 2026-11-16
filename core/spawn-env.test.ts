import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { CHILD_ENV_KEYS, childEnv as cliChildEnv } from '../providers/claude-code-local/index.js';
import { childEnv } from './child-env.js';
import { spawnSafe, startTrack } from '../voice/music/source.js';
import { FAKE_FFMPEG, FAKE_YTDLP, fakeTrackOptions, scratch } from '../voice/music/test-helpers.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
/** The one subsystem with its own exact allowlist (Gate 1 L2): the claude CLI needs HOME and USER. */
const OWN_ALLOWLIST = new Set([
  'providers/claude-code-local/spawn.ts', 'providers/claude-code-local/guard.ts',
  // Self-code (Gate 1 self-code X16, OD-1): git and docker children get their own exact environment (no inherited secrets, no config files); each call must pass `env`.
  'devjob/git.ts', 'devjob/launcher.ts', 'devjob/service.ts', 'devjob/boot.ts', 'devjob/test-helpers.ts', 'devjob/fake-sandbox-fixture.ts', 'executor/code-run.ts', 'scripts/executor-closure.ts', 'executor/code-import-main.ts',
  // WS-1 (Gate 1 WS-C1): the ws runner builds its docker children's env as exactly {PATH, HOME, DOCKER_HOST?}; every call passes `env`.
  'workspaces/runner.ts',
  // R6 MCP-1 (Gate 1 MC-C3, MC-C16): the MCP sandbox spawns `docker` with an array, shell:false and env = dockerEnv() (exactly {PATH, HOME, DOCKER_HOST?}); the call passes `env`.
  'mcp/sandbox.ts', 'mcp/spawner-fixture.ts',
]);
const CALL = /(?<![.\w])(spawn|spawnSync|execFile|execFileSync|exec|execSync|fork)\s*\(/g;
const IMPORT = /['"](node:)?child_process['"]/;

/** Text of every call (from the name to its matching paren). */
function callSites(src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(CALL)) {
    let depth = 0;
    let i = m.index! + m[0].length - 1;
    const start = m.index!;
    for (; i < src.length; i++) {
      if (src[i] === '(') depth++;
      else if (src[i] === ')' && --depth === 0) break;
    }
    out.push(src.slice(start, i + 1));
  }
  return out;
}
/** An env option built from childEnv(), directly or through a local from `const { env } = childEnv(`. */
const usesChildEnv = (src: string, call: string): boolean =>
  /\benv:\s*childEnv\(/.test(call) || (/\benv\b/.test(call) && /=\s*childEnv\(/.test(src));

function sources(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    if (n === 'node_modules' || n === 'dist' || n.startsWith('.')) continue;
    const p = join(dir, n);
    if (statSync(p).isDirectory()) sources(p, out);
    else if (n.endsWith('.ts') && !n.endsWith('.test.ts')) out.push(p);
  }
  return out;
}

describe('spawn-env', () => {
  it('every child env equals its allowlist; grep finds no spawn/execFile without an explicit env', () => {
    const c = childEnv({});
    c.cleanup();
    expect(Object.keys(c.env).every((k) => ['PATH', 'LANG', 'TMPDIR', 'HOME'].includes(k))).toBe(true);
    expect(Object.keys(cliChildEnv({ PATH: '/bin', HOME: '/h', USER: 'u', LANG: 'C', TMPDIR: '/t', SECRET: 's', NODE_OPTIONS: 'x' })).sort()).toEqual([...CHILD_ENV_KEYS].sort());

    const offenders: string[] = [];
    for (const file of sources(ROOT)) {
      const rel = relative(ROOT, file);
      const src = readFileSync(file, 'utf8');
      if (!IMPORT.test(src)) continue;
      for (const call of callSites(src)) {
        if (OWN_ALLOWLIST.has(rel) ? /\benv\b/.test(call) : usesChildEnv(src, call)) continue;
        offenders.push(`${rel}: ${call.slice(0, 60)}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the grep rule bites: a spawn without childEnv is reported', () => {
    for (const q of ["'", '"']) {
      const bad = `import { spawn } from ${q}child_process${q};\nspawn('ls', [], { shell: false });`;
      expect(IMPORT.test(bad)).toBe(true);
      expect(callSites(bad).filter((c) => !usesChildEnv(bad, c))).toHaveLength(1);
    }
  });

  it('yt-dlp, ffmpeg and any JS runtime child env equals its allowlist', async () => {
    const PLANTED = ['BOT_TOKEN_PRAW', 'GEMINI_API_KEY', 'CLICKUP_API_TOKEN', 'JIRA_API_TOKEN', 'GITHUB_APP_PRIVATE_KEY', 'GOOGLE_SHEETS_WEBAPP_SECRET', 'DATABASE_URL', 'CONFIG_MASTER_KEY', 'NODE_OPTIONS', 'YTDLP_COOKIES_FILE'];
    for (const k of PLANTED) vi.stubEnv(k, `planted-${k}`);
    const keys = (out: string) => out.split('\n').filter((l) => /^[A-Z_][A-Z0-9_]*=/.test(l)).map((l) => l.slice(0, l.indexOf('='))).filter((k) => !['PWD', 'SHLVL', '_', 'OLDPWD'].includes(k)).sort(); // set by sh itself
    const dump = async (bin: string) => {
      const c = spawnSafe(bin, ['--dump-env'], { timeoutMs: 5000, stdoutCap: 65_536 });
      let out = '';
      c.stdout.on('data', (b: Buffer) => (out += b.toString()));
      await c.done;
      return out;
    };
    try {
      const base = ['HOME', 'LANG', 'PATH', 'TMPDIR'].filter((k) => k === 'HOME' || process.env[k] !== undefined);
      expect(keys(await dump(FAKE_YTDLP))).toEqual(base);
      expect(keys(await dump(FAKE_FFMPEG))).toEqual(base);
      // the JS runtime is yt-dlp's child (EJS solver, Popen without env=): it inherits exactly yt-dlp's childEnv
      const out = join(scratch(), 'js-env');
      const t = startTrack('song', fakeTrackOptions({ extraEnv: { FAKE_JS_ENV_OUT: out } }));
      t.pcm.resume();
      await t.done;
      const js = readFileSync(out, 'utf8');
      expect(keys(js)).toEqual([...base, 'FAKE_JS_ENV_OUT'].sort());
      for (const k of PLANTED) expect(js).not.toContain(`planted-${k}`);
      expect(js).toMatch(/HOME=.*lw-child-/);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
