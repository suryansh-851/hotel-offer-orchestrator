export const suppliers = ['A', 'B'] as const;
export type Supplier = (typeof suppliers)[number];
export type MockOutage = Supplier | 'both';

export interface SupplierHotel {
  hotelId: string;
  name: string;
  price: number;
  city: string;
  commissionPct: number;
}

export interface Offer {
  name: string;
  price: number;
  supplier: `Supplier ${Supplier}`;
  commissionPct: number;
}

export interface Search {
  city: string;
  minPrice?: number;
  maxPrice?: number;
  outage?: MockOutage | 'B-once';
}

export interface Inventory {
  supplier: Supplier;
  hotels: SupplierHotel[];
}

export function normalize(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLowerCase().normalize('NFC');
}

// The workflow supplies inventories in A, B order. The first offer wins a tie.
export function bestOffers(inventories: Inventory[]): Offer[] {
  const byName = new Map<string, Offer>();
  for (const { supplier, hotels } of inventories) {
    for (const { name, price, commissionPct } of hotels) {
      const key = normalize(name);
      const current = byName.get(key);
      if (!current || price < current.price) {
        byName.set(key, { name: name.trim(), price, supplier: `Supplier ${supplier}`, commissionPct });
      }
    }
  }
  return [...byName.values()];
}
