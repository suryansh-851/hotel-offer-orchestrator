import { ApplicationFailure, isCancellation, log, proxyActivities } from '@temporalio/workflow';
import type { createActivities } from './activities';
import { bestOffers, suppliers, type Inventory, type Search, type Supplier } from './domain';

const { fetchSupplier, storeAndFilter } = proxyActivities<ReturnType<typeof createActivities>>({
  startToCloseTimeout: '4 seconds',
  scheduleToCloseTimeout: '12 seconds',
  retry: { maximumAttempts: 3, initialInterval: '250 milliseconds', backoffCoefficient: 2 }
});

export async function compareHotelOffers(search: Search) {
  log.info('Hotel comparison started', { city: search.city });
  const results = await Promise.allSettled(suppliers.map(supplier => fetchSupplier(supplier, search)));
  const inventories: Inventory[] = [];
  const unavailable: Supplier[] = [];
  for (const [index, result] of results.entries()) {
    if (result.status === 'fulfilled') {
      inventories.push(result.value);
    } else {
      if (isCancellation(result.reason)) throw result.reason;
      const supplier = suppliers[index]!;
      unavailable.push(supplier);
      log.warn('Supplier unavailable after activity retries', { supplier, city: search.city });
    }
  }
  if (!inventories.length) {
    log.error('Both suppliers unavailable', { city: search.city });
    throw ApplicationFailure.nonRetryable('Both suppliers are unavailable.', 'SuppliersUnavailable');
  }
  const winners = bestOffers(inventories);
  const available = inventories.map(inventory => inventory.supplier);
  try {
    const offers = await storeAndFilter(search, available, winners);
    log.info('Hotel comparison completed', { city: search.city, unique: winners.length, returned: offers.length, unavailable });
    return { offers, unavailable };
  } catch (error) {
    if (isCancellation(error)) throw error;
    log.error('Could not store or filter hotel offers', { city: search.city });
    throw ApplicationFailure.create({
      message: 'Offer storage is unavailable.', type: 'StorageUnavailable', nonRetryable: true,
      cause: error instanceof Error ? error : undefined
    });
  }
}
