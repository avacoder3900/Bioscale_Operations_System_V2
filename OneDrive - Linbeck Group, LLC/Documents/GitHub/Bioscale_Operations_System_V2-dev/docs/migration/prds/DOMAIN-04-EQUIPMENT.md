# DOMAIN-04-EQUIPMENT — Equipment, Locations, Opentrons & Temperature Monitoring

## Overview
**Domain:** Equipment Management, Opentrons Robots, Temperature Probes
**Dependencies:** Auth
**MongoDB Collections:** `equipment`, `equipment_locations`, `opentrons_robots`, `consumables`
**Test File:** `tests/contracts/04-equipment.test.ts` (5 tests)
**Contract Registry Sections:** SPU Equipment Routes, Opentrons Lab Routes

---

## Story EQ-01: Fridges, Ovens & Temperature Monitoring

### Description
Implement equipment CRUD for fridges and ovens, temperature probe display, and the equipment detail page.

### Routes Covered
- `GET /spu/equipment/fridges-ovens` — equipment list with temperatures
- `GET /spu/equipment/detail` — equipment detail
- `GET /spu/equipment/temperature-probes` — probe list
- `GET /spu/equipment/activity` — activity log

### Contract References
**GET /spu/equipment/fridges-ovens returns:**
```typescript
{
  locations: { ... }[]   // equipment locations
  equipmentSensors: { ... }[]  // temperature sensors
  isAdmin: boolean
}
```
Note: test checks for keys `locations`, `equipmentSensors`, `isAdmin`.

**GET /spu/equipment/temperature-probes returns:**
```typescript
{
  probes: {
    id: string, name: string, deviceId: string | null,
    currentTemperature: number | null, lastReadingAt: Date | null,
    status: string, linkedEquipmentId: string | null, linkedEquipmentName: string | null
  }[]
}
```

### MongoDB Models Used
- `Equipment` — `Equipment.find().sort({ name: 1 })`
- `EquipmentLocation` — locations with embedded `currentPlacements`

### MongoDB-Specific Notes
- Old code joined `Equipment` → `EquipmentLocation` → `LocationPlacement`. New: placements are **embedded** in `equipment_locations.currentPlacements[]`
- Temperature data comes from MOCREO integration — stored on Equipment document as `currentTemperatureC`, `lastTemperatureReadAt`

### Acceptance Criteria
- Tests 1-3, 5 in `04-equipment.test.ts` pass (fridges-ovens, detail, activity, temperature-probes)

---

## Story EQ-02: Decks, Cooling Trays & Consumables

### Description
Implement deck and cooling tray management using the unified consumables collection.

### Routes Covered
- `GET /spu/equipment/decks-trays` — list decks and trays
- `POST /spu/equipment/decks-trays/deck` (actions: create, update, delete)
- `POST /spu/equipment/decks-trays/tray` (actions: create, update, delete)

### Contract References
**GET /spu/equipment/decks-trays returns:**
```typescript
{
  decks: { id: string, name: string, description: string | null, status: string, slots: number }[]
  trays: { id: string, name: string, description: string | null, status: string, deckId: string | null, deckName: string | null }[]
}
```

### MongoDB Models Used
- `Consumable` — `Consumable.find({ type: 'deck' })` and `Consumable.find({ type: 'cooling_tray' })`

### MongoDB-Specific Notes
- Old code had separate `DeckRecord` and `CoolingTrayRecord` collections
- New code uses unified `consumables` collection with `type` discriminator
- Deck CRUD: create/update/delete consumables where `type: 'deck'`

### Acceptance Criteria
- Test 4 in `04-equipment.test.ts` passes (decks-trays page loads)
- Deck and tray CRUD operations work

---

## Story EQ-03: Opentrons Robots, Protocols & Runs

### Description
Implement the Opentrons lab section — robot management, protocol viewing, run management.

### Routes Covered
- `GET /opentrons` — robots + protocol records
- `GET /opentrons/devices` — robot list
- `GET /opentrons/devices/[robotId]` — robot detail with health, pipettes, calibration
- `GET /opentrons/labware` — labware catalog
- `GET /opentrons/protocols/[robotId]/[protocolId]` — protocol detail
- `GET /opentrons/runs/[runId]` — run detail
- `GET /opentrons/runs/new` — create run form

### Contract References
**GET /opentrons returns:**
```typescript
{
  robots: { robotId: string, name: string, ip: string, lastHealthOk: boolean }[]
  protocolRecords: {
    id: string, robotId: string, opentronsProtocolId: string,
    protocolName: string | null, protocolType: string | null,
    analysisStatus: string | null, pipettesRequired: unknown,
    labwareDefinitions: unknown, parametersSchema: unknown, updatedAt: string
  }[]
}
```

### MongoDB Models Used
- `OpentronsRobot` — robots with **embedded** `protocols[]` and `recentHealthSnapshots[]`

### MongoDB-Specific Notes
- Old code had separate `OpentronsProtocolRecord` and `OpentronsHealthSnapshot` collections — now **embedded** in the robot document
- Protocol records: `OpentronsRobot.findById(robotId)` then access `robot.protocols`
- Live health/run data comes from the Opentrons HTTP API (external integration), not from MongoDB
- The `/opentrons/runs/[runId]` route calls the Opentrons robot API directly for live run data

### Acceptance Criteria
- Opentrons pages load without errors
- Robot list shows with health status
- Protocol and run details display correctly
- External Opentrons API calls are properly handled (stub if robot unavailable)
