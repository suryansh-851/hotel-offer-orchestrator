import { Context, log } from '@temporalio/activity';
import type Redis from 'ioredis';
import { config } from './config';
import type { MockOutage, Offer, Search, Supplier } from './domain';
import { errorMessage, fetchHotels } from './suppliers';

function outageForAttempt(outage: Search['outage'], attempt: number): MockOutage | undefined {
  if (outage !== 'B-once') return outage;
  return attempt === 1 ? 'B' : undefined;
}

export function createActivities(redis: Redis) {
  return {
    async fetchSupplier(supplier: Supplier, search: Search) {
      const { city } = search;
      const context = Context.current();
      const outage = outageForAttempt(search.outage, context.info.attempt);
      try {
        const hotels = await fetchHotels(supplier, city, outage, context.cancellationSignal);
        log.info('Supplier inventory received', { supplier, city, count: hotels.length });
        return { supplier, hotels };
      } catch (error) {
        log.warn('Supplier request failed', { supplier, city, reason: errorMessage(error) });
        throw error;
      }
    },

    async storeAndFilter(search: Search, available: Supplier[], offers: Offer[]): Promise<Offer[]> {
      const key = `hotels:v1:${encodeURIComponent(search.city)}:${available.join('+')}`;
      try {
        // A retry replaces the entire snapshot. The range read sees this request's write.
        const tx = redis.multi().del(key);
        if (offers.length) {
          tx.zadd(key, ...offers.flatMap(offer => [offer.price, JSON.stringify(offer)]));
          tx.expire(key, config.snapshotTtlSeconds);
        }
        tx.zrangebyscore(key, search.minPrice ?? '-inf', search.maxPrice ?? '+inf');
        const replies = await tx.exec();
        if (!replies) throw new Error('Redis transaction aborted');
        for (const [error] of replies) {
          if (error) throw error;
        }
        const members = replies.at(-1)?.[1];
        if (!Array.isArray(members)) throw new Error('Unexpected Redis range response');
        log.info('Redis price range read', { key, stored: offers.length, matched: members.length });
        return members.map(member => JSON.parse(member) as Offer);
      } catch (error) {
        log.error('Redis snapshot failed', { key, reason: errorMessage(error) });
        throw error;
      }
    }
  };
}
