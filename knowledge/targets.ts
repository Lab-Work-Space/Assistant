/**
 * K5: the refs `prompt_propose` (and a rollback card) may target: the department's own head text and member prompts. `system/*` and
 * `fragments/*` are never targetable, and neither is another department's head. Checked by the tool, the service and the proposal repo.
 */
export function promptRefAllowed(ref: string, deptId: string, memberRefs?: readonly string[]): boolean {
  if (ref.startsWith('heads/')) return ref === `heads/${deptId}` && /^heads\/[a-z0-9-]+$/.test(ref);
  return /^members\/[a-z0-9-]+$/.test(ref) && (memberRefs === undefined || memberRefs.includes(ref));
}
