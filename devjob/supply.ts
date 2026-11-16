/**
 * Supply-chain checks (Gate 1 self-code X14). The lockfile and manifest comparison is pure and offline; package age and the advisory databases
 * come in through a port, and an unavailable answer refuses (fail closed). `npm audit` and OSV do not detect fresh malicious packages: the
 * card says so.
 */
export const MIN_AGE_DAYS = 7;
export const MAX_NEW_DIRECT = 3;

interface LockPkg { version?: string; resolved?: string; integrity?: string; link?: boolean; hasInstallScript?: boolean; dev?: boolean }
interface Lock { packages?: Record<string, LockPkg> }
type Manifest = Record<string, unknown> & { dependencies?: Record<string, string>; devDependencies?: Record<string, string>; optionalDependencies?: Record<string, string>; scripts?: unknown };

export interface NewPackage { name: string; version: string; hasInstallScript: boolean; publishedAt: string | null }
export interface SupplyPort {
  /** Publish time of one exact version (ISO), or null when unknown. */
  publishedAt(name: string, version: string): Promise<string | null>;
  /** The registry's own `dist.integrity` of one exact version, or null when unknown (G2SC-11). */
  integrity(name: string, version: string): Promise<string | null>;
  /** Advisories of the NEW production packages at HIGH or CRITICAL severity, with the database date. Throws when a database is unavailable. */
  audit(pkgs: { name: string; version: string }[]): Promise<{ high: number; critical: number; databaseDate: string; note?: string }>;
}
export interface SupplyResult { refusals: string[]; newPackages: NewPackage[]; auditNote: string }

const REGISTRY = 'https://registry.npmjs.org/';
const nameOf = (key: string): string => key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length);
const depsOf = (m: Manifest): Record<string, string> => ({ ...(m.dependencies ?? {}), ...(m.devDependencies ?? {}), ...(m.optionalDependencies ?? {}) });
const stable = (v: unknown): string => JSON.stringify(v, (_k, x: unknown) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : 1))) : x));
/** A registry semver range or exact version only: a git, http, file, link, alias or tarball spec contains `:` or `/`. */
const plainSpec = (s: string): boolean => /^[\w.^~<>=|* -]+$/.test(s) && !/^(?:git|http|file|link|npm|github)/i.test(s);

export async function checkSupply(i: { baseManifest: Manifest; headManifest: Manifest; baseLock: unknown; headLock: unknown }, port: SupplyPort, now: () => number = Date.now): Promise<SupplyResult> {
  const refusals: string[] = [];
  const newPackages: NewPackage[] = [];
  const base = ((i.baseLock as Lock).packages ?? {}) as Record<string, LockPkg>;
  const head = ((i.headLock as Lock).packages ?? {}) as Record<string, LockPkg>;
  const manifestSame = stable({ ...i.baseManifest, scripts: undefined }) === stable({ ...i.headManifest, scripts: undefined });
  const lockSame = stable(base) === stable(head);
  if (stable(i.baseManifest.scripts ?? null) !== stable(i.headManifest.scripts ?? null)) refusals.push('the scripts block of package.json changed (non-self-modifiable)');
  if (lockSame && manifestSame) return { refusals, newPackages, auditNote: 'dependencies unchanged' };
  if (!lockSame && manifestSame) refusals.push('the lockfile changed without a manifest change');
  if (Object.keys(head).length === 0) refusals.push('the lockfile has no packages');
  const bd = depsOf(i.baseManifest);
  const hd = depsOf(i.headManifest);
  for (const [n, spec] of Object.entries(hd)) if (typeof spec !== 'string' || !plainSpec(spec)) refusals.push(`dependency ${n} uses a non-registry spec`);
  const addedDirect = Object.keys(hd).filter((n) => !(n in bd));
  if (addedDirect.length > MAX_NEW_DIRECT) refusals.push(`${addedDirect.length} new direct dependencies (limit ${MAX_NEW_DIRECT})`);
  const seen = new Map<string, LockPkg>();
  for (const [k, p] of Object.entries(base)) if (k !== '' && p.version) seen.set(`${nameOf(k)}@${p.version}`, p);
  for (const [k, p] of Object.entries(head)) {
    if (k === '') continue;
    const name = nameOf(k);
    if (p.link) { refusals.push(`${name}: a link entry`); continue; }
    if (typeof p.resolved !== 'string' || !p.resolved.startsWith(REGISTRY)) refusals.push(`${name}: resolved is not ${REGISTRY}...`);
    // G2SC-11: the tarball URL must be the one the registry derives from name@version, so a new entry cannot carry the bytes of another package.
    else if (p.version && p.resolved !== `${REGISTRY}${name}/-/${name.slice(name.lastIndexOf('/') + 1)}-${p.version}.tgz`) refusals.push(`${name}@${p.version}: resolved is not the tarball of that name and version`);
    if (typeof p.integrity !== 'string' || !p.integrity.startsWith('sha512-')) refusals.push(`${name}: no sha512 integrity`);
    if (!p.version) continue;
    const id = `${name}@${p.version}`;
    const was = seen.get(id);
    if (was) {
      if (was.integrity !== p.integrity) refusals.push(`${id}: the integrity of an unchanged version changed`);
    } else if (!newPackages.some((x) => x.name === name && x.version === p.version)) {
      newPackages.push({ name, version: p.version, hasInstallScript: p.hasInstallScript === true, publishedAt: null });
    }
  }
  for (const n of newPackages) {
    const at = await port.publishedAt(n.name, n.version).catch(() => null);
    n.publishedAt = at;
    const entry = Object.entries(head).find(([k, v]) => k !== '' && nameOf(k) === n.name && v.version === n.version)?.[1];
    const reg = await port.integrity(n.name, n.version).catch(() => null);
    if (!reg || !entry || entry.integrity !== reg) refusals.push(`${n.name}@${n.version}: the lockfile integrity is not the registry's integrity for that version`);
    const t = at ? Date.parse(at) : NaN;
    if (!Number.isFinite(t)) refusals.push(`${n.name}@${n.version}: publish date unknown (refused)`);
    else if (now() - t < MIN_AGE_DAYS * 86_400_000) refusals.push(`${n.name}@${n.version}: published less than ${MIN_AGE_DAYS} days ago`);
  }
  let auditNote = 'npm audit and OSV do not detect malicious packages';
  if (newPackages.length > 0 || !lockSame) {
    try {
      const prod = newPackages.filter((n) => head[Object.keys(head).find((k) => k !== '' && nameOf(k) === n.name && head[k]!.version === n.version) ?? '']?.dev !== true);
      const a = await port.audit(prod.map((n) => ({ name: n.name, version: n.version })));
      if (a.high + a.critical > 0) refusals.push(`advisories: ${a.critical} critical, ${a.high} high (database ${a.databaseDate})`);
      auditNote = `audit database ${a.databaseDate}: ${a.critical} critical, ${a.high} high${a.note ? ` (${a.note})` : ''}; ${auditNote}`;
    } catch {
      refusals.push('the advisory databases could not be reached (refused)');
    }
  }
  return { refusals, newPackages, auditNote };
}
