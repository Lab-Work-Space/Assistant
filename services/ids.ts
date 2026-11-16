/**
 * P9: every vendor id that is placed into a REST path matches a strict pattern first and is then percent-encoded.
 * Rejection text is fixed: it never echoes the offending value.
 */
export const CLICKUP_ID = /^[a-z0-9]{1,32}$/;

/** GitHub (P9): owner, repo and user names. `..` anywhere (and a bare `.`) is refused on top of the pattern. */
export const GITHUB_NAME = /^[A-Za-z0-9_.-]{1,100}$/;
export const githubName = (value: unknown): string => {
  const v = vendorId(GITHUB_NAME, value);
  if (v.includes('..') || v === '.') throw new InvalidIdError();
  return v;
};

export class InvalidIdError extends Error {
  constructor() {
    super('invalid identifier');
    this.name = 'InvalidIdError';
  }
}

/** Returns `value` when it is a string matching `re`; otherwise throws InvalidIdError. */
export function vendorId(re: RegExp, value: unknown): string {
  if (typeof value !== 'string' || !re.test(value)) throw new InvalidIdError();
  return value;
}

/** Validates, then encodes, for use as one path segment. */
export const pathId = (re: RegExp, value: unknown): string => encodeURIComponent(vendorId(re, value));
