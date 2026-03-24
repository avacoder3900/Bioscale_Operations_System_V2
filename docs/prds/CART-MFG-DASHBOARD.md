# PRD: CART MFG In DEVELOPMENT — Master Manufacturing Dashboard

**Document:** CART-MFG-DASHBOARD.md  
**Route:** `/manufacturing/cart-mfg-dev`  
**Status:** Draft  
**Date:** 2026-03-24  
**Author:** Agent001 (AI Engineering Lead, Brevitest)

---

## Table of Contents

1. [Overview & Motivation](#1-overview--motivation)
2. [User Stories](#2-user-stories)
3. [Manufacturing Flow Reference](#3-manufacturing-flow-reference)
4. [Feature Specifications — Pipeline Stages](#4-feature-specifications--pipeline-stages)
5. [Print Barcodes Page Spec](#5-print-barcodes-page-spec)
6. [Robot Center-Line Layout](#6-robot-center-line-layout)
7. [Click-to-Expand Interaction Spec](#7-click-to-expand-interaction-spec)
8. [Stats & Metrics Section Spec](#8-stats--metrics-section-spec)
9. [Data Model Changes](#9-data-model-changes)
10. [API / Server Load Function Design](#10-api--server-load-function-design)
11. [UI Wireframe Description](#11-ui-wireframe-description)
12. [Implementation Stories](#12-implementation-stories)
13. [Dependencies & Risks](#13-dependencies--risks)
14. [Future Enhancements](#14-future-enhancements)

---

## 1. Overview & Motivation

### What Is This?

The **CART MFG In DEVELOPMENT** dashboard is a master admin overview of the entire Brevitest cartridge manufacturing line. It surfaces all existing BIMS data in a single unified visual pipeline — from raw material prep through shipping — with the Opentrons robots as the central axis.

This is **not** a replacement for any existing page. Every stage node links out to the existing BIMS workflow page. The dashboard is a read-mostly "mission control" view: any operator can see at a glance what every robot is doing, how many cartridges are at each stage, and where the bottlenecks are today.

### Why Build It?

| Problem | Impact |
|---------|--------|
| No single view of the full line | Supervisors must tab between 8+ pages to understand current state |
| Robot availability is invisible from the floor | Operators don't know if a robot is free without walking to it |
| Inventory at each stage unknown until someone checks | Batch planning is manual and error-prone |
| Today's throughput requires manual calculation | Shift summaries are delayed |
| Print Barcodes has no BIMS page at all | Barcode sheets are untracked, creating traceability gaps |

### Goals

- **Goal 1:** One-glance visibility of the full manufacturing line for supervisors and managers.
- **Goal 2:** Real-time robot status (running / available / blocked) per robot.
- **Goal 3:** Inventory counts at every pipeline stage without leaving this page.
- **Goal 4:** Drill-down to any active run or completed event by clicking → navigate to the existing BIMS page.
- **Goal 5:** Formalize Print Barcodes tracking with a new BIMS page linked from this dashboard.
- **Goal 6:** Today's throughput stats with weekly context.

### Non-Goals

- This dashboard does **not** allow data entry (except via navigation to existing pages).
- It does **not** replace any existing manufacturing workflow page.
- It does **not** add new enforcement logic to the manufacturing process steps.
- It is **not** a real-time streaming dashboard (polling every 30s is acceptable).

---

## 2. User Stories

### Admin / Supervisor (Primary)

> **US-01:** As an admin, I want to see all three robots' current status on one screen so I can immediately know if any robot is idle and available for the next run.

> **US-02:** As an admin, I want to see the inventory count at every pipeline stage (e.g., "48 backed cartridges waiting for wax") so I can plan production without polling operators.

> **US-03:** As an admin, I want to click any pipeline stage to see the most recent runs or events, then navigate directly to that BIMS workflow page.

> **US-04:** As an admin, I want to see today's cartridge throughput (produced, completed, rejected, yield %) and compare to yesterday and the weekly average.

> **US-05:** As an admin, I want to see which operator is running each robot right now, how long they've been running, and what step they're on.

### Operator

> **US-06:** As an operator, I want to see my robot's current run status on the dashboard so I can quickly confirm it matches the workflow page.

> **US-07:** As an operator, I want to navigate from the dashboard to my active run with one click.

> **US-08:** As an operator, I want to see how many backed cartridges are currently ready for wax filling (passed oven time) so I know if I should start a wax run now.

### Manager / Production Lead

> **US-09:** As a production manager, I want to see a weekly summary of cartridges produced, yield rate, robot utilization, and QC rejections so I can report to leadership.

> **US-10:** As a production manager, I want to see Print Barcode sheet consumption tracked so I can plan reorder timing and close the Avery 94102 traceability gap.

> **US-11:** As a production manager, I want to see any in-fridge count (wax-stored cartridges awaiting reagent filling) so I can decide whether to run reagent today.

---

## 3. Manufacturing Flow Reference

The manufacturing pipeline runs in this order. All stages produce or consume `CartridgeRecord` documents, linked through `currentPhase` field.

```
┌──────────────────────────────────────────────────────────────────────────┐
│  PRE-ROBOT PREP (feeds into backing or directly into robot)              │
│                                                                          │
│  [PRINT BARCODES]    →  barcode labels (→ WI-01 Backing)                │
│      New BIMS page       Avery 94102 sheets → printed labels            │
│                                                                          │
│  [CUT TOP SEAL]      →  thermoseal strips (→ WI-03 Reagent Filling)     │
│      /wi-02              top_seal_roll → cut strips                     │
│      LotRecord (cut_thermoseal process type)                            │
│                                                                          │
│  [LASER CUT]         →  individual backs (→ WI-01 Backing)              │
│      /laser-cutting      LaserCutBatch → ManufacturingMaterial qty      │
│                                                                          │
├──────────────────────────────────────────────────────────────────────────┤
│  BACKING                                                                  │
│                                                                          │
│  [WI-01: BACKING]    cartridge body + laser-cut back + barcode label     │
│      /wi-01          → LotRecord (processType: 'backing')               │
│                      → CartridgeRecord (currentPhase: 'backing')        │
│                      → BackingLot (placed in oven for wax curing)       │
│                                                                          │
├──────────────────────────────────────────────────────────────────────────┤
│  ROBOT AXIS (WI-02)                                                       │
│                                                                          │
│  [WI-02: WAX FILLING]  backed cartridges from oven → robot fills wax    │
│      /wax-filling        WaxFillingRun                                  │
│      Robot AVAILABLE after: cartridges on cooling tray → tray in fridge │
│      CartridgeRecord: backing → wax_filling → wax_filled → wax_stored   │
│                                                                          │
│  [WAX QC]            pull from fridge, inspect, return to fridge        │
│                      (no separate page — part of wax-filling page)      │
│                                                                          │
├──────────────────────────────────────────────────────────────────────────┤
│  ROBOT AXIS (WI-03)                                                       │
│                                                                          │
│  [WI-03: REAGENT FILLING + TOP SEAL]                                     │
│      /reagent-filling    wax-stored cartridges → robot fills reagent    │
│                          + top seal applied → inspection                │
│      Robot AVAILABLE after: cartridges removed from deck onto tray      │
│      ReagentBatchRecord                                                 │
│      CartridgeRecord: wax_stored → reagent_filled → sealed → stored    │
│                                                                          │
│  [FINAL QC / INSPECTION]  (part of reagent-filling page)               │
│                                                                          │
├──────────────────────────────────────────────────────────────────────────┤
│  POST-ROBOT (output)                                                      │
│                                                                          │
│  [STORAGE]           CartridgeRecord currentPhase: 'stored'             │
│  [RELEASED]          (future — not yet modeled)                          │
│  [SHIPPED]           ShippingLot (model exists)                         │
│                                                                          │
└──────────────────────────────────────────────────────────────────────────┘
```

### CartridgeRecord Phase Map

| `currentPhase` value | Meaning | Where set |
|---------------------|---------|-----------|
| `backing` | Backed, awaiting wax | WI-01 finishBatch |
| `wax_filling` | On robot deck for wax | wax-filling/loadDeck |
| `wax_filled` | Wax filled, in QC | wax-filling/completeQC |
| `wax_stored` | Wax QC passed, in fridge | wax-filling/recordBatchStorage |
| `reagent_filled` | Reagent filled, in inspection | reagent-filling/completeRunFilling |
| `sealed` | Top seal applied | reagent-filling/completeSealBatch |
| `stored` | Final storage | reagent-filling/recordBatchStorage |
| `voided` | Rejected at any QC | various rejection actions |

---

## 4. Feature Specifications — Pipeline Stages

Each pipeline stage is rendered as a **card node** in the visual pipeline. Every card has:
- Stage name (header)
- Current count badge (items at this stage right now)
- Status indicator (active/idle/warning)
- Link to the corresponding BIMS page
- Click-to-expand panel (see §7)

### 4.1 Print Barcodes

**Description:** Track Avery 94102 barcode sheet consumption and link printed barcodes to cartridge records.

**New BIMS page:** `/manufacturing/print-barcodes` (separate PRD spec in §5)

**Dashboard card shows:**
- Sheets in inventory (available, not yet printed)
- Sheets printed today
- Labels generated this week
- Link: `→ Print Barcodes`

**Data source:**
- New model: `BarcodeSheet` (see §9)
- Or: `GeneratedBarcode` model already exists (`generated-barcode.ts`) — check if it can be extended

**Inventory query:**
```typescript
// Count available sheets
const availableSheets = await BarcodeSheet.countDocuments({ status: 'available' });
// Count printed today
const printedToday = await BarcodeSheet.countDocuments({
  printedAt: { $gte: todayStart },
  status: { $in: ['printed', 'consumed'] }
});
```

### 4.2 Cut Top Seal (WI-02)

**Description:** Thermoseal roll → cut strips. Feeds into Reagent Filling.

**Dashboard card shows:**
- Active top seal rolls (count with remaining length)
- Strips cut today
- Most recent cut batch timestamp + operator
- Warning if no active rolls remain

**Data source:**
- `Consumable` (type: `top_seal_roll`) from `consumables` model
- `usageLog` entries where `usageType === 'cut'`
- Existing route: `/manufacturing/top-seal-cutting`

**Inventory query:**
```typescript
const activeRolls = await Consumable.find({ type: 'top_seal_roll', status: 'active' })
  .select('remainingLengthFt barcode').lean();
const stripsToday = // sum of usageLog cut entries since todayStart
```

### 4.3 Laser Cut

**Description:** Substrate sheets → individual backs. Feeds into WI-01 Backing.

**Dashboard card shows:**
- Sheets of laser-cut substrate in inventory (from `ManufacturingMaterial`)
- Individual backs available (sheets × `cartridgesPerLaserCutSheet` from `ManufacturingSettings.general`)
- Batches run this week
- Last batch timestamp + operator

**Data source:**
- `LaserCutBatch` collection — `src/routes/manufacturing/laser-cutting/+page.server.ts`
- `ManufacturingMaterial` for current substrate inventory
- `ManufacturingSettings.general.cartridgesPerLaserCutSheet` (default: 13)
- Existing route: `/manufacturing/laser-cutting`

**Inventory query:**
```typescript
const outputMaterial = await ManufacturingMaterial.findOne({
  name: { $regex: /laser.?cut|cut.?sub|substrate/i }
}).lean();
const individualBacks = (outputMaterial?.currentQuantity ?? 0) * cartridgesPerSheet;
```

### 4.4 WI-01: Backing

**Description:** Cartridge body + laser-cut back + barcode label → backed cartridge in oven.

**Dashboard card shows:**
- Lots in progress (LotRecord with processType 'backing', status 'In Progress')
- Backed cartridges completed today
- BackingLot oven status:
  - In oven: N lots (N cartridges) — show oven location if available
  - Ready: M lots (M cartridges) — elapsed > `minOvenTimeMin`, ready for wax filling
- Lots completed today

**Data source:**
- `LotRecord` (processType: 'backing') — existing route `/manufacturing/wi-01`
- `BackingLot` — `src/lib/server/db/models/backing-lot.ts`
- `ManufacturingSettings.waxFilling.minOvenTimeMin`
- `CartridgeRecord` where `currentPhase === 'backing'`

**Key computed field:**
```typescript
// "Ready for wax" = BackingLot where elapsedMin >= minOvenTimeMin
const readyForWax = backingLots.filter(bl => {
  const elapsed = (now - new Date(bl.ovenEntryTime).getTime()) / 60000;
  return elapsed >= minOvenTimeMin;
});
```

### 4.5 WI-02: Wax Filling (Robot Process)

**Description:** Backed cartridges loaded onto robot deck → wax dispensed → deck removed → cooling tray in fridge.

**Dashboard card shows (per robot):**
- Robot name + current status
- If active run: operator, stage (Setup/Loading/Running/Awaiting Removal/QC/Storage), elapsed time, cartridge count
- If idle: "Available" badge
- If blocked by reagent run: "Blocked — reagent run in progress" with link
- Cartridges currently in wax QC (wax_filled phase)
- Cartridges in fridge post-wax (wax_stored phase)

**Robot becomes FREE when:**
- Run transitions to `Awaiting Removal` status (deck removed, cartridges on cooling tray, tray placed in fridge)
- Specifically: `WaxFillingRun.status === 'Awaiting Removal'` or `'QC'` or `'Storage'` — robot is physically free even though the run record is still active

**Data source:**
- `WaxFillingRun` — active runs per robot
- `OpentronsRobot` — list of robots
- `CartridgeRecord` counts by phase for each robot's active run

**Robot availability logic:**
```typescript
// Robot is PHYSICALLY FREE (can start new run) when:
const robotPhysicallyFree = !activeRun || 
  ['Awaiting Removal', 'QC', 'Storage', 'completed', 'aborted'].includes(activeRun.status);

// Robot is LOGICALLY BLOCKED if:
const robotLogicallyBlocked = activeReagentRun !== null; // reagent run on same robot
```

### 4.6 Wax QC / Inspection

**Description:** Cartridges pulled from fridge, inspected visually, returned to fridge. Part of the wax-filling workflow.

**Dashboard card shows:**
- Cartridges pending wax QC (currentPhase: 'wax_filled', waxQc.status: 'Pending')
- Accepted today / Rejected today
- Active QC session (if any wax run is in 'QC' stage)

**Data source:**
- `CartridgeRecord` filtered by `currentPhase: 'wax_filled'`
- `WaxFillingRun` where status is 'QC'
- Navigates to: `/manufacturing/wax-filling?robot=<robotId>`

### 4.7 Fridge Storage (between Wax and Reagent)

**Description:** Wax-stored cartridges sitting in fridge, waiting for reagent filling run.

**Dashboard card shows:**
- Total cartridges in fridge (currentPhase: 'wax_stored')
- Breakdown by fridge/location if multiple fridges
- Age of oldest batch in fridge (days)
- Alert if >7 days (configurable)

**Data source:**
- `CartridgeRecord` where `currentPhase === 'wax_stored'`
- Group by `waxStorage.location`

### 4.8 WI-03: Reagent Filling + Top Seal (Robot Process)

**Description:** Wax-stored cartridges loaded → robot dispenses reagent → cartridges removed → top seal applied.

**Dashboard card shows (per robot):**
- Robot name + current status
- If active run: operator, assay type, stage (Loading/Running/Inspection/Top Sealing/Storage), elapsed time, cartridge count
- If idle: "Available" badge
- If blocked by wax run: "Blocked — wax run in progress" with link
- Active seal batches (top seal lot, count scanned)

**Robot becomes FREE when:**
- `ReagentBatchRecord.status === 'Inspection'` (cartridges removed from deck)
- Robot is physically free even during Inspection / Top Sealing / Storage stages

**Data source:**
- `ReagentBatchRecord` — active runs per robot
- `CartridgeRecord` counts by phase
- Existing route: `/manufacturing/reagent-filling?robot=<robotId>`

### 4.9 Final QC / Inspection

**Description:** Final visual inspection after top seal. Part of reagent-filling workflow.

**Dashboard card shows:**
- Cartridges pending final QC (reagent_filled, inspectionStatus: 'Pending')
- Accepted today / Rejected today / Yield %
- Active inspection session (if any reagent run is in 'Inspection' stage)

**Data source:**
- `ReagentBatchRecord.cartridgesFilled[].inspectionStatus`
- `CartridgeRecord` where `currentPhase === 'reagent_filled'`

### 4.10 Storage

**Description:** Final stored cartridges, ready for release or shipping.

**Dashboard card shows:**
- Total in final storage (currentPhase: 'stored')
- Breakdown by assay type (via `reagentFilling.assayType.name`)
- Breakdown by fridge/location
- Count per SKU (for dispatch planning)
- Sealed (top seal applied but not yet fully stored): currentPhase: 'sealed'

**Data source:**
- `CartridgeRecord` where `currentPhase === 'stored'`
- `CartridgeRecord` where `currentPhase === 'sealed'`
- Group by `reagentFilling.assayType.name`, `storage.fridgeName`

### 4.11 Shipped (Summary Only)

**Description:** Shipping lots that have been dispatched.

**Dashboard card shows:**
- Units shipped this week
- Units shipped this month
- Most recent shipment date + destination

**Data source:**
- `ShippingLot` model (`src/lib/server/db/models/shipping-lot.ts`)
- This is a summary card only; no click-to-navigate needed initially

---

## 5. Print Barcodes Page Spec

### Route
`/manufacturing/print-barcodes`

### Purpose
Track Avery 94102 barcode sheet consumption. Assign printed barcode ranges to cartridge records. Close the traceability gap between physical labels and `CartridgeRecord._id` values.

### Background
Currently, barcodes are printed from Avery 94102 sheets (30 labels per sheet, 1" × 2⅝" labels). The barcode IDs are nanoid strings matching `CartridgeRecord._id`. There is no BIMS record of:
- How many sheets are in inventory
- Which sheets were printed on which date
- Which operator printed them
- Which label ranges map to which barcode IDs

### New Data Model: `BarcodeSheetBatch`

```typescript
// src/lib/server/db/models/barcode-sheet-batch.ts
interface BarcodeSheetBatch {
  _id: string;                    // nanoid
  
  // Sheet consumption
  sheetsUsed: number;             // number of Avery 94102 sheets printed
  labelsPerSheet: number;         // 30 (hardcoded for Avery 94102)
  totalLabels: number;            // sheetsUsed × labelsPerSheet
  
  // Barcode range (the actual cartridge IDs)
  barcodeIds: string[];           // array of nanoid cartridge IDs generated
  firstBarcodeId: string;         // first ID in range
  lastBarcodeId: string;          // last ID in range
  
  // Traceability
  printedAt: Date;
  printedBy: { _id: string; username: string };
  printerName?: string;           // e.g., "Dymo LabelWriter 450"
  templateVersion?: string;       // Avery template version used
  
  // Inventory tracking
  sheetsRemainingBefore: number;  // sheets in stock before printing
  sheetsRemainingAfter: number;   // sheets in stock after printing
  
  notes?: string;
  
  // Linking (populated when labels are applied to cartridges)
  // CartridgeRecord._id = one of barcodeIds when backing is done
  status: 'printed' | 'partially_used' | 'fully_consumed';
  labelsUsed: number;             // how many of totalLabels have been applied to CartridgeRecords
  
  createdAt: Date;
  updatedAt: Date;
}
```

### New Document: `BarcodeInventory` (singleton)

```typescript
// Singleton document tracking current sheet inventory
interface BarcodeInventory {
  _id: 'default';
  avery94102SheetsOnHand: number;    // current physical count
  lastCountedAt: Date;
  lastCountedBy: { _id: string; username: string };
  alertThreshold: number;            // warn when below this (default: 5)
}
```

### Page Sections

#### Section A: Sheet Inventory

```
┌─────────────────────────────────────────────────────┐
│  AVERY 94102 SHEET INVENTORY                        │
│                                                     │
│  📦 Sheets on Hand: [42]     [Update Count]         │
│  ⚠️  Alert below: [5 sheets]                        │
│  Last counted: 2026-03-20 by jgarza                 │
│                                                     │
│  [30 labels/sheet × 42 sheets = 1,260 labels avail] │
└─────────────────────────────────────────────────────┘
```

#### Section B: Print New Batch

```
┌─────────────────────────────────────────────────────┐
│  PRINT NEW BARCODE BATCH                            │
│                                                     │
│  Sheets to print: [  3  ]  (= 90 labels)            │
│  Printer: [_________________]  (optional)           │
│  Notes:   [_________________]  (optional)           │
│                                                     │
│  [Generate Barcodes & Record Print]                 │
│                                                     │
│  ⬇ Downloads printable PDF/CSV for Avery 94102     │
└─────────────────────────────────────────────────────┘
```

**Action: `printBatch`**
1. Generate `sheetsUsed × 30` nanoid strings (these become potential `CartridgeRecord._id` values)
2. Create `BarcodeSheetBatch` record
3. Decrement `BarcodeInventory.avery94102SheetsOnHand` by `sheetsUsed`
4. Return the barcode list as a CSV download (one per line) for Avery template mail merge
5. Audit log the action

#### Section C: Recent Batches

Table of last 20 `BarcodeSheetBatch` records:
- Date, Operator, Sheets Used, Labels Generated, Labels Used, Status

#### Section D: Orphaned Barcodes Alert

Show count of `BarcodeSheetBatch.barcodeIds` entries that do NOT appear in any `CartridgeRecord._id`.
These are labels that were printed but never applied. If count > 50, show orange warning.

### Business Rules

1. **Avery 94102 only**: Sheet format is locked. 30 labels per sheet. Label size: 1" × 2⅝".
2. **Barcodes are pre-generated** at print time, not at application time. This allows offline label printing.
3. **Labels are consumed** when the barcode appears in a `BackingLot` or `CartridgeRecord._id`.
4. **Sheet inventory is manually adjusted** (no barcode scanner on inventory). The page allows manual count updates.
5. **Alert at threshold**: If `avery94102SheetsOnHand` drops below `alertThreshold` (default: 5), show prominent warning on both the Print Barcodes page and the main dashboard card.

---

## 6. Robot Center-Line Layout

### Concept

The dashboard is visually organized around the robots. The robots are the **vertical spine** of the layout. Pre-robot stages (Barcodes, Top Seal, Laser Cut, Backing) flow in from the left. Post-robot stages (QC, Storage, Shipped) flow out to the right.

```
LEFT (INPUTS)                  CENTER (ROBOTS)              RIGHT (OUTPUTS)
─────────────────             ─────────────────────        ─────────────────────
[Print Barcodes] ──────┐      ┌─── ROBOT 1 ──────────┐    ┌── Wax QC ──────────┐
                       │      │ Wax Filling            │    │  N cartridges       │
[Cut Top Seal] ─────┐  │      │ ● Running              │    │  pending QC         │
                    │  │      │ Operator: jgarza       │    └────────────────────┘
[Laser Cut] ──────┐ │  │      │ Step 3/5 · 23 min      │
                  │ │  └─────▶│ 24 cartridges           │    ┌── Fridge Storage ──┐
                  │ └────────▶│                         │    │  147 wax-stored     │
                  └──────────▶└────────────────────────┘    └────────────────────┘
                                                                      │
[WI-01 Backing] ───────────▶  ┌─── ROBOT 2 ──────────┐              ▼
  48 ready for wax             │ Reagent Filling        │    ┌── Reagent Fill ─────┐
  3 lots in oven               │ ○ Available            │    │  (via ROBOT 2/3)    │
  2 lots ready                 │                        │    └────────────────────┘
                               │ Last run: 14:32        │
                               └────────────────────────┘    ┌── Final QC ────────┐
                                                              │  N cartridges       │
                               ┌─── ROBOT 3 ──────────┐     │  pending final QC   │
                               │ ○ Available            │    └────────────────────┘
                               │                        │
                               └────────────────────────┘    ┌── Storage ─────────┐
                                                              │  287 stored         │
                                                              │  By assay type:     │
                                                              │  • TestA: 144       │
                                                              │  • TestB: 143       │
                                                              └────────────────────┘

                                                              ┌── Shipped ─────────┐
                                                              │  52 this week       │
                                                              └────────────────────┘
```

### Robot Card Design

Each robot card in the center column renders differently based on state:

**State: Available**
```
┌──────────────────────────────────────────┐
│  🤖 ROBOT 1 — Wax Filling                │
│  ─────────────────────────────────────── │
│  ✅ AVAILABLE                             │
│                                          │
│  Last run: 14:32 today (jgarza)          │
│  Last run: 24 cartridges, wax fill       │
│                                          │
│  [▶ Start Wax Run]   [▶ Start Reagent]   │
└──────────────────────────────────────────┘
```

**State: Running — Wax Fill**
```
┌──────────────────────────────────────────┐
│  🤖 ROBOT 1 — Wax Filling                │
│  ─────────────────────────────────────── │
│  🟡 RUNNING — Wax Fill                   │
│  Operator: jgarza                        │
│  Stage: Running (step 3 of 5)            │
│  Elapsed: 23 min  Est. finish: 22 min    │
│  Cartridges: 24   Lot: LOT-20260324-AB12 │
│  ─────────────────────────────────────── │
│  [→ Go to Wax Filling Page]              │
└──────────────────────────────────────────┘
```

**State: Deck Removed (Awaiting Removal / QC / Storage)**
```
┌──────────────────────────────────────────┐
│  🤖 ROBOT 1 — Wax Filling                │
│  ─────────────────────────────────────── │
│  ✅ ROBOT FREE — Deck Removed             │
│  Run still in progress: QC stage         │
│  24 cartridges in fridge for QC          │
│  ─────────────────────────────────────── │
│  ⚠️  Run cleanup needed before next run  │
│  [→ Complete Wax Run]                    │
└──────────────────────────────────────────┘
```

**State: Blocked by other process**
```
┌──────────────────────────────────────────┐
│  🤖 ROBOT 1 — Wax Filling                │
│  ─────────────────────────────────────── │
│  🔴 BLOCKED — Reagent run in progress    │
│  Reagent run must complete first         │
│  [→ View Reagent Run]                    │
└──────────────────────────────────────────┘
```

### Robot Status Priority (computed on server)

The server computes a `robotStatus` field for each robot:

| Priority | Status | Condition |
|----------|--------|-----------|
| 1 | `running_wax` | WaxFillingRun active, status in `['Setup','Loading','Running']` |
| 2 | `running_reagent` | ReagentBatchRecord active, status in `['Setup','Loading','Running']` |
| 3 | `deck_free_wax` | WaxFillingRun in `['Awaiting Removal','QC','Storage']` — robot free, run not closed |
| 4 | `deck_free_reagent` | ReagentBatchRecord in `['Inspection','Top Sealing','Storage']` |
| 5 | `blocked_by_reagent` | No wax run, but reagent run prevents wax start |
| 6 | `blocked_by_wax` | No reagent run, but wax run prevents reagent start |
| 7 | `available` | No active run on this robot |

---

## 7. Click-to-Expand Interaction Spec

### Behavior

All interaction happens via URL state (no client-side JS stores needed). When a user clicks a pipeline stage card:

1. A query parameter is added to the URL: `?expanded=<stage-id>`
2. The card expands inline (CSS grid row expand or slide-down transition)
3. The expanded panel shows detail rows
4. Each detail row has a "→ Go to [Page Name]" link
5. Clicking anywhere outside the expanded card (or clicking the card header again) collapses it

Since `.svelte` files are frozen, the expand/collapse behavior must be implemented in the existing `.svelte` component pattern or via a thin wrapper. **Developer note:** Check if the existing manufacturing dashboard page has a pattern for expanded cards. If the svelte UI is frozen, the expand behavior may need to be handled via hidden/shown `<div>` blocks driven by a data attribute or URL param passed from the server.

### Expanded Panel Content per Stage

**Print Barcodes (expanded):**
- Last 3 print batches (date, operator, sheets, labels)
- Current sheet inventory count
- → Print Barcodes Page

**Cut Top Seal (expanded):**
- Active rolls: barcode, remaining length (ft), % remaining bar
- Last 3 cuts: date, quantity, operator
- → Top Seal Cutting Page

**Laser Cut (expanded):**
- Current inventory: N sheets, N×13 individual backs
- Last 3 batches: input sheets, output backs, failures, operator
- → Laser Cutting Page

**WI-01 Backing (expanded):**
- In-progress lots (if any): lot ID, cartridge count, start time
- Oven status: table of BackingLots — lot ID, cartridge count, entry time, elapsed, ready/not-ready
- Recent completed lots today
- → Backing Page (WI-01)

**WI-02 Wax Filling (expanded):**
- Per-robot detail (collapsible sub-sections)
- Active run: all fields from robot card
- Linked backing lot
- Cartridges by QC status
- → Wax Filling Page (robot-specific URL)

**Wax QC (expanded):**
- Count: Pending / Accepted / Rejected
- If active: operator, run ID, progress
- Rejection breakdown by reason code
- → Wax Filling Page (QC stage)

**Fridge Storage (expanded):**
- Count by fridge location
- Age of oldest batch
- Ready-for-reagent count
- → Wax Filling Page (Storage stage)

**WI-03 Reagent Filling (expanded):**
- Per-robot detail
- Active run: stage, assay type, operator, elapsed
- Active seal batch: lot ID, scanned count
- → Reagent Filling Page (robot-specific URL)

**Final QC (expanded):**
- Pending / Accepted / Rejected counts
- Rejection by reason code
- → Reagent Filling Page (Inspection stage)

**Storage (expanded):**
- By assay type: count per SKU
- By fridge: count per location
- Sealed but not stored count
- → Reagent Filling Page (Storage stage)

**Shipped (expanded):**
- Recent shipments table (date, lot, destination, count)
- (No navigation — shipping has its own system)

---

## 8. Stats & Metrics Section Spec

### Layout

Two sections: **Today** (prominent) and **This Week** (compact).

### Today Section

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  TODAY'S PRODUCTION — [Date]                                    [Refresh ↺]  │
│                                                                              │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐ │
│  │ WAX RUNS     │  │ REAGENT RUNS │  │ CARTRIDGES   │  │ YIELD RATE       │ │
│  │ 3 completed  │  │ 2 completed  │  │ 144 produced │  │ 96.5%            │ │
│  │ 1 in progress│  │ 0 in progress│  │ 5 rejected   │  │ (139/144)        │ │
│  │ 0 aborted    │  │ 1 aborted    │  │ 139 accepted │  │ ↓ -1.5% vs avg   │ │
│  └──────────────┘  └──────────────┘  └──────────────┘  └──────────────────┘ │
│                                                                              │
│  ROBOT UTILIZATION TODAY                                                     │
│  Robot 1: ████████████░░░░ 73%  (6h 12m of 8h shift)                       │
│  Robot 2: ██████████░░░░░░ 58%  (4h 38m of 8h shift)                       │
│  Robot 3: ░░░░░░░░░░░░░░░░  0%  (no runs today)                             │
└──────────────────────────────────────────────────────────────────────────────┘
```

**Data queries (today):**

```typescript
const todayStart = new Date(); todayStart.setHours(0,0,0,0);

// Wax runs
const waxRunsToday = await WaxFillingRun.aggregate([
  { $match: { createdAt: { $gte: todayStart } } },
  { $group: { _id: '$status', count: { $sum: 1 } } }
]);

// Reagent runs
const reagentRunsToday = await ReagentBatchRecord.aggregate([
  { $match: { createdAt: { $gte: todayStart } } },
  { $group: { _id: '$status', count: { $sum: 1 } } }
]);

// Cartridges produced today (reagent filled today)
const producedToday = await CartridgeRecord.countDocuments({
  'reagentFilling.recordedAt': { $gte: todayStart },
  currentPhase: { $in: ['reagent_filled', 'sealed', 'stored'] }
});

// Rejected today (at any QC step)
const rejectedToday = await CartridgeRecord.countDocuments({
  currentPhase: 'voided',
  updatedAt: { $gte: todayStart }
});

// Robot utilization: sum of (runEndTime - runStartTime) per robot, today
const robotUtilization = await WaxFillingRun.aggregate([
  { $match: { createdAt: { $gte: todayStart }, runStartTime: { $exists: true } } },
  { $project: {
    robotId: '$robot._id',
    durationMs: { $subtract: [
      { $ifNull: ['$runEndTime', new Date()] },
      '$runStartTime'
    ]}
  }},
  { $group: { _id: '$robotId', totalMs: { $sum: '$durationMs' } } }
]);
```

### Weekly Section

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  THIS WEEK (Mon–Sun)                                                         │
│                                                                              │
│  Wax runs: 18    Reagent runs: 12    Cartridges produced: 864               │
│  Wax rejected: 14    Reagent rejected: 8    Weekly yield: 97.4%             │
│                                                                              │
│  Top rejections:  Wax defect (8) · Reagent defect (5) · Seal issue (4) · … │
└──────────────────────────────────────────────────────────────────────────────┘
```

### Alert Banner

Above the stats, if any condition is met, show a colored alert banner:

| Condition | Color | Message |
|-----------|-------|---------|
| Any robot running > 90 min with no status update | 🔴 Red | "Robot 1 run may be stalled — last update 94 min ago" |
| Barcode sheets below alert threshold | 🟠 Orange | "Barcode sheets low: 4 remaining (threshold: 5)" |
| No active rolls for top seal | 🟠 Orange | "No active top seal rolls — register a new roll" |
| Wax-stored cartridges > 48h old | 🟡 Yellow | "47 cartridges have been in fridge > 48h — run reagent?" |
| Robot blocked > 4h | 🟡 Yellow | "Robot 1 blocked since 08:14 — reagent run still open" |

---

## 9. Data Model Changes

### 9.1 New Model: `BarcodeSheetBatch`

**File:** `src/lib/server/db/models/barcode-sheet-batch.ts`

```typescript
import mongoose, { Schema } from 'mongoose';

const BarcodeSheetBatchSchema = new Schema({
  _id: { type: String, required: true },           // nanoid
  sheetsUsed: { type: Number, required: true },
  labelsPerSheet: { type: Number, default: 30 },   // Avery 94102 = 30 labels/sheet
  totalLabels: { type: Number, required: true },    // sheetsUsed × labelsPerSheet
  barcodeIds: [{ type: String }],                  // generated nanoid cartridge IDs
  firstBarcodeId: { type: String },
  lastBarcodeId: { type: String },
  printedAt: { type: Date, required: true },
  printedBy: {
    _id: { type: String },
    username: { type: String }
  },
  printerName: { type: String },
  templateVersion: { type: String },
  sheetsRemainingBefore: { type: Number },
  sheetsRemainingAfter: { type: Number },
  notes: { type: String },
  status: {
    type: String,
    enum: ['printed', 'partially_used', 'fully_consumed'],
    default: 'printed'
  },
  labelsUsed: { type: Number, default: 0 }
}, {
  timestamps: true,
  collection: 'barcode_sheet_batches'
});

export const BarcodeSheetBatch = mongoose.models.BarcodeSheetBatch
  || mongoose.model('BarcodeSheetBatch', BarcodeSheetBatchSchema);
```

### 9.2 New Model: `BarcodeInventory`

**File:** `src/lib/server/db/models/barcode-inventory.ts`

```typescript
const BarcodeInventorySchema = new Schema({
  _id: { type: String, default: 'default' },
  avery94102SheetsOnHand: { type: Number, default: 0 },
  lastCountedAt: { type: Date },
  lastCountedBy: {
    _id: { type: String },
    username: { type: String }
  },
  alertThreshold: { type: Number, default: 5 }
}, {
  timestamps: true,
  collection: 'barcode_inventory'
});

export const BarcodeInventory = mongoose.models.BarcodeInventory
  || mongoose.model('BarcodeInventory', BarcodeInventorySchema);
```

### 9.3 Export These Models

**File:** `src/lib/server/db/models/index.ts`

Add exports:
```typescript
export { BarcodeSheetBatch } from './barcode-sheet-batch';
export { BarcodeInventory } from './barcode-inventory';
```

### 9.4 No Changes to Existing Models

All existing models (`WaxFillingRun`, `ReagentBatchRecord`, `CartridgeRecord`, `BackingLot`, `LaserCutBatch`, `Consumable`, `LotRecord`, `OpentronsRobot`) are queried read-only by this dashboard. No schema changes required.

### 9.5 `ManufacturingSettings` — Optional Additions

Consider adding to the existing singleton:
```typescript
// ManufacturingSettings.general additions (no model change — document-level addition)
{
  "general": {
    "dashboardRefreshIntervalSec": 30,
    "waxStorageMaxAgeDays": 7,         // warn if wax-stored cartridges older than this
    "robotStallWarningMin": 90         // warn if robot run has no update in N minutes
  }
}
```
These can be added as `upsert: true` document-level fields without a schema change.

---

## 10. API / Server Load Function Design

### Route: `src/routes/manufacturing/cart-mfg-dev/+page.server.ts`

**Pattern:** Follows the established BIMS pattern — `requirePermission`, `connectDB`, parallel queries, `JSON.parse(JSON.stringify(...))` serialization.

```typescript
import { redirect } from '@sveltejs/kit';
import {
  connectDB, WaxFillingRun, ReagentBatchRecord, CartridgeRecord,
  BackingLot, LaserCutBatch, Consumable, LotRecord, ManufacturingSettings,
  OpentronsRobot, Equipment, EquipmentLocation, ShippingLot
} from '$lib/server/db';
import { BarcodeSheetBatch, BarcodeInventory } from '$lib/server/db/models/barcode-sheet-batch';
import type { PageServerLoad } from './$types';

export const config = { maxDuration: 60 };

export const load: PageServerLoad = async ({ locals }) => {
  if (!locals.user) redirect(302, '/login');
  await connectDB();

  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  
  const weekStart = new Date(todayStart);
  weekStart.setDate(weekStart.getDate() - weekStart.getDay()); // Sunday

  // --- Phase 1: Fast parallel queries ---
  const [
    robots,
    settingsDoc,
    activeWaxRuns,
    activeReagentRuns,
    backingLots,
    barcodeInventory
  ] = await Promise.all([
    OpentronsRobot.find({}, { _id: 1, name: 1 }).lean(),
    ManufacturingSettings.findById('default').lean(),
    WaxFillingRun.find({
      status: { $nin: ['completed', 'aborted', 'cancelled', 'voided',
                        'Completed', 'Aborted', 'Cancelled', 'Voided'] }
    }).lean(),
    ReagentBatchRecord.find({
      status: { $nin: ['completed', 'aborted', 'cancelled', 'voided',
                        'Completed', 'Aborted', 'Cancelled'] }
    }).lean(),
    BackingLot.find({ status: { $in: ['in_oven', 'ready', 'created'] } })
      .sort({ ovenEntryTime: -1 }).lean(),
    BarcodeInventory.findById('default').lean()
  ]);

  const minOvenTimeMin: number = (settingsDoc as any)?.waxFilling?.minOvenTimeMin ?? 60;
  const now = Date.now();

  // --- Phase 2: Phase counts (one aggregate) ---
  const phaseCounts = await CartridgeRecord.aggregate([
    { $group: { _id: '$currentPhase', count: { $sum: 1 } } }
  ]);
  const phaseMap = new Map<string, number>(
    phaseCounts.map((p: any) => [p._id ?? 'unknown', p.count])
  );

  // --- Phase 3: Today's stats ---
  const [waxRunsToday, reagentRunsToday, rejectedToday, shippedThisWeek] = await Promise.all([
    WaxFillingRun.aggregate([
      { $match: { createdAt: { $gte: todayStart } } },
      { $group: { _id: '$status', count: { $sum: 1 } } }
    ]),
    ReagentBatchRecord.aggregate([
      { $match: { createdAt: { $gte: todayStart } } },
      { $group: { _id: '$status', count: { $sum: 1 } } }
    ]),
    CartridgeRecord.countDocuments({
      currentPhase: 'voided',
      updatedAt: { $gte: todayStart }
    }),
    // ShippingLot if model is available
    null // placeholder — implement when ShippingLot is confirmed
  ]);

  // --- Phase 4: Laser cut inventory ---
  const [laserCutMaterial, recentLaserBatch] = await Promise.all([
    (await import('$lib/server/db')).ManufacturingMaterial.findOne({
      name: { $regex: /laser.?cut|cut.?sub|substrate/i }
    }).lean(),
    LaserCutBatch.findOne().sort({ createdAt: -1 }).lean()
  ]);

  const cartridgesPerSheet: number = (settingsDoc as any)?.general?.cartridgesPerLaserCutSheet ?? 13;
  const laserCutSheets: number = (laserCutMaterial as any)?.currentQuantity ?? 0;
  const individualBacks: number = laserCutSheets * cartridgesPerSheet;

  // --- Phase 5: Top seal rolls ---
  const topSealRolls = await Consumable.find({ type: 'top_seal_roll', status: 'active' })
    .select('_id barcode remainingLengthFt initialLengthFt').lean();

  // --- Phase 6: Barcode print batches ---
  const recentBarcodeBatches = await BarcodeSheetBatch.find()
    .sort({ printedAt: -1 }).limit(5).lean();

  // --- Phase 7: Backing lots with oven status ---
  const enrichedBackingLots = (backingLots as any[]).map((bl: any) => {
    const entryMs = bl.ovenEntryTime ? new Date(bl.ovenEntryTime).getTime() : 0;
    const elapsedMin = entryMs ? (now - entryMs) / 60000 : 0;
    return {
      lotId: String(bl._id),
      cartridgeCount: bl.cartridgeCount ?? 0,
      status: bl.status ?? 'in_oven',
      ovenLocationName: bl.ovenLocationName ?? null,
      elapsedMin: Math.floor(elapsedMin),
      remainingMin: Math.max(0, Math.ceil(minOvenTimeMin - elapsedMin)),
      isReady: elapsedMin >= minOvenTimeMin,
      operatorUsername: bl.operator?.username ?? null
    };
  });

  // --- Phase 8: Robot status computation ---
  const robotStatuses = (robots as any[]).map((robot: any) => {
    const robotId = String(robot._id);
    const waxRun = (activeWaxRuns as any[]).find(r => String(r.robot?._id) === robotId);
    const reagentRun = (activeReagentRuns as any[]).find(r => String(r.robot?._id) === robotId);

    const WAX_ACTIVE = ['Setup', 'Loading', 'Running', 'setup', 'loading', 'running'];
    const WAX_DECK_FREE = ['Awaiting Removal', 'QC', 'Storage', 'awaiting_removal', 'qc', 'storage'];
    const REAGENT_ACTIVE = ['Setup', 'Loading', 'Running', 'setup', 'loading', 'running'];
    const REAGENT_DECK_FREE = ['Inspection', 'Top Sealing', 'Storage'];

    let status: string;
    let displayStatus: string;
    let robotPhysicallyFree: boolean;

    if (waxRun && WAX_ACTIVE.includes(waxRun.status)) {
      status = 'running_wax';
      displayStatus = `Running — Wax Fill (${waxRun.status})`;
      robotPhysicallyFree = false;
    } else if (reagentRun && REAGENT_ACTIVE.includes(reagentRun.status)) {
      status = 'running_reagent';
      displayStatus = `Running — Reagent Fill (${reagentRun.status})`;
      robotPhysicallyFree = false;
    } else if (waxRun && WAX_DECK_FREE.includes(waxRun.status)) {
      status = 'deck_free_wax';
      displayStatus = `Robot Free — Wax run: ${waxRun.status}`;
      robotPhysicallyFree = true;
    } else if (reagentRun && REAGENT_DECK_FREE.includes(reagentRun.status)) {
      status = 'deck_free_reagent';
      displayStatus = `Robot Free — Reagent run: ${reagentRun.status}`;
      robotPhysicallyFree = true;
    } else {
      status = 'available';
      displayStatus = 'Available';
      robotPhysicallyFree = true;
    }

    const runStartTime = waxRun?.runStartTime ?? reagentRun?.runStartTime;
    const elapsedMs = runStartTime ? now - new Date(runStartTime).getTime() : 0;

    return {
      robotId,
      name: robot.name ?? robotId,
      status,
      displayStatus,
      robotPhysicallyFree,
      activeWaxRun: waxRun ? {
        runId: String(waxRun._id),
        stage: waxRun.status,
        operatorUsername: waxRun.operator?.username ?? null,
        cartridgeCount: waxRun.cartridgeIds?.length ?? waxRun.plannedCartridgeCount ?? 0,
        elapsedMin: Math.floor(elapsedMs / 60000),
        runStartTime: waxRun.runStartTime ? new Date(waxRun.runStartTime).toISOString() : null,
        waxSourceLot: waxRun.waxSourceLot ?? null
      } : null,
      activeReagentRun: reagentRun ? {
        runId: String(reagentRun._id),
        stage: reagentRun.status,
        operatorUsername: reagentRun.operator?.username ?? null,
        assayTypeName: reagentRun.assayType?.name ?? null,
        cartridgeCount: reagentRun.cartridgeCount ?? reagentRun.cartridgesFilled?.length ?? 0,
        elapsedMin: Math.floor(elapsedMs / 60000),
        runStartTime: reagentRun.runStartTime ? new Date(reagentRun.runStartTime).toISOString() : null
      } : null
    };
  });

  // --- Serialize and return ---
  return JSON.parse(JSON.stringify({
    robots: robotStatuses,
    pipeline: {
      // Pre-robot prep
      printBarcodes: {
        sheetsOnHand: (barcodeInventory as any)?.avery94102SheetsOnHand ?? 0,
        alertThreshold: (barcodeInventory as any)?.alertThreshold ?? 5,
        recentBatches: recentBarcodeBatches
      },
      topSeal: {
        activeRolls: topSealRolls,
        stripsAvailableApprox: (topSealRolls as any[]).reduce(
          (sum: number, r: any) => sum + Math.floor((r.remainingLengthFt ?? 0) / 0.5), 0
        )
      },
      laserCut: {
        sheetsOnHand: laserCutSheets,
        individualBacks,
        recentBatchAt: recentLaserBatch ? new Date((recentLaserBatch as any).createdAt).toISOString() : null
      },
      backing: {
        inProgressLots: enrichedBackingLots.filter(bl => !bl.isReady),
        readyLots: enrichedBackingLots.filter(bl => bl.isReady),
        totalReadyCartridges: enrichedBackingLots
          .filter(bl => bl.isReady)
          .reduce((s, bl) => s + bl.cartridgeCount, 0),
        backedTotal: phaseMap.get('backing') ?? 0
      },
      // Robot stages
      waxFilling: {
        inProgress: phaseMap.get('wax_filling') ?? 0,
        waxFilled: phaseMap.get('wax_filled') ?? 0,
        waxStored: phaseMap.get('wax_stored') ?? 0
      },
      reagentFilling: {
        inProgress: phaseMap.get('reagent_filling') ?? 0,
        reagentFilled: phaseMap.get('reagent_filled') ?? 0,
        sealed: phaseMap.get('sealed') ?? 0
      },
      // Post-robot
      storage: {
        stored: phaseMap.get('stored') ?? 0,
        voided: phaseMap.get('voided') ?? 0
      }
    },
    todayStats: {
      waxRuns: waxRunsToday,
      reagentRuns: reagentRunsToday,
      rejectedToday
    },
    minOvenTimeMin
  }));
};
```

### Sub-routes Needed

| Path | Purpose |
|------|---------|
| `/manufacturing/cart-mfg-dev/+page.server.ts` | Main dashboard load (above) |
| `/manufacturing/cart-mfg-dev/+page.svelte` | Dashboard UI (new file — not frozen) |
| `/manufacturing/print-barcodes/+page.server.ts` | Print Barcodes load + actions |
| `/manufacturing/print-barcodes/+page.svelte` | Print Barcodes UI |
| `/api/manufacturing/dashboard` | Optional API endpoint for polling refresh |

---

## 11. UI Wireframe Description

### Full-Page Layout (Desktop)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  BIMS  /  Manufacturing  /  CART MFG In DEVELOPMENT          [↺ 30s refresh]│
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  🚨 ALERT: Barcode sheets low (4 remaining, threshold 5) [Reorder]         │
│                                                                             │
├──────────────────────────────────────────────────────────────────────────── │
│  TODAY'S PRODUCTION                                                         │
│  [Wax Runs: 3 done, 1 active] [Reagent Runs: 2 done] [Produced: 96] [98%] │
├──────────────────────────────────────────────────────────────────────────── │
│                                                                             │
│  PIPELINE                                                                   │
│                                                                             │
│  LEFT COLUMN        │   CENTER COLUMN (ROBOTS)     │  RIGHT COLUMN         │
│  ─────────────────  │   ──────────────────────     │  ──────────────────── │
│                     │                              │                       │
│  [Print Barcodes]   │   ╔══════════════════════╗   │  [Wax QC]             │
│  4 sheets on hand   │   ║ 🤖 ROBOT 1           ║   │  12 pending QC       │
│  (!) Low stock      │   ║ 🟡 RUNNING — Wax      ║   │  → Wax Filling       │
│  → Print Barcodes   │   ║ jgarza · 23 min       ║   │                       │
│                     │   ║ 24 cartridges          ║   │  [Fridge Storage]    │
│  [Cut Top Seal]     │   ║ → Go to Wax Filling   ║   │  147 wax-stored      │
│  2 active rolls     │   ╚══════════════════════╝   │  Oldest: 1.4 days    │
│  → Top Seal Cutting │                              │                       │
│                     │   ╔══════════════════════╗   │                       │
│  [Laser Cut]        │   ║ 🤖 ROBOT 2           ║   │  [Final QC]          │
│  8 sheets on hand   │   ║ ✅ AVAILABLE           ║   │  0 pending final QC  │
│  104 ind. backs     │   ║ Last: 14:32 jgarza    ║   │                       │
│  → Laser Cutting    │   ╚══════════════════════╝   │  [Storage]           │
│                     │                              │  287 stored           │
│  [WI-01 Backing]    │   ╔══════════════════════╗   │  TestA: 144           │
│  48 backed ready    │   ║ 🤖 ROBOT 3           ║   │  TestB: 143           │
│  2 lots in oven     │   ║ ✅ AVAILABLE           ║   │  → Reagent Filling    │
│  → Backing WI-01    │   ╚══════════════════════╝   │                       │
│                     │                              │  [Shipped]           │
│                     │   ╔══════════════════════╗   │  52 this week         │
│                     │   ║ 🤖 ROBOT 2/3         ║   │                       │
│                     │   ║ Reagent Filling       ║   │                       │
│                     │   ╚══════════════════════╝   │                       │
│                                                                             │
├──────────────────────────────────────────────────────────────────────────── │
│  THIS WEEK                                                                  │
│  Wax runs: 18 · Reagent runs: 12 · Produced: 864 · Yield: 97.4%           │
│  Top rejections: Wax defect (8) · Reagent defect (5) · Seal issue (4)      │
└──────────────────────────────────────────────────────────────────────────── │
```

### Mobile Layout (Stacked)

On mobile, the three-column layout collapses to a single column:
1. Alert banners
2. Today's stats (compact — 2×2 grid)
3. Pre-robot cards (Print Barcodes, Cut Top Seal, Laser Cut, Backing)
4. Robot cards (full width, tall)
5. Post-robot cards (Wax QC, Fridge Storage, Final QC, Storage, Shipped)
6. Weekly summary

### Color Coding

| Status | Color | Tailwind class |
|--------|-------|---------------|
| Running | Amber/yellow | `bg-amber-50 border-amber-300` |
| Available | Green | `bg-green-50 border-green-300` |
| Robot free (run not closed) | Blue | `bg-blue-50 border-blue-300` |
| Blocked | Red | `bg-red-50 border-red-300` |
| Warning | Orange | `bg-orange-50 border-orange-300` |
| No activity | Gray | `bg-gray-50 border-gray-200` |

### Stage Card Template

Each pipeline stage card follows this Tailwind pattern:
```html
<div class="rounded-lg border-2 p-4 cursor-pointer {statusColorClass}">
  <div class="flex justify-between items-center">
    <h3 class="font-semibold text-sm uppercase tracking-wide">{stage.name}</h3>
    <span class="text-xs px-2 py-0.5 rounded-full {badgeClass}">{count}</span>
  </div>
  <div class="mt-2 text-sm text-gray-600">{statusLine}</div>
  <div class="mt-2">
    <a href="{stage.href}" class="text-xs text-blue-600 hover:underline">→ {stage.linkText}</a>
  </div>
  <!-- Expanded panel (conditionally shown) -->
  {#if expanded}
    <div class="mt-3 pt-3 border-t border-gray-200">
      <!-- detail rows -->
    </div>
  {/if}
</div>
```

---

## 12. Implementation Stories

Stories are ordered by dependency. Each story is independently shippable.

---

### Story 1 — Scaffold Route + Basic Load Function
**Size:** S (2–3 hours)  
**Depends on:** Nothing  

**Description:**  
Create the new route at `/manufacturing/cart-mfg-dev`. Wire up a `+page.server.ts` that:
1. Checks auth (`if (!locals.user) redirect(302, '/login')`)
2. Calls `connectDB()`
3. Fetches `OpentronsRobot` list, `ManufacturingSettings`, and all `CartridgeRecord` phase counts (aggregate)
4. Returns the data stub
5. Creates a `+page.svelte` with a minimal heading and a JSON dump of the returned data for dev inspection

**Files to create:**
- `src/routes/manufacturing/cart-mfg-dev/+page.server.ts`
- `src/routes/manufacturing/cart-mfg-dev/+page.svelte`

**Acceptance criteria:**
- Route loads without error
- Auth redirect works for unauthenticated users
- Phase counts appear in page data
- `npm run check` passes

---

### Story 2 — New Data Models: BarcodeSheetBatch + BarcodeInventory
**Size:** S (2–3 hours)  
**Depends on:** Story 1  

**Description:**  
Create two new Mongoose models as specified in §9.

**Files to create:**
- `src/lib/server/db/models/barcode-sheet-batch.ts`
- `src/lib/server/db/models/barcode-inventory.ts`

**File to modify:**
- `src/lib/server/db/models/index.ts` — add exports for both new models

**Acceptance criteria:**
- Models export correctly
- `npm run check` passes (TypeScript strict)
- Seeding script can insert a `BarcodeInventory` singleton

---

### Story 3 — Robot Status Computation
**Size:** M (4–5 hours)  
**Depends on:** Story 1  

**Description:**  
Expand the `+page.server.ts` load function to:
1. Fetch all active `WaxFillingRun` and `ReagentBatchRecord` (non-terminal statuses)
2. Compute `robotStatus` for each robot using the priority table in §6
3. Compute `elapsedMin` for each active run
4. Return the `robots` array as specified in §10

**Key logic (reference §6 Robot availability logic):**
- Wax run in `['Setup','Loading','Running']` → `running_wax`, robot physically blocked
- Wax run in `['Awaiting Removal','QC','Storage']` → `deck_free_wax`, robot physically free
- Reagent run in `['Setup','Loading','Running']` → `running_reagent`
- Reagent run in `['Inspection','Top Sealing','Storage']` → `deck_free_reagent`

**Acceptance criteria:**
- Each robot in returned data has `status`, `displayStatus`, `robotPhysicallyFree`
- Active wax run returns `activeWaxRun` object with `operatorUsername`, `elapsedMin`, `stage`, `cartridgeCount`
- Active reagent run returns `activeReagentRun` with `assayTypeName`
- When no active run: `status === 'available'`, both active run fields are null
- `npm run check` passes

---

### Story 4 — Pipeline Inventory Counts
**Size:** M (4–5 hours)  
**Depends on:** Story 1, Story 2  

**Description:**  
Expand the load function to fetch all pipeline stage inventory counts:
1. **Print Barcodes:** `BarcodeInventory.avery94102SheetsOnHand`
2. **Top Seal:** Active `Consumable` (type: `top_seal_roll`) remaining length
3. **Laser Cut:** `ManufacturingMaterial` substrate quantity × `cartridgesPerSheet`
4. **Backing:** `BackingLot` oven status — ready vs. in-oven, count of backed cartridges waiting
5. **Wax / Reagent stages:** Phase map from `CartridgeRecord` aggregate (Story 1 already does this)

**Acceptance criteria:**
- `pipeline.printBarcodes.sheetsOnHand` is a number
- `pipeline.topSeal.activeRolls` is an array of roll objects
- `pipeline.laserCut.individualBacks` is computed from material × multiplier
- `pipeline.backing.readyLots` has all lots where `isReady === true`
- `pipeline.backing.totalReadyCartridges` is summed correctly

---

### Story 5 — Today's Stats Queries
**Size:** M (3–4 hours)  
**Depends on:** Story 1  

**Description:**  
Add today's production stats to the load function:
1. Wax runs today: count by status (completed, in progress, aborted)
2. Reagent runs today: count by status
3. Cartridges produced today (reagent filled since todayStart)
4. Cartridges rejected today (voided since todayStart)
5. Yield % calculation
6. Robot utilization: sum of run durations per robot today (use `runStartTime`, `runEndTime` or `now`)

**Acceptance criteria:**
- `todayStats.waxRuns` is an array of `{_id: status, count: N}`
- `todayStats.reagentRuns` same shape
- `todayStats.producedToday` is a number
- `todayStats.rejectedToday` is a number
- `todayStats.yieldPercent` is calculated: `(produced - rejected) / produced × 100`
- All null-safe (works even if no runs today)

---

### Story 6 — Dashboard UI: Three-Column Layout
**Size:** L (6–8 hours)  
**Depends on:** Stories 3, 4, 5  

**Description:**  
Build the `+page.svelte` UI with:
1. Page header with refresh indicator
2. Alert banner row (barcode stock low, stale fridge batches, etc.)
3. Three-column grid: Left (pre-robot) / Center (robots) / Right (post-robot)
4. Each pipeline stage rendered as a basic card (name, count badge, status line, link)
5. Robot cards with full status rendering (all states from §6)
6. Today's stats bar (compact 4-up design)
7. Weekly summary footer

**Tailwind classes follow existing BIMS patterns.** Use `grid grid-cols-3 gap-4` for the main layout. Robots column uses `flex flex-col gap-4`.

**No interactivity yet** (expand behavior comes in Story 7).

**Acceptance criteria:**
- Page renders all pipeline nodes
- Robot cards show correct status text and color for each state
- Count badges show correct numbers from server data
- Links navigate to correct existing routes
- Mobile layout (single column) via `sm:grid-cols-1 lg:grid-cols-3`
- `npm run check` passes

---

### Story 7 — Click-to-Expand Interaction
**Size:** M (4–5 hours)  
**Depends on:** Story 6  

**Description:**  
Implement inline expand/collapse for each pipeline card:
1. Clicking a card header toggles a local Svelte state variable (or URL param `?expanded=<stageId>`)
2. The expanded panel slides open (CSS transition)
3. Shows the detail rows per stage (per spec in §7)
4. Each detail row has a `→ Navigate` link
5. Clicking outside or clicking the header again collapses

**Use Svelte 5 `$state` rune for local toggle state** — no need to round-trip to the server for expand/collapse.

**Acceptance criteria:**
- Each card expands/collapses on click
- Expanded content shows correct detail (recent batches, oven status, etc.)
- Navigation links are correct
- Only one card expanded at a time (collapse others on open)
- Keyboard accessible (Enter/Space on focused card)

---

### Story 8 — Print Barcodes Page: Server + UI
**Size:** L (8–10 hours)  
**Depends on:** Story 2  

**Description:**  
Build the full `/manufacturing/print-barcodes` page:

**`+page.server.ts` actions:**

`updateInventoryCount` action:
- Accepts `sheetsOnHand` (number), `notes`
- Upserts `BarcodeInventory` singleton
- Audit logs the change

`printBatch` action:
- Accepts `sheetsUsed` (number), `printerName` (optional), `notes` (optional)
- Generates `sheetsUsed × 30` nanoid strings (these are candidate `CartridgeRecord._id` values)
- Creates `BarcodeSheetBatch` document
- Decrements `BarcodeInventory.avery94102SheetsOnHand`
- Returns the barcode list as a JSON array (page renders a CSV download link)
- Audit logs the print event

**`+page.svelte` sections:**
- Section A: Sheet inventory with update form
- Section B: Print batch form
- Section C: Recent batches table
- Section D: Orphaned barcodes count (query: barcodeIds not in CartridgeRecord._id)

**Avery 94102 CSV format:**
```
barcode_id
XYZ123abc
ABC456def
...
```
One ID per row. Operator imports into Avery Design & Print or Word mail merge.

**Acceptance criteria:**
- `updateInventoryCount` action saves correctly, audit logged
- `printBatch` action generates correct number of barcodes (sheets × 30)
- `BarcodeSheetBatch` record created with all fields
- `BarcodeInventory` decremented
- CSV download link renders barcodes one per line
- Orphaned count shows correctly (barcodeIds not yet in CartridgeRecord)
- `npm run check` passes

---

### Story 9 — Alert System
**Size:** S (2–3 hours)  
**Depends on:** Story 6  

**Description:**  
Add the alert banner computation to the load function and render alerts in the UI:

1. **Barcode sheet low:** `sheetsOnHand < alertThreshold`
2. **No active top seal rolls:** `topSealRolls.length === 0`
3. **Wax-stored cartridges aging:** Find oldest `wax_stored` cartridge — if `waxStorage.timestamp` > `waxStorageMaxAgeDays` (default: 7), show warning
4. **Robot run stalled:** Any `WaxFillingRun` or `ReagentBatchRecord` in active status where `updatedAt` is > `robotStallWarningMin` (default: 90 min) ago

**Server query for aging:**
```typescript
const oldestWaxStored = await CartridgeRecord.findOne(
  { currentPhase: 'wax_stored' },
  { 'waxStorage.timestamp': 1 }
).sort({ 'waxStorage.timestamp': 1 }).lean();
```

**Acceptance criteria:**
- Alerts appear correctly when conditions are met
- Alerts are absent when conditions are not met
- Each alert has a dismiss option (session-scoped, no DB write)

---

### Story 10 — Weekly Stats
**Size:** S (2–3 hours)  
**Depends on:** Story 5  

**Description:**  
Add weekly stats to the load function:
1. Wax runs this week (count by status)
2. Reagent runs this week
3. Cartridges produced this week
4. Rejection breakdown by `waxQc.rejectionReason` and `reagentInspection.reason`
5. Top 3 rejection reasons

**Queries:**
```typescript
const weekStart = new Date(); // compute Monday of current week
weekStart.setDate(weekStart.getDate() - ((weekStart.getDay() + 6) % 7));
weekStart.setHours(0, 0, 0, 0);

const waxRejectReasons = await CartridgeRecord.aggregate([
  { $match: {
    currentPhase: 'voided',
    'waxQc.recordedAt': { $gte: weekStart }
  }},
  { $group: { _id: '$waxQc.rejectionReason', count: { $sum: 1 } } },
  { $sort: { count: -1 } },
  { $limit: 5 }
]);
```

**Acceptance criteria:**
- Weekly summary footer renders with correct data
- Rejection breakdown shows top 3 reasons with counts
- `npm run check` passes

---

### Story 11 — Performance Optimization: Caching + Selective Refresh
**Size:** M (3–4 hours)  
**Depends on:** Story 6  

**Description:**  
The main load function runs ~12 MongoDB queries. Optimize for production:

1. **Create an API endpoint** `/api/manufacturing/dashboard` that returns the same data shape as the page load function. This allows the page to auto-refresh every 30s via `fetch` without a full page reload.

2. **Lazy-load the detailed data** — initial page load returns robot statuses and top-level phase counts. Clicking a card triggers a targeted query for that card's expanded detail (via a sub-endpoint or URL param that the load function can use to selectively query).

3. **Add lean selects** to all queries — never load full Mongoose documents. Always use `.select()` to fetch only needed fields.

**Acceptance criteria:**
- Dashboard page has a `[↺ Refresh]` button that refetches data without full reload
- Auto-refreshes every 30s (configurable via `ManufacturingSettings.general.dashboardRefreshIntervalSec`)
- No query fetches more fields than needed

---

### Story 12 — Barcode Consumption Tracking: Link Batches to CartridgeRecords
**Size:** M (4–5 hours)  
**Depends on:** Story 8  

**Description:**  
When a barcode from a `BarcodeSheetBatch` is applied to a `CartridgeRecord` (i.e., the cartridge ID appears in the batch's `barcodeIds`), update the batch's `labelsUsed` count and `status`.

**Approach:**
- Add a MongoDB change watch or a scheduled job that runs `BarcodeSheetBatch.aggregate` to count matches against `CartridgeRecord._id`
- Simpler approach: Compute orphaned count at query time (already done in Story 8 Section D)
- For `labelsUsed` tracking, run an update nightly or on each backing lot completion:

```typescript
// Called after WI-01 finishBatch creates CartridgeRecords
async function updateBarcodeConsumption(newCartridgeIds: string[]) {
  for (const cid of newCartridgeIds) {
    await BarcodeSheetBatch.updateOne(
      { barcodeIds: cid },
      { $inc: { labelsUsed: 1 } }
    );
  }
  // Update status field
  await BarcodeSheetBatch.updateMany(
    { $expr: { $eq: ['$labelsUsed', '$totalLabels'] } },
    { $set: { status: 'fully_consumed' } }
  );
  await BarcodeSheetBatch.updateMany(
    { $expr: { $and: [
      { $gt: ['$labelsUsed', 0] },
      { $lt: ['$labelsUsed', '$totalLabels'] }
    ]}},
    { $set: { status: 'partially_used' } }
  );
}
```

**Where to call this:** After `WI-01/finishBatch` creates CartridgeRecords, call `updateBarcodeConsumption`. This could be a server utility in `src/lib/server/services/barcode-consumption.ts`.

**Acceptance criteria:**
- After a backing batch is finished, `BarcodeSheetBatch.labelsUsed` increments correctly
- `status` transitions: `printed` → `partially_used` → `fully_consumed`
- Orphaned count on Print Barcodes page is accurate

---

## 13. Dependencies & Risks

### Dependencies

| Dependency | Type | Notes |
|------------|------|-------|
| `OpentronsRobot` model | Existing | Must have at least one robot configured in DB |
| `WaxFillingRun` model | Existing | `src/lib/server/db/models/wax-filling-run.ts` |
| `ReagentBatchRecord` model | Existing | `src/lib/server/db/models/reagent-batch-record.ts` |
| `BackingLot` model | Existing | `src/lib/server/db/models/backing-lot.ts` |
| `CartridgeRecord` model | Existing | Core model — aggregate query |
| `LaserCutBatch` model | Existing | `src/lib/server/db/models/laser-cut-batch.ts` |
| `Consumable` model | Existing | For top seal rolls |
| `ManufacturingMaterial` model | Existing | For laser cut substrate quantity |
| `ManufacturingSettings` model | Existing | For config values |
| `ShippingLot` model | Existing | `src/lib/server/db/models/shipping-lot.ts` — verify schema |
| New `BarcodeSheetBatch` model | New — Story 2 | Must be created before Story 4/8 |
| New `BarcodeInventory` model | New — Story 2 | Must be created before Story 4/8 |
| `.svelte` files not frozen | Constraint | New `.svelte` files can be created; existing ones cannot be modified |

### Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|-----------|
| Robot status mismatch between dashboard and workflow page | Medium | High | Dashboard is read-only; workflow pages are authoritative. Add "last updated" timestamp to each robot card. |
| Phase count aggregate is slow on large CartridgeRecord collections | Low | Medium | Add index on `currentPhase`. Query is a single `$group` aggregate — fast even at 10k docs. |
| `ManufacturingMaterial` substrate quantity not updated in real time | Medium | Medium | This is a known limitation of the existing laser-cutting page. Dashboard shows same data as laser-cutting page. |
| Barcode IDs pre-generated but never applied (orphan accumulation) | Low | Low | Orphaned count alert on Print Barcodes page. Dashboard card shows alert if > 50 orphaned. |
| Multiple robots share same DB (no per-robot namespace) | Low | Medium | Robot queries always filter by `robot._id`. Ensure `OpentronsRobot` has stable IDs. |
| `ShippingLot` model schema unknown | Low | Low | Story 11 skips shipping detail until schema confirmed. Dashboard card shows "Coming soon" if ShippingLot is unavailable. |
| Dashboard load function runs 12+ queries per page load | Medium | Medium | Story 11 adds API endpoint + client-side polling so full page reload is infrequent. |

---

## 14. Future Enhancements

These are explicitly out of scope for the initial implementation but should be tracked for future sprints.

### FE-01: Real-Time WebSocket Updates

Replace the 30s polling pattern with a WebSocket or Server-Sent Events feed. When a robot run changes status, push an update to all connected dashboard clients instantly. High value for floor supervision.

### FE-02: Shift Planning / Robot Scheduling

Add a "Plan next run" modal from the robot card. Operator selects: which robot, wax or reagent, target cartridge count. System suggests: are there enough backed cartridges ready? Is the fridge count sufficient for reagent? This is a planning assist, not enforcement.

### FE-03: Historical Throughput Charts

A "History" tab on the dashboard showing 30-day charts of:
- Cartridges produced per day
- Yield % per day
- Robot utilization per day

Built with server-side aggregation and a chart library (e.g., Chart.js or D3 via CDN).

### FE-04: Operator Assignment Board

Visual board showing which operators are assigned to which robots today. Operators can "check in" to a robot from the dashboard. Useful for shift tracking and accountability.

### FE-05: QC Defect Trend Analysis

Auto-detect emerging defect patterns: "Wax defect rejection rate elevated on Robot 2 (8% vs 2% baseline)." Surface on the dashboard as a soft alert with link to QC history.

### FE-06: Avery Template PDF Generation

Instead of a CSV download, generate a pre-formatted PDF that matches the Avery 94102 template exactly — ready to print. Use a server-side PDF library (e.g., `pdfkit` or `puppeteer`).

### FE-07: Consumable Low-Stock Alerts via Notification

Integrate alert conditions (barcode low, no top seal rolls) with the existing notification system (Telegram / email). Operators don't need to be looking at the dashboard for these to surface.

### FE-08: Lot Genealogy Trace from Dashboard

From any pipeline card, click a specific cartridge or lot ID to see its full genealogy: which barcode sheet, which backing lot, which wax run, which oven, which fridge, which reagent run, which top seal batch. Full vertical trace in one view.

### FE-09: Released / Shipped Stage

Add "Released" stage between Storage and Shipped. A supervisor marks a batch of stored cartridges as "released for shipment" — creating a formal handoff record. Links to `ShippingLot` model which already exists in the schema.

### FE-10: Dashboard Permissions / Roles

Currently this is an admin-visible page. Consider two permission tiers:
- **Operator view:** Robot status + own active run + link to workflow page
- **Admin view:** Full pipeline + stats + all robots

Implement via `requirePermission(event, 'manufacturing:dashboard:read')` and `requirePermission(event, 'manufacturing:dashboard:admin')`.

---

## Appendix A: Existing Routes Reference

| Dashboard Section | Existing Route | Model |
|------------------|---------------|-------|
| Print Barcodes | `/manufacturing/print-barcodes` (new) | `BarcodeSheetBatch`, `BarcodeInventory` |
| Cut Top Seal | `/manufacturing/top-seal-cutting` | `Consumable` (type: top_seal_roll) |
| Laser Cut | `/manufacturing/laser-cutting` | `LaserCutBatch`, `ManufacturingMaterial` |
| WI-01 Backing | `/manufacturing/wi-01` | `LotRecord` (processType: backing), `BackingLot` |
| WI-02 Wax Filling | `/manufacturing/wax-filling?robot=<id>` | `WaxFillingRun` |
| WI-03 Reagent Filling | `/manufacturing/reagent-filling?robot=<id>` | `ReagentBatchRecord` |
| Consumables/Pipeline | `/manufacturing/consumables` | Multiple (overview) |

## Appendix B: Key ManufacturingSettings Fields Used

| Path | Default | Used By |
|------|---------|---------|
| `waxFilling.minOvenTimeMin` | 60 | Backing oven readiness |
| `waxFilling.runDurationMin` | 45 | Estimated run time display |
| `general.cartridgesPerLaserCutSheet` | 13 | Laser cut individual backs calc |
| `general.topSealLengthPerCutFt` | 0.5 | Top seal strips estimate |
| `general.dashboardRefreshIntervalSec` | 30 | Auto-refresh interval (new) |
| `general.waxStorageMaxAgeDays` | 7 | Fridge aging alert (new) |
| `general.robotStallWarningMin` | 90 | Robot stall alert (new) |

## Appendix C: CartridgeRecord Phase Flow

```
(none) → backing → wax_filling → wax_filled → wax_stored 
                                                    ↓
                              reagent_filled ←───────
                                    ↓
                                 sealed
                                    ↓
                                 stored
                                    
Any stage → voided (rejection)
```

---

*End of PRD: CART-MFG-DASHBOARD.md*  
*Revision 1.0 — 2026-03-24*
