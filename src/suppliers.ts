import { config } from './config';
import { normalize, type MockOutage, type Supplier, type SupplierHotel } from './domain';

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
    throw new Error(`Supplier ${supplier} returned HTTP ${response.status}`);
  }
  const rows: unknown = await response.json();
  if (!Array.isArray(rows) || !rows.every(row => isHotel(row, city))) {
    throw new Error(`Supplier ${supplier} returned invalid inventory`);
  }
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
