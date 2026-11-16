import { describe, expect, it } from 'vitest';
import { canonicalJson, inputDigest } from '../governance/canonical.js';
import { DOC_KINDS, isDraftKind } from './plugins/docs/kinds.js';
import { assertTreeGrantScope, storedInputOk, treeGrantCovers, treeGrantEligible, treeGrantRunOk, TREE_GRANT_TOOLS } from './tree-grant-scope.js';
import type { ToolKind } from './policy-approval.js';
import type { ToolContext } from './types.js';

const kinds: Record<string, ToolKind> = { write_file: 'write', pin_message: 'write', forum_post: 'write', forward_to: 'write', doc_create: 'write', music_play: 'write', music_skip: 'write', music_stop: 'write', music_volume: 'write', fetch_page: 'read', github_create_pull_request: 'destructive', clickup_delete_task: 'destructive' };
const kindOf = (n: string) => kinds[n];
const row = (toolName: string, toolInput: unknown, over: Record<string, unknown> = {}) => ({ kind: 'tool', toolName, toolInput, inputSha256: inputDigest(canonicalJson(toolInput)), ...over });

describe('TG-C1: the allow-list is exactly the spec list', () => {
  it('names the nine tools and nothing else', () => {
    expect([...TREE_GRANT_TOOLS]).toEqual(['doc_create', 'forum_post', 'forward_to', 'music_play', 'music_skip', 'music_stop', 'music_volume', 'pin_message', 'write_file']);
  });
  it('destructive, read, kind-less and unlisted tools are never covered; only a strict own === false covers', () => {
    expect(treeGrantCovers('write_file', 'write', false)).toBe(true);
    for (const own of [true, undefined, null, 0, '', { reason: 'x' }]) expect(treeGrantCovers('write_file', 'write', own)).toBe(false);
    expect(treeGrantCovers('write_file', 'destructive', false)).toBe(false);
    expect(treeGrantCovers('write_file', 'read', false)).toBe(false);
    expect(treeGrantCovers('write_file', undefined, false)).toBe(false);
    expect(treeGrantCovers('fetch_page', 'read', false)).toBe(false);
    expect(treeGrantCovers('save_lesson', 'write', false)).toBe(false);
    expect(treeGrantCovers('github_create_pull_request', 'write', false)).toBe(false);
    expect(treeGrantCovers('some_new_tool', 'write', false)).toBe(false); // new tools fail closed
  });
});

describe('TG-C1: startup assertion', () => {
  const reg = (names: string[], k: Record<string, ToolKind | undefined> = kinds) => ({ names: () => names, kindOf: (n: string) => k[n] });
  it('boots with music, docs and workspace disabled (entries not registered are skipped)', () => {
    expect(() => assertTreeGrantScope(reg(['pin_message', 'forum_post', 'forward_to']))).not.toThrow();
    expect(() => assertTreeGrantScope(reg([]))).not.toThrow();
  });
  it('boots with everything registered', () => expect(() => assertTreeGrantScope(reg(Object.keys(kinds)))).not.toThrow());
  it('a registered entry with the wrong kind refuses boot', () => {
    expect(() => assertTreeGrantScope(reg(['write_file'], { write_file: 'destructive' }))).toThrow(/write_file is not a write tool/);
    expect(() => assertTreeGrantScope(reg(['forum_post'], {}))).toThrow(/forum_post/);
  });
  it('a sensitive, bot-talk, no-approval or admin entry refuses boot', () => {
    for (const bad of ['github_create_branch', 'warroom_say', 'diagram_create', 'config_propose', 'discord_read']) {
      expect(() => assertTreeGrantScope(reg([bad], { [bad]: 'write' }), [bad])).toThrow(new RegExp(bad));
    }
  });
});

describe('TG-C3 / TG-C4 (a): the one stored-input predicate', () => {
  it('accepts a covered, untampered row', () => {
    expect(treeGrantEligible(row('forum_post', { title: 't', body: 'b' }), kindOf)).toBe(true);
    expect(treeGrantEligible(row('write_file', { path: 'a.txt', content: 'x' }), kindOf)).toBe(true);
    expect(treeGrantEligible(row('write_file', { path: 'a.txt', content: 'x', overwrite: false }), kindOf)).toBe(true);
  });
  it('refuses: a tampered sha, a wrong kind of row, an unlisted tool, a read tool, a destructive tool, a missing sha or input', () => {
    expect(treeGrantEligible(row('forum_post', { title: 't' }, { inputSha256: 'x' }), kindOf)).toBe(false);
    expect(treeGrantEligible(row('forum_post', { title: 't' }, { kind: 'estimate' }), kindOf)).toBe(false);
    expect(treeGrantEligible(row('save_lesson', { a: 1 }), (n) => (n === 'save_lesson' ? 'write' : undefined))).toBe(false);
    expect(treeGrantEligible(row('fetch_page', { url: 'https://example.com/' }), kindOf)).toBe(false);
    expect(treeGrantEligible(row('write_file', { path: 'a' }), () => 'destructive')).toBe(false);
    expect(treeGrantEligible(row('forum_post', { title: 't' }, { inputSha256: null }), kindOf)).toBe(false);
    expect(treeGrantEligible(row('forum_post', null), kindOf)).toBe(false);
    expect(treeGrantEligible(row('forum_post', ['x']), kindOf)).toBe(false);
    expect(treeGrantEligible(row('forum_post', { t: 1 }), () => undefined)).toBe(false);
  });
  it('write_file with overwrite true is not eligible', () => {
    expect(treeGrantEligible(row('write_file', { path: 'a.txt', content: 'x', overwrite: true }), kindOf)).toBe(false);
  });
  it('doc_create: every DRAFT kind is refused, every non-DRAFT kind is eligible, an unknown kind is refused', () => {
    for (const k of DOC_KINDS) expect(treeGrantEligible(row('doc_create', { kind: k, fields: {} }), kindOf), k).toBe(!isDraftKind(k));
    expect(DOC_KINDS.some((k) => isDraftKind(k))).toBe(true);
    expect(storedInputOk('doc_create', { kind: 'nope' })).toBe(false);
    expect(storedInputOk('doc_create', {})).toBe(false);
  });
});

const ctxOf = (o: { tainted?: boolean; taskTainted?: boolean; direct?: boolean; thread?: string; pub?: boolean; src?: string; target?: string | null } = {}): ToolContext => ({
  tainted: () => o.tainted === true, direct: o.direct === true,
  task: { tainted: o.taskTainted === true } as never,
  source: { channelId: o.src ?? 'c1', threadId: o.thread, messageId: 'm' } as never,
  org: { dept: () => ({ workChannelId: o.target === undefined ? 'c9' : o.target }) } as never,
  channelIsPublic: async () => o.pub === true,
}) as unknown as ToolContext;

describe('TG-C4 (b): run-time predicates (consume only)', () => {
  it('write_file: never in a tainted run, whichever flag carries the taint', async () => {
    expect(await treeGrantRunOk('write_file', { path: 'a', content: 'x' }, ctxOf())).toBe(true);
    expect(await treeGrantRunOk('write_file', { path: 'a', content: 'x' }, ctxOf({ tainted: true }))).toBe(false);
    expect(await treeGrantRunOk('write_file', { path: 'a', content: 'x' }, ctxOf({ taskTainted: true }))).toBe(false);
    expect(await treeGrantRunOk('write_file', { path: 'a', overwrite: true }, ctxOf())).toBe(false);
  });
  it('forward_to: only when the audience is not wider; any doubt is a card', async () => {
    const i = { dept: 'marketing', summary: 's', reason: 'r', duty: 'x', estCostUsd: 1 };
    expect(await treeGrantRunOk('forward_to', i, ctxOf({ direct: true }))).toBe(true);
    expect(await treeGrantRunOk('forward_to', i, ctxOf({ src: 'c9' }))).toBe(true); // same channel as the target
    expect(await treeGrantRunOk('forward_to', i, ctxOf({ pub: true }))).toBe(true); // source readable by @everyone
    expect(await treeGrantRunOk('forward_to', i, ctxOf({ pub: false }))).toBe(false);
    expect(await treeGrantRunOk('forward_to', i, ctxOf({ thread: 't1', pub: false }))).toBe(false);
    expect(await treeGrantRunOk('forward_to', i, ctxOf({ direct: true, tainted: true, pub: false }))).toBe(false);
    expect(await treeGrantRunOk('forward_to', { ...i, dept: 5 }, ctxOf({ direct: true }))).toBe(false);
    const throwing = { ...ctxOf(), channelIsPublic: () => { throw new Error('x'); } } as unknown as ToolContext;
    expect(await treeGrantRunOk('forward_to', i, throwing)).toBe(false);
  });
  it('the other covered tools have no run-time predicate', async () => {
    expect(await treeGrantRunOk('forum_post', { title: 't' }, ctxOf({ tainted: true }))).toBe(true);
    expect(await treeGrantRunOk('doc_create', { kind: 'DRAFT-never' }, ctxOf())).toBe(false);
  });
});
