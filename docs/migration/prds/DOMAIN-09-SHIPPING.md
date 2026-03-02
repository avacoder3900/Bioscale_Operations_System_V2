# DOMAIN-09-SHIPPING — Shipping Lots, Packages & QA/QC Release

## Overview
**Domain:** Shipping Lot Management, Package Assembly, QA/QC Release Flow
**Dependencies:** Auth, Customers, Manufacturing
**MongoDB Collections:** `shipping_lots`, `shipping_packages`, `cartridge_records` (Sacred)
**Test File:** `tests/contracts/09-shipping.test.ts` (1 test)
**Contract Registry Sections:** SPU Shipping Routes, SPU Cartridge Admin Routes (release)

---

## Story SHIP-01: Shipping Page & Lot Management

### Description
Implement the shipping page — list shipments, create shipments, manage shipping lots with QA/QC releases, and shipping packages.

### Routes Covered
- `GET /spu/shipping` — shipping list with customers and available SPUs
- `POST /spu/shipping` (actions: create, updateStatus)
- `GET /spu/cartridge-admin/release` — QA/QC release page

### Contract References
**GET /spu/shipping returns:**
```typescript
{
  shipments: {
    id: string, trackingNumber: string | null, carrier: string | null,
    status: string, destination: string | null,
    shippedAt: Date | null, deliveredAt: Date | null,
    customerId: string | null, customerName: string | null,
    items: { spuId: string, spuUdi: string }[],
    createdAt: Date
  }[]
  customers: { id: string, name: string }[]
  availableSpus: { id: string, udi: string }[]
}
```

**Form Actions:**
- `create` — `{ customerId?, carrier?, trackingNumber?, destination?, spuIds[] }`
- `updateStatus` — `{ shipmentId, status }`

### MongoDB Models Used
- `ShippingLot` — with **embedded** `qaqcReleases[]`. Contains assay type and customer denormalized references
- `ShippingPackage` — with **embedded** `cartridges[]` list and **full customer SNAPSHOT**
- `Customer` — for customer dropdown
- `Spu` — for available SPUs
- `CartridgeRecord` — writes `qaqcRelease` and `shipping` phases (WRITE-ONCE on cartridge)

### MongoDB-Specific Notes
- **Shipping packages have full customer SNAPSHOT** — `{ _id, name, customerType, contactName, contactEmail, contactPhone, address }`. If customer moves later, the shipping record preserves where it was actually shipped
- QA/QC releases are embedded in shipping lots: `shippingLot.qaqcReleases[]`
- Cartridge list embedded in package: `shippingPackage.cartridges[]` (was junction table `PackageCartridge`)
- Shipping a package writes `shipping` phase on each cartridge record (WRITE-ONCE): includes full customer snapshot, tracking, carrier info
- QA/QC release writes `qaqcRelease` phase on cartridge records

### Acceptance Criteria
- Test 1 in `09-shipping.test.ts` passes (shipping page loads)
- Shipment CRUD works
- QA/QC release flow works
- Customer snapshot is captured at shipment time
