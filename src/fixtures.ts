import type { Supplier, SupplierHotel } from './domain';

export const inventory: Record<Supplier, SupplierHotel[]> = {
  A: [
    { hotelId: 'a1', name: 'Holtin', price: 6000, city: 'delhi', commissionPct: 10 },
    { hotelId: 'a2', name: 'Radison', price: 5900, city: 'delhi', commissionPct: 13 },
    { hotelId: 'a3', name: 'Neem Courtyard', price: 7200, city: 'delhi', commissionPct: 9 },
    { hotelId: 'a4', name: 'Harbour House', price: 4800, city: 'mumbai', commissionPct: 12 }
  ],
  B: [
    { hotelId: 'b1', name: 'Holtin', price: 5340, city: 'delhi', commissionPct: 20 },
    { hotelId: 'b2', name: 'Radison', price: 6400, city: 'delhi', commissionPct: 15 },
    { hotelId: 'b3', name: 'Lotus Residency', price: 8100, city: 'delhi', commissionPct: 11 },
    { hotelId: 'b4', name: 'Harbour House', price: 4800, city: 'mumbai', commissionPct: 16 }
  ]
};
