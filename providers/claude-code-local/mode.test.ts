import { describe, expect, it } from 'vitest';
import { localFlagOk, localModeOf, type GuardEnv, type GuardFs } from './guard.js';

// R8 PV-C01: local mode is the guard passing, or ALLOW_LOCAL_PROVIDERS=1 in the real process env AND not in a container. A container with the flag
// set by mistake must stay the VPS path: it never seeds a local default and never idles on one.
describe('localModeOf', () => {
  const base = { override: undefined, guardOk: false, flagOk: false, inContainer: false };
  it('is off with nothing set (the VPS)', () => expect(localModeOf(base)).toBe(false));
  it('is on when the guard passed', () => expect(localModeOf({ ...base, guardOk: true })).toBe(true));
  it('is on for the flag outside a container, also when the guard failed at this boot', () => expect(localModeOf({ ...base, flagOk: true })).toBe(true));
  it('is off for the flag inside a container', () => expect(localModeOf({ ...base, flagOk: true, inContainer: true })).toBe(false));
  // LOCAL-OFF-1: the owner switch refuses only the provider; the flag provenance (and so local mode) is untouched.
  it('stays on when the owner turned the local provider off (guardOk false, flag ok)', () => expect(localModeOf({ ...base, guardOk: false, flagOk: true })).toBe(true));
  it('a test override wins both ways', () => {
    expect(localModeOf({ ...base, override: true, inContainer: true })).toBe(true);
    expect(localModeOf({ ...base, override: false, guardOk: true, flagOk: true })).toBe(false);
  });
});

// G2-PV-05: the flag counts only with the guard's own provenance rules (process env only, darwin).
describe('localFlagOk', () => {
  const env = (o: Partial<GuardEnv> = {}): GuardEnv => ({ vars: { ALLOW_LOCAL_PROVIDERS: '1' }, platform: 'darwin', execArgv: [], home: '/h', ...o });
  const fs = (files: Record<string, string> = {}, boom = false): Pick<GuardFs, 'readFile'> => ({ readFile: (p) => { if (boom) throw new Error('x'); return files[p] ?? null; } });
  it('is on for the exact flag on darwin with no env file defining it', () => expect(localFlagOk(env(), fs())).toBe(true));
  it('the owner OFF switch does not change flag provenance: localFlagOk stays true', () => expect(localFlagOk(env({ vars: { ALLOW_LOCAL_PROVIDERS: '1', ASSISTANT_LOCAL_PROVIDER_OFF: '1' } }), fs())).toBe(true));
  it('only the exact value 1 counts', () => { for (const f of ['0', 'true', '', ' 1', undefined]) expect(localFlagOk(env({ vars: { ALLOW_LOCAL_PROVIDERS: f } }), fs())).toBe(false); });
  it('is off off-darwin', () => expect(localFlagOk(env({ platform: 'linux' }), fs())).toBe(false));
  it('is off when an env file defines the flag', () => {
    const e = env({ execArgv: ['--env-file=/e/x.env'] });
    expect(localFlagOk(e, fs({ '/e/x.env': 'FOO=1\nALLOW_LOCAL_PROVIDERS=1\n' }))).toBe(false);
    expect(localFlagOk(e, fs({ '/e/x.env': 'FOO=1\n' }))).toBe(true);
  });
  it('is off when an env file cannot be read', () => expect(localFlagOk(env({ execArgv: ['--env-file=/e/x.env'] }), fs({}, true))).toBe(false));
});
