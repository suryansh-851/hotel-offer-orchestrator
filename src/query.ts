import { normalize, type MockOutage, type Search } from './domain';
import { parseMockOutage, parseSearchOutage } from './faults';

export class InputError extends Error {}

export function parseCity(value: unknown): string {
  // eslint-disable-next-line no-control-regex -- rejecting control characters is the point of this check
  if (typeof value !== 'string' || !value.trim() || value.length > 80 || /[\x00-\x1f\x7f]/.test(value)) {
    throw new InputError('Supply one non-empty city of up to 80 characters.');
  }
  return normalize(value);
}

function parsePrice(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !/^\d+(?:\.\d+)?$/.test(value) || Number(value) > Number.MAX_SAFE_INTEGER) {
    throw new InputError(`${field} must be a non-negative decimal number.`);
  }
  return Number(value);
}

const unsupportedOutage = () => new InputError('Unsupported X-Mock-Outage value.');

/** X-Mock-Outage for a supplier endpoint or /health. Ignored entirely unless fault injection is enabled. */
export function parseOutage(value: string | undefined, enableMockFaults: boolean): MockOutage | undefined {
  const outage = parseMockOutage(value, enableMockFaults);
  if (outage === 'unsupported') throw unsupportedOutage();
  return outage;
}

export function parseSearch(query: Record<string, unknown>, outageHeader?: string, enableMockFaults = false): Search {
  const city = parseCity(query.city);
  const minPrice = parsePrice(query.minPrice, 'minPrice');
  const maxPrice = parsePrice(query.maxPrice, 'maxPrice');
  if (minPrice !== undefined && maxPrice !== undefined && minPrice > maxPrice) {
    throw new InputError('minPrice must be less than or equal to maxPrice.');
  }
  const outage = parseSearchOutage(outageHeader, enableMockFaults);
  if (outage === 'unsupported') throw unsupportedOutage();
  // With faults off the key is absent, so the header never reaches the workflow input.
  return { city, minPrice, maxPrice, ...(outage && { outage }) };
}
