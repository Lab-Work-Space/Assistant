/**
 * HEAL-1 (H5, HL-C19): the ClickUp workspace-mode notice is posted once per mode, not once per boot. Compares only the mode token
 * (`workspace` or `workspace-all`) against the outcome of the newest `clickup.mode` audit row. A changed mode, no row, or a failed read all announce
 * (the safe side: one extra notice rather than a silent mode change). The workspace count of the all-mode notice is not compared.
 */
export async function modeNeedsNotice(mode: 'workspace' | 'workspace-all', latestOutcome: () => Promise<string | null>): Promise<boolean> {
  try {
    return (await latestOutcome()) !== mode;
  } catch {
    return true;
  }
}
