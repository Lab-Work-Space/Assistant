// Workspace test (ws_run test). Not shipped. Fixture tests are .mjs so the repo's vitest does not collect them.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TOOLS, call } from '../src/tools.mjs';

test('echo, add_numbers and netprobe', async () => {
  assert.equal(TOOLS.length, 3);
  assert.equal(await call('echo', { text: 'hi' }), 'echo:hi');
  assert.equal(await call('add_numbers', { a: 2, b: 3 }), '5');
  assert.equal(await call('nope', {}), null);
});
