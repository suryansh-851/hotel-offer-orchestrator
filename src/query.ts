import { normalize, type MockOutage, type Search } from './domain';

export class InputError extends Error {}

export function parseCity(value: unknown): string {
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

export function parseOutage(value?: string): MockOutage | undefined {
  if (value === undefined || value === 'A' || value === 'B' || value === 'both') return value;
  throw new InputError('Unsupported X-Mock-Outage value.');
}

export function parseSearch(query: Record<string, unknown>, outageHeader?: string): Search {
  const city = parseCity(query.city);
  const minPrice = parsePrice(query.minPrice, 'minPrice');
  const maxPrice = parsePrice(query.maxPrice, 'maxPrice');
  if (minPrice !== undefined && maxPrice !== undefined && minPrice > maxPrice) {
    throw new InputError('minPrice must be less than or equal to maxPrice.');
  }
  const outage = outageHeader === 'B-once' ? outageHeader : parseOutage(outageHeader);
  return { city, minPrice, maxPrice, outage };
}
