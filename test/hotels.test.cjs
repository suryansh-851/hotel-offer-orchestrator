const test = require('node:test');
const assert = require('node:assert/strict');
const { bestOffers } = require('../dist/domain');
const { parseSearch, InputError } = require('../dist/query');
const { inventory } = require('../dist/fixtures');

test('Delhi preserves both exclusive hotels and the commission from each winning offer', () => {
  const inventories = ['A', 'B'].map(supplier => ({
    supplier, hotels: inventory[supplier].filter(hotel => hotel.city === 'delhi')
  }));
  assert.deepEqual(bestOffers(inventories), [
    { name: 'Holtin', price: 5340, supplier: 'Supplier B', commissionPct: 20 },
    { name: 'Radison', price: 5900, supplier: 'Supplier A', commissionPct: 13 },
    { name: 'Neem Courtyard', price: 7200, supplier: 'Supplier A', commissionPct: 9 },
    { name: 'Lotus Residency', price: 8100, supplier: 'Supplier B', commissionPct: 11 }
  ]);
});

test('deduplication handles case, whitespace and duplicates within one supplier', () => {
  const hotel = { ...inventory.A[0], name: 'Neem Courtyard', price: 80 };
  const result = bestOffers([
    { supplier: 'A', hotels: [{ ...hotel, name: '  neem   courtyard ', price: 100 }, hotel] },
    { supplier: 'B', hotels: [{ ...hotel, name: 'NEEM COURTYARD', commissionPct: 99 }] }
  ]);
  assert.deepEqual(result, [{ name: 'Neem Courtyard', price: 80, supplier: 'Supplier A', commissionPct: 10 }]);
});

test('equivalent accents match while genuinely different hotel names remain distinct', () => {
  const a = { ...inventory.A[0], name: 'Ho\u0302tel', price: 6000 };
  const b = { ...inventory.B[0], name: 'Hôtel', price: 5340 };
  const unaccented = { ...a, name: 'Hotel', price: 7000 };
  const winners = bestOffers([{ supplier: 'A', hotels: [a, unaccented] }, { supplier: 'B', hotels: [b] }]);
  assert.deepEqual(winners, [
    { name: b.name, price: b.price, supplier: 'Supplier B', commissionPct: b.commissionPct },
    { name: unaccented.name, price: unaccented.price, supplier: 'Supplier A', commissionPct: unaccented.commissionPct }
  ]);
  assert.equal(parseSearch({ city: 'Montre\u0301al' }).city, parseSearch({ city: 'Montréal' }).city);
});

test('missing inventory yields an empty list', () => {
  assert.deepEqual(bestOffers([{ supplier: 'B', hotels: [] }]), []);
});

test('city normalization, decimal bounds, zero and single-sided bounds', () => {
  const query = parseSearch({ city: '  New   Delhi  ', minPrice: '0', maxPrice: '100.50' }, 'A', true);
  assert.deepEqual(query, { city: 'new delhi', minPrice: 0, maxPrice: 100.5, outage: 'A' });
  assert.equal(parseSearch({ city: 'Delhi', maxPrice: '0' }).maxPrice, 0);
  assert.equal(parseSearch({ city: 'Delhi', minPrice: '5900' }).maxPrice, undefined);
});

test('invalid cities, repeated parameters and invalid ranges are rejected', () => {
  for (const query of [
    {}, { city: '' }, { city: '   ' }, { city: ['delhi', 'mumbai'] }, { city: 'x'.repeat(81) },
    { city: 'delhi', minPrice: '' }, { city: 'delhi', maxPrice: 'Infinity' },
    { city: 'delhi', minPrice: '-1' }, { city: 'delhi', minPrice: '0x10' },
    { city: 'delhi', minPrice: ['1', '2'] }, { city: 'delhi', minPrice: '6000', maxPrice: '5999' }
  ]) assert.throws(() => parseSearch(query), InputError);
  assert.throws(() => parseSearch({ city: 'delhi' }, 'C', true), InputError);
});
