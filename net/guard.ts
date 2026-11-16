import { isBlockedAddress } from './address.js';
import { createCheckTarget, createSafeFetch } from './fetch.js';

export { isBlockedAddress } from './address.js';
export { SafeFetchError, MAX_BYTES } from './fetch.js';
export type { Resolver, Transport, TransportRequest, TransportResponse, SafeFetchOptions, SafeFetchResult, TargetOptions } from './fetch.js';

export const checkUrl = createCheckTarget(isBlockedAddress);
export const safeFetch = createSafeFetch(isBlockedAddress);
