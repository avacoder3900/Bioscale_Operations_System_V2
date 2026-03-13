# DOMAIN-10-CARTRIDGE-LAB — Lab Cartridges, Firmware & Test Results

## Overview
**Domain:** Lab Cartridge Management, Cartridge Groups, Firmware Devices/Cartridges, Test Results, Device Events
**Dependencies:** Auth, Manufacturing
**MongoDB Collections:** `lab_cartridges`, `cartridge_groups`, `firmware_devices`, `firmware_cartridges`, `test_results`, `device_events`, `cartridge_records` (Sacred)
**Test File:** `tests/contracts/10-cartridges.test.ts` (11 tests)
**Contract Registry Sections:** SPU Cartridge Routes, SPU Cartridge Admin Routes, SPU Test Results Routes

## Important Distinction
- **`lab_cartridges`** — calibration/reference cartridges used in the lab for testing (operational)
- **`cartridge_records`** — manufacturing cartridge DMRs (Sacred Tier 1, handled mostly by Manufacturing domain)
- **`firmware_cartridges`** — cartridges as seen by the firmware/device system (operational)

---

## Story CART-01: Lab Cartridge List, Dashboard & Groups

### Description
Implement lab cartridge management — list, dashboard, groups, analysis, and the cartridge admin pages.

### Routes Covered
- `GET /spu/cartridges` — cartridge list
- `GET /spu/cartridge-dashboard` — dashboard with stats
- `GET /spu/cartridges/groups` — cartridge groups
- `GET /spu/cartridges/analysis` — analysis page
- `GET /spu/cartridges/[cartridgeId]` — cartridge detail with history
- `GET /spu/cartridge-admin` — admin landing
- `GET /spu/cartridge-admin/filled` — recently filled cartridges
- `GET /spu/cartridge-admin/statistics` — statistics
- `GET /spu/cartridge-admin/storage` — storage locations
- `GET /spu/cartridge-admin/failures` — failure records
- `GET /spu/cartridge-admin/sku-management` — SKU management
- `POST /spu/cartridges/scan` — scan barcode API
- `GET /spu/cartridges/export` — CSV export API

### Contract References
**GET /spu/cartridges returns:**
```typescript
{
  cartridges: {
    id: string, serialNumber: string, status: string,
    assayTypeId: string | null, assayTypeName: string | null,
    lotNumber: string | null, createdAt: Date
  }[]
}
```

**GET /spu/cartridges/[cartridgeId] returns:**
```typescript
{
  cartridge: {
    id: string, serialNumber: string, status: string,
    assayTypeId: string | null, assayTypeName: string | null,
    lotNumber: string | null,
    history: { action: string, timestamp: Date, userId: string | null, details: Record<string, unknown> | null }[]
  }
}
```

### MongoDB Models Used
- `LabCartridge` — with **embedded** `usageLog[]`
- `CartridgeGroup` — simple reference collection
- `CartridgeRecord` — for admin views (manufacturing cartridges)
- `AssayDefinition` — for assay type info

### MongoDB-Specific Notes
- Lab cartridge usage log is embedded: `labCartridge.usageLog[]`
- Old code: `Cartridge` + `CartridgeUsageLog` — merged
- Cartridge admin pages query the `cartridge_records` (Sacred) collection for manufacturing pipeline views
- Statistics: aggregation pipelines on `cartridge_records`
- Storage: queries `equipment_locations` and `cartridge_records` with storage phase

### Acceptance Criteria
- Tests 1-7 in `10-cartridges.test.ts` pass (cartridge list, groups, analysis, dashboard, admin, filled, statistics)

---

## Story CART-02: Firmware Devices, Firmware Cartridges & Test Results

### Description
Implement firmware device/cartridge management and test result recording.

### Routes Covered
- `GET /spu/test-results` — test result list
- `GET /spu/test-results/[resultId]` — test result detail with spectro readings
- Firmware device endpoints (handled via API)
- Device event logging

### Contract References
**GET /spu/test-results returns:**
```typescript
{
  results: {
    id: string, testType: string, status: string, result: 'pass' | 'fail' | null,
    cartridgeId: string | null, cartridgeSerialNumber: string | null,
    testedAt: Date | null, testedByUsername: string | null,
    notes: string | null, createdAt: Date
  }[]
}
```

**GET /spu/test-results/[resultId] returns:**
```typescript
{
  result: {
    id: string, testType: string, status: string, result: 'pass' | 'fail' | null,
    cartridgeId: string | null, cartridgeSerialNumber: string | null,
    rawData: Record<string, unknown> | null, processedData: Record<string, unknown> | null,
    testedAt: Date | null, testedByUsername: string | null,
    notes: string | null, createdAt: Date
  }
}
```

### MongoDB Models Used
- `TestResult` — with **embedded** `readings[]` (spectro readings)
- `FirmwareDevice` — device identity management
- `FirmwareCartridge` — firmware-side cartridge validation
- `DeviceEvent` — **immutable** Tier 3 log. Append-only, never modified

### MongoDB-Specific Notes
- Spectro readings are embedded in test results: `testResult.readings[]`
- ⚠️ Size warning: if tests commonly have > 500 readings, may need separate collection
- Device events are immutable — Mongoose middleware blocks updates/deletes
- Old code: `TestResult` + `SpectroReading` — merged (pending size check)

### Acceptance Criteria
- Tests 8-11 in `10-cartridges.test.ts` pass (storage, failures, release, sku-management)
- Test result list and detail pages load
- Firmware device/cartridge management works
- Device events are append-only
