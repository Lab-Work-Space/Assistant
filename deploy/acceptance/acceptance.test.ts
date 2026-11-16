/**
 * deploy/acceptance (plan Task 8): the local two-container acceptance kit is not run by vitest (it needs Docker); these tests keep
 * it well-formed and keep its safety rules: bash 3.2 syntax, the layers it puts on top of the real lw render, no prune/rmi, a
 * project-scoped teardown, and the docs/operations/media-sidecar-live-checks.md runbook it points to.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { ENV_ALLOW } from '../../media/main.js';

const DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = join(DIR, '..', '..');
const read = (f: string): string => readFileSync(join(DIR, f), 'utf8');
const SCRIPTS = ['run.sh', 'check.sh', 'scan.sh'];
const PROBES = ['health.cjs', 'decode.cjs', 'track.cjs', 'tcp.cjs', 'https.cjs', 'select.cjs'];

describe('deploy/acceptance scripts', () => {
  it.each(SCRIPTS)('%s parses with bash -n (macOS ships bash 3.2)', (f) => {
    const r = spawnSync('bash', ['-n', join(DIR, f)], { encoding: 'utf8' });
    expect(r.status, r.stderr).toBe(0);
  });

  it.each(SCRIPTS)('%s uses no bash 4+ features (associative arrays, mapfile, ${x,,}, ${x^^})', (f) => {
    const s = read(f);
    expect(s).not.toMatch(/declare -A|mapfile|readarray|\$\{[A-Za-z_]+(,,|\^\^)\}|\bcoproc\b|EPOCHREALTIME/);
  });

  it.each(SCRIPTS)('%s has no case statement inside $( ) (bash 3.2 fails on it at run time, bash -n does not see it)', (f) => {
    for (const line of read(f).split('\n')) {
      if (/sh -c '/.test(line)) continue; // the in-container busybox sh scripts are single-quoted, bash does not parse them
      expect(line).not.toMatch(/\$\((?:for|while|if)\b[^\n]*\bcase\b/);
    }
  });

  it.each(SCRIPTS)('%s never prunes, never removes images by id, never deletes outside its run', (f) => {
    const s = read(f);
    expect(s).not.toMatch(/\bprune\b/);
    expect(s).not.toMatch(/docker rmi\b/);
    expect(s).not.toMatch(/docker (system|builder|volume|network|container|image) prune/);
    expect(s).not.toMatch(/ssh |72\.60\.196\.53|env\.local/);
  });

  it('run.sh removes only resources labelled with its own project / run id, and only the run tag of the image', () => {
    const s = read('run.sh');
    expect(s).toMatch(/PROJECT=t8acc-\$RID/);
    expect(s).toMatch(/case \$PROJECT in t8acc-\[a-z0-9\]\*\)/);
    for (const m of s.matchAll(/docker (?:network|volume) rm [^\n]*|docker rm -f [^\n]*/g)) expect(m[0]).toMatch(/\$ids/);
    for (const m of s.matchAll(/ids=\$\(docker [^\n]*\)/g)) expect(m[0]).toMatch(/label=(com\.docker\.compose\.project=\$PROJECT|t8acc=\$RID)/);
    expect(s).toMatch(/docker image rm "\$RUNTAG"/);
    expect(s).toMatch(/trap cleanup EXIT/);
  });

  it('run.sh builds with the legacy builder by default, as lw-git does', () => {
    expect(read('run.sh')).toMatch(/DOCKER_BUILDKIT=0 docker build -f deploy\/Dockerfile/);
  });

  it('run.sh renders through the real lw pieces: descriptor, raw, user, lw_override.jq, compose', () => {
    const s = read('run.sh');
    for (const p of ['lw_check.py" descriptor', 'lwck raw', '--no-env-resolution', 'lwck user', 'lw_override.jq', 'lwck compose']) expect(s).toContain(p);
    expect(s).toMatch(/"\$PY" -I/); // python -I, as lw runs it
    expect(s).toMatch(/T7 layer leaves media unchanged/);
  });

  it('check.sh ENV_ALLOW equals media/main.ts ENV_ALLOW', () => {
    const m = read('check.sh').match(/^ENV_ALLOW="([^"]+)"/m);
    expect(m?.[1]?.split(' ')).toEqual([...ENV_ALLOW]);
  });

  it('check.sh probes exist and are CommonJS one-file scripts', () => {
    const s = read('check.sh');
    for (const p of PROBES) {
      expect(s).toContain(p);
      const src = read(join('probes', p));
      expect(src).not.toMatch(/^import /m);
    }
  });

  it('check.sh covers AC1, AC2, AC4, S1, S5, S8, S9, S12, S13 with positive controls', () => {
    const s = read('check.sh');
    for (const id of ['AC1 positive control', 'AC1 no ZZ_MARKER', 'AC1 docker inspect media env allowlisted', 'AC1 ls /proc in media',
      'AC2 unpatched media exits 78', 'AC2 the log names ZZ_MARKER', 'AC2 patched lw_check compose refuses',
      'AC4/S1 uid-1000 connect over the ro mount', 'S1 socket is srw-rw-rw-', 'S5 media is only on', 'S8 FAKE_YTDLP_HANG=1 -> media exits 78',
      'S8 test ! -e /app/tests', 'S9 mp3 decodes', 'S9 WAV refused', 'S12 ps in assistant during the track', 'S12 control',
      'S13 control: assistant listens', 'S13 media -> assistant', 'S13 outbound HTTPS from media works']) {
      expect(s, id).toContain(id);
    }
  });
});

describe('scan.sh grype verdict (AC3, Gate 1 S10/S14)', () => {
  const hasJq = spawnSync('jq', ['--version']).status === 0;
  const verdict = (f: string) => spawnSync('bash', [join(DIR, 'scan.sh'), '--check-grype', join(DIR, 'fixtures', f)], { encoding: 'utf8' });
  it.skipIf(!hasJq).each([
    ['grype-ok.json', 0], // only the accepted residuals at Medium+, plus a Low
    ['grype-ffmpeg.json', 0], // ffmpeg 9.x with only the owner-accepted CVE-2026-107696 (High)
    ['grype-high.json', 1], // any other High/Critical
    ['grype-unlisted.json', 1], // a Medium CVE outside the residual allowlist
    ['grype-ffmpeg8.json', 1], // an ffmpeg 8.x row
    ['grype-glib.json', 1], // a glib row at any severity
  ])('%s -> exit %i', (f, code) => {
    const r = verdict(f as string);
    expect(r.status, r.stdout + r.stderr).toBe(code);
    if (code) expect(r.stdout).toMatch(/^FAIL AC3 /m);
  });

  it('the residual allowlist is exactly the four owner lines', () => {
    expect(read('scan.sh')).toContain(`RESIDUALS='["CVE-2026-107696","CVE-2025-60876","CVE-2025-15367","CVE-2026-103995"]'`);
  });
});

describe('deploy/acceptance compose layers', () => {
  it('t7 layer changes assistant only: a stub listener on 0.0.0.0:8080, no env, no secrets', () => {
    const d = parse(read('docker-compose.t7.yml')) as any;
    expect(Object.keys(d.services)).toEqual(['assistant']);
    expect(Object.keys(d.services.assistant)).toEqual(['entrypoint']);
    expect(d.services.assistant.entrypoint.join(' ')).toMatch(/listen\(8080,'0\.0\.0\.0'\)/);
  });

  it('unpatched layer: media restart "no" and an absolute ${T7_ENV} env_file (preflight C12)', () => {
    const t = read('docker-compose.t7-unpatched.yml');
    const d = parse(t) as any;
    expect(Object.keys(d.services)).toEqual(['media']);
    expect(d.services.media.restart).toBe('no');
    expect(d.services.media.env_file[0].path).toMatch(/^\$\{T7_ENV:\?/);
    expect(t).not.toMatch(/-v media-ipc/);
  });
});

describe('D5 fixture: a real `docker compose config --format json --no-env-resolution` render (Compose v5.6.1, 2026-11-01)', () => {
  // Captured by run.sh (project name, image tag and port normalised); it holds no env values. It answers the infra tests
  // marked "shape: verify on first VPS p4 run": environment renders as a map, networks as a map with null values (the
  // implicit default spelled out), mem_limit as a byte string.
  const fx = JSON.parse(read(join('fixtures', 'compose-user-render.json'))) as any;

  it('environment is a map; networks is a map with null values, default spelled out; mem_limit is a byte string', () => {
    expect(fx.services.media.environment).toEqual({ MEDIA_SOCKET: '/run/media-ipc/media.sock', NODE_ENV: 'production' });
    expect(fx.services.media.networks).toEqual({ 'media-egress': null });
    expect(fx.services.assistant.networks).toEqual({ default: null });
    expect(fx.services.media.mem_limit).toBe('402653184');
    expect(fx.services.assistant.mem_limit).toBe('536870912');
    expect(fx.services.media.labels).toEqual({ 'lw.isolated': 'true' });
    expect(fx.services.media.env_file).toBeUndefined();
  });

  it('every media environment key is in ENV_ALLOW', () => {
    for (const k of Object.keys(fx.services.media.environment)) expect(ENV_ALLOW).toContain(k);
  });
});

describe('Media sidecar runbook (docs)', () => {
  const readme = readFileSync(join(ROOT, 'docs', 'operations', 'media-sidecar-live-checks.md'), 'utf8');
  const i = readme.indexOf('\n## Media sidecar — deploy and live checks');
  const rest = i < 0 ? '' : readme.slice(i + 1);
  const next = rest.slice(3).search(/\n## /);
  const sec = next < 0 ? rest : rest.slice(0, next + 3);

  it('has the "Media sidecar — deploy and live checks" section', () => {
    expect(i).toBeGreaterThan(0);
  });

  it('covers deploy order, the env-key clash check, p4, AC6, host-port S13 checks and the S14 owner lines', () => {
    for (const s of ['40-platform.sh', 'lw_override.jq', 'lw_check.py', 'bash infra/vps/13-firewall.sh`', 'FRESH ssh login', 'bash infra/vps/13-firewall.sh --confirm', '120 s', 'infra/OPERATIONS.md', 'resolvectl status', 'CVE-2025-60876', 'CVE-2025-15367', 'CVE-2026-103995', 'lw env keys apps/assistant', 'NODE_ENV',
      'MEDIA_SOCKET', 'p4-platform-check.sh', '/halt', 'ps -o pid,pgid,comm', 'DAVE', 'TTS', '172.30.0.1', '4231', 'CVE-2026-107696',
      'YTDLP_COOKIES_FILE', 'deploy/acceptance/run.sh',
      // final review I-1 / handoff 2-3, M-3, M-8: the real trigger, the interlock, the full order, the rollback target
      'merge of `feat/praw` into Assistant `main`', 'lw-git-sync.timer', 'S13 deploy interlock', 'lw-fw-rollback.timer', 'media-egress.env',
      'lw_s13.py', 'bash infra/vps/41-git.sh', 'docker image ls lw-local/apps-assistant', 'ffmpeg 8.1.3', 'M-3', 'media-ipc', 'M-8']) {
      expect(sec, s).toContain(s);
    }
    expect(sec).not.toContain('deploy `feat/praw` through lw-git'); // lw-git builds only main: the merge is the trigger
  });
});
