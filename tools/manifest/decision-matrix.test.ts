import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CATALOG_NAMES } from './catalog.js';
import { PROBE_NAMES, recordMatrix, serializeMatrix } from './decision-matrix.harness.js';
import { readGolden, updateRequested } from '../../tests/fakes/golden.js';

/**
 * PM-C2 (ii): the decision matrix recorded from the OLD code paths (BE1, before any consumer reads the catalog). BE2 kept every registered row byte-equal; only the
 * three unregistered probe rows (nonSensitive, routable, eligible) flipped to false, which is the intended fail-closed change. The test recomputes it from the consumers; it writes only under GOLDEN_UPDATE=1 (refused under CI), and then fails so a reviewer reads the diff.
 */
const file = new URL('../__golden__/decision-matrix.json', import.meta.url);

describe('decision matrix (observed from the pre-swap code paths)', () => {
  it('the committed file is byte-equal to what the consumers decide now, for every catalog name and the probe names', async () => {
    const observed = serializeMatrix(await recordMatrix([...CATALOG_NAMES, ...PROBE_NAMES]));
    if (updateRequested()) readGolden(file, observed); // writes the file and throws (refused under CI); the comparison below reads the protected file itself, never the helper's return value
    expect(observed).toBe(readFileSync(file, 'utf8'));
  });

  it('the file is canonical (keys sorted, 2-space indent, trailing newline) and covers exactly the catalog plus the three probes', () => {
    const text = readFileSync(file, 'utf8');
    const m = JSON.parse(text) as Record<string, Record<string, unknown>>;
    expect(text).toBe(JSON.stringify(m, null, 2) + '\n');
    expect(Object.keys(m)).toEqual([...CATALOG_NAMES, ...PROBE_NAMES].sort());
    for (const row of Object.values(m)) expect(Object.keys(row)).toEqual(Object.keys(row).sort());
  });

  it('room routing equals the sensitivity predicate for tool approvals, so the three probe rows flipped together in BE2 (nonSensitive, routable, eligible: an undeclared name is now fail-closed)', () => {
    const m = JSON.parse(readFileSync(file, 'utf8')) as Record<string, Record<string, unknown>>;
    for (const [n, row] of Object.entries(m)) {
      expect(row['routable'], n).toBe(row['nonSensitive']);
      expect(row['eligible'], n).toBe(row['nonSensitive']);
    }
    for (const n of PROBE_NAMES) expect(m[n]!['nonSensitive'], n).toBe(false); // BE2: was true through the prefix fail-open
  });

  it('the probe names are recorded as unregistered (no kind, no approvalFor, hard_deny:unknown for the reviewer, never skill-granted)', () => {
    const m = JSON.parse(readFileSync(file, 'utf8')) as Record<string, Record<string, unknown>>;
    for (const n of PROBE_NAMES) expect(m[n], n).toMatchObject({ kind: null, approvalFor: null, registeredReal: false, precheckReal: 'hard_deny:unknown', skillReal: false, treeGrant: false, alwaysCard: false, noApproval: false, ownWaive: false });
  });

  it('spot checks of the privileged set (observed): the tainted write that waits, the bot talk, the cost and the money rows', () => {
    const m = JSON.parse(readFileSync(file, 'utf8')) as Record<string, Record<string, unknown>>;
    expect(m['forward_to']).toMatchObject({ approvalFor: { directClean: 'free', directTainted: 'ask', delegatedClean: 'ask', delegatedTainted: 'ask' }, treeGrantCovers: true });
    expect(m['warroom_say']).toMatchObject({ botTalk: true });
    expect(m['video_generate']).toMatchObject({ precheckReal: 'hard_deny:cost_or_lasting' });
    expect(m['sheets_append_receipt']).toMatchObject({ precheckReal: 'hard_deny:money_doc' });
    expect(m['ws_run']).toMatchObject({ effectivePraw: false, effectiveSoftware: true, noApproval: true });
    expect(m['github_get_me']).toMatchObject({ nonSensitive: false, precheckReal: 'hard_deny:sensitive', skillReal: false });
    expect(m['discord_read']).toMatchObject({ nonSensitive: true });
  });
});
