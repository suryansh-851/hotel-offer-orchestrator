import type { MockOutage, Search } from './domain';

// Demo-only fault injection through the X-Mock-Outage request header.
// This module is pure: it never reads the environment. Callers pass `enabled`, so with the
// flag off the header is ignored everywhere and never reaches the workflow input.

export type SearchOutage = NonNullable<Search['outage']>;

/**
 * Reads X-Mock-Outage for a supplier endpoint or /health.
 * Returns undefined when there is nothing to inject: the header is absent, or faults are disabled
 * and the header, valid or not, is ignored. Returns 'unsupported' for an unknown value when enabled.
 */
export function parseMockOutage(value: string | undefined, enabled: boolean): MockOutage | undefined | 'unsupported' {
  if (!enabled || value === undefined) return undefined;
  return value === 'A' || value === 'B' || value === 'both' ? value : 'unsupported';
}

/** Like parseMockOutage, and a search also accepts 'B-once': Supplier B fails on its first attempt only. */
export function parseSearchOutage(value: string | undefined, enabled: boolean): SearchOutage | undefined | 'unsupported' {
  return enabled && value === 'B-once' ? value : parseMockOutage(value, enabled);
}

/** The outage an activity attempt should send to the supplier. `B-once` heals after the first attempt. */
export function outageForAttempt(outage: Search['outage'], attempt: number): MockOutage | undefined {
  if (outage !== 'B-once') return outage;
  return attempt === 1 ? 'B' : undefined;
}
