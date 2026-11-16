import { describe, expect, it } from 'vitest';
import { ConfigSchema } from '../../config/schema.js';
import { TASK_TREE_MAX_DEPTH } from './tasks.js';

// TASKADMIN-1 (TA-C5): the subtree walk must reach every level `limits.depth` allows. config/schema.ts is not touched by the change, so this test binds the two.
describe('TASK_TREE_MAX_DEPTH (TA-C5)', () => {
  it('is at least the schema maximum of limits.depth: the schema accepts it and rejects one more', () => {
    expect(ConfigSchema['limits.depth'].safeParse(TASK_TREE_MAX_DEPTH).success).toBe(true);
    expect(ConfigSchema['limits.depth'].safeParse(TASK_TREE_MAX_DEPTH + 1).success).toBe(false);
  });
});
