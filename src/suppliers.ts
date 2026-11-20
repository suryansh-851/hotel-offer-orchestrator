import { config } from './config';
import { normalize, type MockOutage, type Supplier, type SupplierHotel } from './domain';

/** A failed supplier call. `retryable` says whether repeating the same request could succeed. */
export class SupplierError extends Error {
  constructor(message: string, readonly retryable: boolean) {
    super(message);
    this.name = 'SupplierError';
  }
}

/**
 * Whether a non-2xx status is worth another attempt. A 4xx means this request or the supplier's
 * data is wrong, so retrying cannot help. 408 and 429 ask the client to try again, and 5xx is the
 * supplier's own failure.
 */
export function isRetryableStatus(status: number): boolean {
  return !(status >= 400 && status < 500) || status === 408 || status === 429;
}

function isHotel(value: unknown, city: string): value is SupplierHotel {
  if (!value || typeof value !== 'object') return false;
  const row = value as Partial<SupplierHotel>;
  return typeof row.hotelId === 'string' && row.hotelId.length > 0
    && typeof row.name === 'string' && row.name.trim().length > 0
    && typeof row.city === 'string' && normalize(row.city) === city
    && typeof row.price === 'number' && Number.isFinite(row.price) && row.price >= 0
    && typeof row.commissionPct === 'number' && Number.isFinite(row.commissionPct)
    && row.commissionPct >= 0 && row.commissionPct <= 100;
}

export async function fetchHotels(supplier: Supplier, city: string, outage?: MockOutage, cancellation?: AbortSignal) {
  const url = new URL(`/supplier${supplier}/hotels`, config.supplierBaseUrl);
  url.searchParams.set('city', city);
  const timeout = AbortSignal.timeout(2000);
  const response = await fetch(url, {
    signal: cancellation ? AbortSignal.any([timeout, cancellation]) : timeout,
    headers: outage ? { 'X-Mock-Outage': outage } : {}
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new SupplierError(`Supplier ${supplier} returned HTTP ${response.status}`, isRetryableStatus(response.status));
  }
  const invalid = () => new SupplierError(`Supplier ${supplier} returned invalid inventory`, false);
  let rows: unknown;
  try {
    rows = await response.json();
  } catch (error) {
    // A complete body that is not JSON will not improve on retry. A dropped connection throws a different error.
    throw error instanceof SyntaxError ? invalid() : error;
  }
  if (!Array.isArray(rows) || !rows.every(row => isHotel(row, city))) throw invalid();
  return rows as SupplierHotel[];
}

export async function probeSupplier(supplier: Supplier, outage?: MockOutage) {
  const start = Date.now();
  try {
    await fetchHotels(supplier, 'delhi', outage);
    return { status: 'up' as const, latencyMs: Date.now() - start };
  } catch (error) {
    return { status: 'down' as const, latencyMs: Date.now() - start, reason: errorMessage(error) };
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
