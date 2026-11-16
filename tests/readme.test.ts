import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const readme = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'README.md'), 'utf8');
const section = (title: string): string => {
  const i = readme.indexOf(`\n## ${title}`);
  if (i < 0) return '';
  const rest = readme.slice(i + 1);
  const next = rest.slice(3).search(/\n## /);
  return next < 0 ? rest : rest.slice(0, next + 3);
};

describe('README: LW Admin executor owner steps (Gate 1 S4)', () => {
  it('the permission integer to invite with equals the executor allowlist bits in code (they cannot drift)', async () => {
    const { ADMIN_EXTRA_BITS, orBits } = await import('../discord/perm/perm-bits.js');
    const m = /exactly this permission integer, `(\d+)`/.exec(readme);
    expect(m, 'the README names the permission integer').not.toBeNull();
    expect(BigInt(m![1]!)).toBe(orBits(ADMIN_EXTRA_BITS));
    const steps = section('Admin console and Discord permission ops (Praw in `#⚙️-setting`)');
    for (const s of ['Server Members Intent only', 'Public Bot off', 'env.admin', 'set-tokens.sh --local ADMIN', 'below Founder, Bot Admin', 'Manage Roles and Manage Channels from the Praw integration role', '📦 Archive']) expect(steps, s).toContain(s);
  });
});

describe('README', () => {
  it('Gemini data terms (P12)', () => {
    const praw = section('Praw (น้องพราว)');
    expect(praw).toMatch(/billing-enabled|paid/i);
    expect(praw).toMatch(/product-improvement|improve/i);
    expect(praw).toMatch(/owner confirms/i);
    for (const w of ['images', 'receipts', 'voice audio', 'retention']) expect(praw.toLowerCase()).toContain(w);
  });

  it('Praw runbook covers setup, pricing, portal steps and Manage Messages (P17)', () => {
    const praw = section('Praw (น้องพราว)');
    for (const s of ['BOT_TOKEN_PRAW', 'GEMINI_API_KEY', '/channel map', 'praw work:true', 'gemini-3.8-flash', '2026-10-31', '0.75', '3.75', '0.075', '1.50', '7.50', '0.15', '2027-01-01',
      'Install Link', 'Public Bot', 'Message Content', 'Manage Messages', 'Pin Messages', 'per-channel', 'old bot', 'Administrator', 'Private']) {
      expect(praw, s).toContain(s);
    }
    expect(praw).toMatch(/no-price|pricing/);
  });

  it('rotation section lists the new keys (D22, P24)', () => {
    const rot = readme.slice(readme.indexOf('### Rotation'));
    expect(rot).toContain('GEMINI_API_KEY');
  });

  describe('Cutover M2 runbook (P23, PF17)', () => {
    const cut = section('Cutover M2');
    it('lists the owner steps in order with the exact old-bot env flags', () => {
      expect(cut).not.toBe('');
      const at = (s: string) => cut.toLowerCase().indexOf(s.toLowerCase());
      const order = ['chore/cogs-disabled', 'Assistant M2', 'PLUGINS_DISABLED=reminders,lessons,web_search,workspace,pin', 'COGS_DISABLED=reminders,scheduled_tasks,watch,lessons', 'live check', 'import-discord-bot', 'smoke'];
      for (const s of order) expect(at(s), s).toBeGreaterThanOrEqual(0);
      expect(order.map(at)).toEqual([...order.map(at)].sort((a, b) => a - b));
      expect(cut).toMatch(/not proof|not enough|env flag alone/i);
      expect(cut).toMatch(/new (ClickUp|credentials)/i);
    });
    it('warns about past-due imports and the dry-run', () => {
      expect(cut).toMatch(/past[- ]due/i);
      expect(cut).toMatch(/fire[s]? immediately/i);
      expect(cut).toContain('--apply');
    });
    it('VPS compose step names the parent-repo file, env, volume and block', () => {
      for (const s of ['infra/vps/files/lw-git/apps/apps-assistant/docker-compose.yml', 'PRAW_WORKSPACE_DIR', 'praw-workspace', 'volumes:', 'read-only']) expect(cut, s).toContain(s);
    });
    it('rollback SQL uses the real columns (PF17)', () => {
      expect(cut).toContain('UPDATE reminders SET cancelled = true');
      expect(cut).toContain('UPDATE scheduled_jobs SET active = false');
      expect(cut).toContain('UPDATE watches SET enabled = false');
      expect(cut).not.toMatch(/UPDATE (reminders|watches) SET active = false/);
    });
    it('rollback order: Praw off first, old bot on last; old rows marked via legacy_id (I1, I2)', () => {
      const roll = cut.slice(cut.indexOf('### Rollback'));
      const at = (s: string) => roll.indexOf(s);
      const order = ['docker stop', 'SELECT string_agg(legacy_id::text', 'UPDATE reminders SET cancelled = true', 'UPDATE reminders SET fired = 1', 'remove `PLUGINS_DISABLED`'];
      for (const s of order) expect(at(s), s).toBeGreaterThanOrEqual(0);
      expect(order.map(at)).toEqual([...order.map(at)].sort((a, b) => a - b));
      expect(roll).toContain('UPDATE scheduled_tasks SET active = 0');
      expect(roll).toContain('UPDATE watches SET active = 0');
      expect(roll).toContain('legacy_id');
    });
    it('import notes: lessons always inactive, only DATABASE_URL passed, cancel SQL narrowed by legacy_id', () => {
      expect(cut).toMatch(/Every imported lesson is inactive/);
      expect(cut).toContain('`fired != 0`');
      expect(cut).toContain('/lesson enable');
      expect(cut).toContain('-e DATABASE_URL');
      expect(cut).not.toContain('--env-file');
      expect(cut).toContain('AND legacy_id IS NOT NULL AND remind_at < now()');
    });
    it('states the M2 rotation inventory is complete', () => {
      expect(cut).toMatch(/no new (secret|key)/i);
      expect(readme.slice(readme.indexOf('### Rotation'))).toContain('PRAW_WORKSPACE_DIR');
    });
  });

  describe('Cutover M4 runbook (P17, P23)', () => {
    const cut = section('Cutover M4');
    it('lists the owner steps in order, old OCR off with a live check, Attach Files per channel, new Sheets secret', () => {
      expect(cut).not.toBe('');
      const order = ['1. **Deploy**', '2. **Attach Files', '3. **Sheets', '4. **Auto-OCR', '5. **Limits', '6. **Switch the old OCR off', '7. **Acceptance (AC11)'];
      for (const s of ['/autoocr channel', 'limits.visionPerUserDay', 'COGS_DISABLED', 'Live check']) expect(cut, s).toContain(s);
      const at = (s: string) => cut.indexOf(s);
      for (const s of order) expect(at(s), s).toBeGreaterThanOrEqual(0);
      expect(order.map(at)).toEqual([...order.map(at)].sort((a, b) => a - b));
      expect(cut).toMatch(/not proof/i);
      expect(cut).toMatch(/never guild-wide/i);
      expect(cut).toMatch(/new\*\* (Apps Script|secret)|\*\*new\*\*/i);
      expect(cut).toContain('Rollback (M4)');
    });
  });

  it('Media binaries: pins, signature check and bump procedure (P22)', () => {
    const m = section('Media binaries (P22)');
    for (const w of ['2026.10.26', '9.0.2', 'FCF986EA15E6E293A5644F10B4322F04D67658D8', 'voice/ffmpeg-release-key.asc', '--disable-everything', 'ffmpeg.org', 'CVE-2026-107696', 'SHA2-256SUMS', 'AC0CBBE6848D6A873464AF4E57CF65933B5A7581', 'voice/binaries.ts', 'deploy/Dockerfile', 'Bump procedure', 'never run with `-U`', 'DAVE', 'GuildVoiceStates']) {
      expect(m, w).toContain(w);
    }
  });

  it('Voice chat: audio goes to Google, reply text to Microsoft (Edge TTS), opt-in, memory only (P12, P20, AC13)', () => {
    const v = section('Operations');
    const chat = v.slice(v.indexOf('### Voice chat'));
    expect(chat.length).toBeGreaterThan(100);
    for (const w of ['Google', 'Microsoft', 'Edge', 'opt in', '/voice join', '/voice leave', 'voice.idleMin', 'voice.maxSessionMin', 'limits.voiceMinPerUserDay', 'msedge-tts', 'DAVE', 'nothing is written to disk']) expect(chat, w).toContain(w);
  });

  describe('Task 38: M5 hardening notes and retirement runbook', () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), '..');
    const parent = join(root, '..');

    it('.npmrc pins ignore-scripts=true and the README/Dockerfile text matches (P22)', () => {
      expect(readFileSync(join(root, '.npmrc'), 'utf8')).toMatch(/^ignore-scripts=true$/m);
      const dev = section('Local development');
      expect(dev).toContain('npm ci');
      expect(dev).toContain('ignore-scripts');
      expect(dev).toContain('msedge-tts');
      expect(section('Deploy with lw-git')).toContain('npm ci --omit=dev --ignore-scripts');
      expect(readFileSync(join(root, 'deploy', 'Dockerfile'), 'utf8')).toContain('npm ci --omit=dev --ignore-scripts');
    });

    it('deploy compose has init: true; README says the parent overlay needs it and the praw-workspace volume', () => {
      expect(readFileSync(join(root, 'deploy', 'docker-compose.yml'), 'utf8')).toMatch(/^\s+init: true$/m);
      const d = section('Deploy with lw-git');
      expect(d).toContain('init: true');
      expect(d).toContain('infra/vps/files/lw-git/apps/apps-assistant/docker-compose.yml');
      expect(d).toContain('praw-workspace');
      expect(d).toMatch(/zombie/i);
    });

    it('rollout note: a stored media.ytHostAllowlist must add m.youtube.com by hand', () => {
      const m = section('Voice and music');
      expect(m).toContain('media.ytHostAllowlist');
      expect(m).toContain('m.youtube.com');
      expect(m).toContain('/media allowlist');
      expect(readme).toContain('/media allowlist action:add host:m.youtube.com');
      expect(readme).not.toMatch(/(UPDATE|INSERT INTO|DELETE FROM)\s+config[^\n]*ytHostAllowlist|config. table row/i); // no raw SQL for this setting
      expect(m).toMatch(/stored/i);
    });

    it('Voice and music: AC12/AC13 live, DAVE readiness, YouTube/cookies, Edge TTS text fallback, opt-in, idle', () => {
      const m = section('Voice and music');
      expect(m).not.toBe('');
      for (const w of ['AC12', 'AC13', 'DAVE', 'alone', 'cookies', 'YTDLP_COOKIES_FILE', 'Edge TTS', 'text', 'opt-in', 'voice.idleMin', 'music is playing', 'Live check']) expect(m, w).toContain(w);
    });

    it('Retiring Discord_bot: ordered cutover, P23 revocations, Gate 2 SBOM scan', () => {
      const r = section('Retiring Discord_bot');
      expect(r).not.toBe('');
      const order = ['1. **Deploy', '2. **Verify AC12', '3. **Stop the Python bot', '4. **Remove the old Discord application', '5. **Archive', '6. **Reset the old bot', '7. **Revoke', '8. **Gate 2'];
      const at = (x: string) => r.indexOf(x);
      for (const x of order) expect(at(x), x).toBeGreaterThanOrEqual(0);
      expect(order.map(at)).toEqual([...order.map(at)].sort((a, b) => a - b));
      for (const w of ['token', 'GitHub App installation', 'Gemini', 'ClickUp', 'Sheets', 'rotate', 'P23', 'P22', '/opt/yt-dlp/_internal', 'libav', 'npm audit --omit=dev', 'positive control', 'HIGH', 'CRITICAL', 'infra/OPERATIONS.md']) expect(r, w).toContain(w);
    });

    it.skipIf(!existsSync(join(parent, 'docs', 'superpowers', 'specs')))('parent-repo docs: local-mode §6 superseded, Core §17 sub-project 3 note, local-mode plan cross-ref', () => {
      const read = (f: string) => readFileSync(join(parent, 'docs', f), 'utf8');
      const spec6 = read('superpowers/specs/2026-10-31-assistant-local-mode-design.md');
      expect(spec6.slice(spec6.indexOf('## 6.'), spec6.indexOf('## 7.'))).toMatch(/superseded.*2026-10-31-praw-migration-design/is);
      const core = read('superpowers/specs/2026-10-31-discord-ai-company-core-design.md');
      expect(core.slice(core.indexOf('## 17.'))).toMatch(/sub-project 3.*praw-migration/is);
      expect(read('plans/2026-10-31-assistant-local-mode-plan.md')).toContain('2026-10-31-praw-migration-plan.md');
    });
  });
});
