import { describe, expect, it } from 'vitest';
import { parseClass, parseCommand, parseDepartments, parseEnv, parseImage, parseNumbers, parseRef, parseSlug, parseTitle } from './fields.js';

const IMG = `sha256:${'a'.repeat(64)}`;
describe('MC-C16 / spec 5.4: add-command fields', () => {
  it('slug and image', () => {
    expect(parseSlug('echo1')).toEqual({ ok: true, value: 'echo1' });
    for (const s of ['E', 'a', 'a_b', 'x'.repeat(17)]) expect(parseSlug(s), s).toEqual({ ok: false, code: 'E_SLUG' });
    expect(parseImage(IMG)).toEqual({ ok: true, value: IMG });
    for (const s of ['sha256:abc', `sha256:${'A'.repeat(64)}`, `${IMG}\n`, 'alpine:latest']) expect(parseImage(s), s).toEqual({ ok: false, code: 'E_IMAGE' });
  });
  it('class defaults to write; anything but read|write is E_CLASS', () => {
    expect(parseClass(undefined)).toEqual({ ok: true, value: 'write' });
    expect(parseClass('read')).toEqual({ ok: true, value: 'read' });
    for (const s of ['admin', 'READ', '']) expect(parseClass(s), s).toEqual({ ok: false, code: 'E_CLASS' });
  });
  it('command: a JSON array string, at most 1000 chars and 16 items, each from the safe set; a flag-shaped item is allowed (it lands after the image id)', () => {
    expect(parseCommand(undefined)).toEqual({ ok: true, value: [] });
    expect(parseCommand('["node","/app/server.js","--stdio"]')).toEqual({ ok: true, value: ['node', '/app/server.js', '--stdio'] });
    expect(parseCommand('["--privileged"]')).toEqual({ ok: true, value: ['--privileged'] });
    for (const s of ['node', '{}', '[1]', '["a b"]', '["a;b"]', '["$(x)"]', '["`x`"]', `["${'a'.repeat(201)}"]`, JSON.stringify(Array(17).fill('a')), JSON.stringify(['a'.repeat(150), 'b'.repeat(150), 'c'.repeat(150), 'd'.repeat(150), 'e'.repeat(150), 'f'.repeat(150), 'g'.repeat(150)]), '["a"', '[""]']) expect(parseCommand(s), s.slice(0, 40)).toEqual({ ok: false, code: 'E_COMMAND' });
  });
  it('env: K=V;K=V, at most 16 pairs, key and value rules, the deny lists, duplicates, and nothing the redactor would change', () => {
    expect(parseEnv(undefined, [])).toEqual({ ok: true, value: {} });
    expect(parseEnv('MODE=fast;LEVEL=3', [])).toEqual({ ok: true, value: { LEVEL: '3', MODE: 'fast' } });
    expect(parseEnv('URL=http://x.y/z?a=b', [])).toMatchObject({ ok: false }); // `?` is outside the value set
    const bad = ['PATH=x', 'HOME=/x', 'NODE_OPTIONS=--x', 'LD_PRELOAD=x', 'DYLD_X=1', 'DOCKER_HOST=x', 'HTTP_PROXY=x', 'MY_TOKEN=x', 'A_SECRET=x', 'DB_PASSWORD=x', 'MY_API_KEY=x', 'PRIVATE_X=x', 'CREDENTIAL_X=x', 'OAUTH_X=x', 'lower=x', '1A=x', 'A=b c', 'A=b;', 'NOEQUALS', '=x', 'A=B;A=C', `K=${'v'.repeat(201)}`, `${'K'.repeat(33)}=v`, 'A=sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123'];
    for (const s of bad) expect(parseEnv(s, []), s).toEqual({ ok: false, code: 'E_ENV' });
    expect(parseEnv(Array.from({ length: 17 }, (_, i) => `K${i}=v`).join(';'), [])).toEqual({ ok: false, code: 'E_ENV' });
    expect(parseEnv(Array.from({ length: 16 }, (_, i) => `K${i}=v`).join(';'), [])).toMatchObject({ ok: true });
    expect(parseEnv('MODE=literalsecretvalue', ['literalsecretvalue'])).toEqual({ ok: false, code: 'E_ENV' });
  });
  it('departments: csv of 1 to 10 existing ids, deduplicated; an unknown or malformed id is E_DEPT', () => {
    const has = (d: string) => ['software', 'sales', 'praw'].includes(d);
    expect(parseDepartments('software, sales,software', has)).toEqual({ ok: true, value: ['software', 'sales'] });
    for (const s of ['', ',', 'nope', 'software,nope', 'Software', 'a b', 'software;sales']) expect(parseDepartments(s, has), s).toEqual({ ok: false, code: 'E_DEPT' });
    expect(parseDepartments(Array(11).fill('software').map((x, i) => `${x}${i}`).join(','), () => true)).toEqual({ ok: false, code: 'E_DEPT' });
  });
  it('title is screened (1 to 80, one line, no hidden characters, no secret), ref and the numbers have ranges', () => {
    expect(parseTitle('A tool')).toEqual({ ok: true, value: 'A tool' });
    for (const s of ['', ' ', 'x'.repeat(81), 'a\nb', 'a​b', 'a﻿b', 'a\u{E0041}b', 'a️b', 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123']) expect(parseTitle(s), JSON.stringify(s)).toEqual({ ok: false, code: 'E_SCREEN' });
    expect(parseRef(undefined)).toEqual({ ok: true, value: null });
    expect(parseRef('ghcr.io/x/y:1.0@sha')).toEqual({ ok: true, value: 'ghcr.io/x/y:1.0@sha' });
    expect(parseRef('a b')).toEqual({ ok: false, code: 'E_FIELD' });
    expect(parseNumbers({})).toEqual({ ok: true, value: { timeoutMs: 60000, maxCallsPerDay: 100 } });
    expect(parseNumbers({ timeout: 5, daily: 1000 })).toEqual({ ok: true, value: { timeoutMs: 5000, maxCallsPerDay: 1000 } });
    for (const o of [{ timeout: 4 }, { timeout: 121 }, { timeout: 1.5 }, { daily: 0 }, { daily: 1001 }, { daily: Number.NaN }]) expect(parseNumbers(o), JSON.stringify(o)).toEqual({ ok: false, code: 'E_FIELD' });
  });
});
