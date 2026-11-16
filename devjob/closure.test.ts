import { describe, expect, it } from 'vitest';
import { closureChange, computeClosure, lockEntries } from './closure.js';

const tree = (o: Record<string, string>) => (p: string) => o[p] ?? null;
const T = {
  'executor/main.ts': "import { a } from '../core/a.js';\nimport pg from 'pg';\nimport { x } from 'node:fs';\nexport * from './b.js';",
  'core/a.ts': "import type { T } from './t.js';\nconst l = await import('./lazy.js');\nexport const a = 1;",
  'core/t.ts': 'export type T = 1;',
  'core/lazy.ts': "import z from '@scope/pkg/sub';",
  'executor/b.ts': "import { c } from './dir/index.js';",
  'executor/dir/index.ts': 'export const c = 1;',
};

describe('X9 closure', () => {
  it('follows relative, index, type-only, literal dynamic and re-export imports, and collects packages', () => {
    const c = computeClosure(['executor/main.ts'], tree(T));
    expect([...c.files].sort()).toEqual(['core/a.ts', 'core/lazy.ts', 'core/t.ts', 'executor/b.ts', 'executor/dir/index.ts', 'executor/main.ts']);
    expect([...c.packages].sort()).toEqual(['@scope/pkg', 'pg']);
    expect(c.refusals).toEqual([]);
  });
  it('refuses a non-literal import() or require(), and an unresolvable import', () => {
    expect(computeClosure(['a.ts'], tree({ 'a.ts': 'const m = await import(name);' })).refusals.join()).toMatch(/non-literal/);
    expect(computeClosure(['a.ts'], tree({ 'a.ts': 'const m = require(`x${y}`);' })).refusals.join()).toMatch(/non-literal/);
    expect(computeClosure(['a.ts'], tree({ 'a.ts': "import './nope.js';" })).refusals.join()).toMatch(/does not resolve/);
  });
  const lock = (v: string) => ({ packages: { '': {}, 'node_modules/pg': { version: v, dependencies: { 'pg-types': '1' } }, 'node_modules/pg-types': { version: '1.0.0' }, 'node_modules/other': { version: '1' } } });
  it('a change in any closure file or closure dependency is flagged; unrelated changes are not', () => {
    const same = closureChange(['executor/main.ts'], { read: tree(T), lock: lock('8') }, { read: tree({ ...T, 'unrelated.ts': 'x' }), lock: lock('8') });
    expect(same.refusals).toEqual([]);
    const file = closureChange(['executor/main.ts'], { read: tree(T), lock: lock('8') }, { read: tree({ ...T, 'core/t.ts': 'export type T = 2;' }), lock: lock('8') });
    expect(file.refusals).toEqual(['closure: core/t.ts changed']);
    const dep = closureChange(['executor/main.ts'], { read: tree(T), lock: lock('8') }, { read: tree(T), lock: lock('9') });
    expect(dep.refusals.join()).toMatch(/dependency node_modules\/pg changed/);
    expect(lockEntries(lock('8'), ['pg']).has('node_modules/pg-types')).toBe(true);
  });
  it('a new import added to a closure file at head shows up through the changed file', () => {
    const head = { ...T, 'core/t.ts': "import './new.js';", 'core/new.ts': 'export {}' };
    const r = closureChange(['executor/main.ts'], { read: tree(T), lock: lock('8') }, { read: tree(head), lock: lock('8') });
    expect(r.refusals).toContain('closure: core/t.ts changed');
    expect(r.files).toContain('core/new.ts');
  });
});
