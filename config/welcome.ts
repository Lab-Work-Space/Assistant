/** Gate 1 S14: the welcome message is a template with one placeholder, {user}, and no way to ping anyone else or link anywhere. */
export const WELCOME_MESSAGE_MAX = 500;
export const WELCOME_RAID_MIN = 3;
export const WELCOME_RAID_MAX = 30;

/** Null when the template is acceptable, else why not. */
export function welcomeMessageProblem(msg: string): string | null {
  if (msg.length > WELCOME_MESSAGE_MAX) return `at most ${WELCOME_MESSAGE_MAX} characters`;
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u2028\u2029\p{Cf}]/u.test(msg)) return 'no control or invisible characters';
  const withoutUser = msg.replaceAll('{user}', '');
  if (/[{}]/.test(withoutUser)) return '{user} is the only placeholder';
  if (/@everyone|@here/i.test(msg)) return 'no @everyone or @here';
  if (/<@|<#|<@&/.test(msg)) return 'no mention syntax; {user} is the only mention';
  if (/:\/\/|discord\.gg|discord(?:app)?\.com\/invite|www\./i.test(msg)) return 'no links or invites';
  return null;
}
