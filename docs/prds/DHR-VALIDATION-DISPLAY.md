# PRD: Device History Record (DHR) — Validation Results Display

**Author:** Alejandro Valdez (via Agent001)
**Date:** 2026-03-31
**Status:** Draft
**Priority:** P1 — Critical for QC traceability
**Branch:** `feature/dhr-validation-display` (branch from `feature/cv-bims-integration`)

---

## 1. Problem Statement

SPU validation data (magnetometer, thermocouple, lux, spectrophotometer) is correctly stored in MongoDB but has no visual display on the SPU detail page. Operators and QC personnel cannot see validation results, pass/fail status, or per-well data without querying the database directly. For DHR compliance, all validation data must be visible and traceable from the SPU's record page.

## 2. Goal

Add a **Validation Results** section to the existing SPU detail page (`/spu/[spuId]`) that displays:
- Summary status of all 4 validation types
- Detailed results with per-well/per-reading data tables
- Pass/fail criteria used for each test
- Failure reasons highlighted
- Links to full validation session records
- Audit trail entries related to validation

## 3. Existing Infrastructure

### Data Already Available

The `+page.server.ts` at `src/routes/spu/[spuId]/+page.server.ts` **already loads and returns** all validation data to the frontend:

```typescript
validation: {
  magnetometer: s.validation?.magnetometer ?? null,
  thermocouple: s.validation?.thermocouple ?? null,
  lux: s.validation?.lux ?? null,
  spectrophotometer: s.validation?.spectrophotometer ?? null,
  status: s.validation?.status ?? 'pending'
}
```

**No backend changes are needed.** This is a frontend-only feature.

### Data Structures (from MongoDB)

#### Magnetometer (`validation.magnetometer`)
```typescript
{
  status: 'passed' | 'failed' | 'pending',
  sessionId: string,              // links to validation_sessions collection
  completedAt: Date,
  criteriaUsed: {
    minZ: number,                  // default 3900
    maxZ: number                   // default 4500
  },
  results: Array<{
    well: number,                  // 1-5
    chA_T: number, chA_X: number, chA_Y: number, chA_Z: number,
    chB_T: number, chB_X: number, chB_Y: number, chB_Z: number,
    chC_T: number, chC_X: number, chC_Y: number, chC_Z: number
  }>,
  failureReasons: string[],       // e.g. ["Well 3 Ch A: Z=3872 (range: 3900-4500)"]
  rawData: string                  // raw text from Particle device
}
```

#### Thermocouple (`validation.thermocouple`)
```typescript
{
  status: 'passed' | 'failed' | 'pending',
  sessionId: string,
  completedAt: Date,
  criteriaUsed: {
    minTemp: number,               // default 20
    maxTemp: number                // default 40
  },
  results: {
    min: number,
    max: number,
    average: number,
    stdDev: number,
    cv: number,                    // coefficient of variation
    range: number,
    drift: number,
    readingCount: number,
    outOfRangeCount: number,
    durationMs: number
  },
  failureReasons: string[],
  rawData: { readingCount: number, fileName: string | null }
}
```

#### Lux (`validation.lux`)
```typescript
{
  status: 'passed' | 'failed' | 'pending',
  sessionId: string,
  completedAt: Date,
  criteriaUsed: object,            // TBD — criteria not yet defined
  results: object,                 // TBD — structure depends on implementation
  failureReasons: string[]
}
```

#### Spectrophotometer (`validation.spectrophotometer`)
```typescript
{
  status: 'passed' | 'failed' | 'pending',
  sessionId: string,
  completedAt: Date,
  criteriaUsed: object,            // TBD
  results: object,                 // TBD
  failureReasons: string[]
}
```

### Real Data Examples

**SPU 0238 (failed magnetometer):**
- Well 3 Ch A: Z=3872 (min 3900) — 28 below threshold
- Well 4 Ch A: Z=3892 (min 3900) — 8 below threshold
- Wells 1, 2, 5 all passed
- Channels B and C passed on all wells

**SPU 0205 (passed magnetometer):**
- All 5 wells, all 3 channels within 3900-4500 range
- Z values ranged from 3956 to 4236

## 4. UI Specification

### 4.1 Validation Summary Card

Add to the SPU detail page after the existing device info section. Shows all 4 validation types at a glance.

```
┌─────────────────────────────────────────────────────────────┐
│ 🔬 Validation Results                    Overall: ❌ Failed │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  ┌─────────────┐ ┌─────────────┐ ┌──────────┐ ┌─────────┐ │
│  │ Magnetometer│ │Thermocouple │ │   Lux    │ │  Spect  │ │
│  │   ❌ Failed │ │  ⏳ Pending │ │⏳ Pending│ │⏳Pending│ │
│  │  Mar 31     │ │     —       │ │    —     │ │    —    │ │
│  └──────┬──────┘ └─────────────┘ └──────────┘ └─────────┘ │
│         │                                                   │
│         ▼ (click to expand)                                 │
│  ┌──────────────────────────────────────────────────────┐   │
│  │ Magnetometer Details                                  │   │
│  │ Criteria: Z range 3900 – 4500                        │   │
│  │ Session: QXUnz4VToEISXflvBHkFk                       │   │
│  │ Completed: Mar 31, 2026 3:50 PM                      │   │
│  │                                                       │   │
│  │ ┌──────┬────────────────┬────────────────┬──────────┐│   │
│  │ │ Well │   Channel A    │   Channel B    │Channel C ││   │
│  │ ├──────┼────────────────┼────────────────┼──────────┤│   │
│  │ │  1   │ T:44.6 X:101  │ T:44.4 X:79   │T:44.5    ││   │
│  │ │      │ Y:-157 Z:3952 │ Y:-146 Z:4196 │X:64      ││   │
│  │ │      │           ✅   │           ✅   │Y:-185    ││   │
│  │ │      │                │               │Z:4264 ✅ ││   │
│  │ ├──────┼────────────────┼────────────────┼──────────┤│   │
│  │ │  2   │ Z:3908 ✅      │ Z:4156 ✅      │Z:4260 ✅ ││   │
│  │ ├──────┼────────────────┼────────────────┼──────────┤│   │
│  │ │  3   │ Z:3872 ❌      │ Z:4084 ✅      │Z:4244 ✅ ││   │
│  │ ├──────┼────────────────┼────────────────┼──────────┤│   │
│  │ │  4   │ Z:3892 ❌      │ Z:4176 ✅      │Z:4236 ✅ ││   │
│  │ ├──────┼────────────────┼────────────────┼──────────┤│   │
│  │ │  5   │ Z:3912 ✅      │ Z:4116 ✅      │Z:4228 ✅ ││   │
│  │ └──────┴────────────────┴────────────────┴──────────┘│   │
│  │                                                       │   │
│  │ ❌ Failure Reasons:                                   │   │
│  │ • Well 3 Ch A: Z=3872 (range: 3900-4500)            │   │
│  │ • Well 4 Ch A: Z=3892 (range: 3900-4500)            │   │
│  └──────────────────────────────────────────────────────┘   │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### 4.2 Component Structure

```
ValidationResultsSection.svelte          ← Main section wrapper
├── ValidationSummaryCards.svelte         ← 4 status cards in a row
├── MagnetometerDetail.svelte            ← Expandable detail panel
│   └── MagWellTable.svelte              ← Per-well data table with highlighting
├── ThermocoupleDetail.svelte            ← Expandable detail panel
│   └── ThermoStats.svelte              ← Statistical summary display
├── LuxDetail.svelte                     ← Expandable detail panel (placeholder)
└── SpectrophotometerDetail.svelte       ← Expandable detail panel (placeholder)
```

### 4.3 Design Rules

- **Status colors:**
  - `passed` → green badge/icon ✅
  - `failed` → red badge/icon ❌
  - `pending` → gray/yellow badge ⏳
- **Failed values:** Highlight individual Z values in red when outside criteria range
- **Passing values:** Normal text or subtle green
- **Expandable sections:** Each validation type is collapsible. Default: collapsed if pending, expanded if failed, collapsed if passed.
- **Criteria display:** Always show the criteria used (min/max) so reviewers can verify
- **Session link:** Each completed validation links to `/validation/magnetometer/[sessionId]` (or respective type)
- **Responsive:** Must work on tablet (operators use tablets on the floor)
- **Match existing BIMS design:** Use existing component styles from the app. The SPU detail page uses standard card layouts.

### 4.4 Thermocouple Detail Panel

```
┌──────────────────────────────────────────────────────┐
│ Thermocouple Details                                  │
│ Criteria: Temperature range 20°C – 40°C              │
│ Completed: Mar 19, 2026 10:10 AM                     │
│                                                       │
│ Readings: 493 total | Duration: 8m 12s               │
│                                                       │
│ ┌──────────────┬──────────┐                          │
│ │ Min          │ 1°C   ❌ │                          │
│ │ Max          │ 493°C ❌ │                          │
│ │ Average      │ 247°C    │                          │
│ │ Std Dev      │ 142.3    │                          │
│ │ CV%          │ 57.6%    │                          │
│ │ Range        │ 492      │                          │
│ │ Drift        │ 492      │                          │
│ │ Out of Range │ 472/493  │                          │
│ └──────────────┴──────────┘                          │
│                                                       │
│ ❌ Failure Reasons:                                   │
│ • 19 reading(s) below minimum 20°C                   │
│ • 453 reading(s) above maximum 40°C                  │
└──────────────────────────────────────────────────────┘
```

### 4.5 Lux & Spectrophotometer (Placeholder)

These validation types don't have test data yet. Build the panels with:
- Status badge (pending/passed/failed)
- "No data yet" message when status is pending
- Generic key-value table that renders whatever is in `results` when data exists
- `failureReasons` list if present

This makes them forward-compatible — when the lux and spect validation flows are built, the display will automatically render the results.

## 5. Files to Create/Modify

### New Files
| File | Description |
|------|-------------|
| `src/lib/components/spu/ValidationResultsSection.svelte` | Main validation section |
| `src/lib/components/spu/ValidationSummaryCards.svelte` | 4 status cards |
| `src/lib/components/spu/MagnetometerDetail.svelte` | Mag expandable panel + well table |
| `src/lib/components/spu/ThermocoupleDetail.svelte` | Thermo expandable panel + stats |
| `src/lib/components/spu/LuxDetail.svelte` | Lux placeholder panel |
| `src/lib/components/spu/SpectrophotometerDetail.svelte` | Spect placeholder panel |

### Modified Files
| File | Change |
|------|--------|
| `src/routes/spu/[spuId]/+page.svelte` | Import and render `ValidationResultsSection` component |

### Files NOT to Touch
| File | Reason |
|------|--------|
| `src/routes/spu/[spuId]/+page.server.ts` | Already returns all needed data — no backend changes |
| `src/routes/validation/**` | Validation flow pages are separate — don't modify |
| Any model/schema files | Data is already correctly stored |

## 6. Data Flow

```
MongoDB (spus collection)
  └── validation.magnetometer / thermocouple / lux / spectrophotometer
        │
        ▼
+page.server.ts (ALREADY loads this data)
        │
        ▼
+page.svelte (passes validation prop to new component)
        │
        ▼
ValidationResultsSection.svelte
  ├── ValidationSummaryCards.svelte (reads status from each type)
  ├── MagnetometerDetail.svelte (reads results[], criteriaUsed, failureReasons)
  ├── ThermocoupleDetail.svelte (reads results{}, criteriaUsed, failureReasons)
  ├── LuxDetail.svelte (reads whatever data exists)
  └── SpectrophotometerDetail.svelte (reads whatever data exists)
```

**No API calls needed.** All data comes from the existing page load.

## 7. Acceptance Criteria

1. SPU detail page shows a "Validation Results" section with 4 status cards
2. Magnetometer card shows ✅/❌/⏳ based on `validation.magnetometer.status`
3. Clicking magnetometer card expands to show per-well data table
4. Failed Z values are highlighted in red in the table
5. Criteria range is displayed above the table
6. Failure reasons are listed below the table
7. Thermocouple card expands to show statistical summary
8. Lux and Spectrophotometer cards show "No data yet" when pending
9. Overall validation status shown in section header
10. Session ID links to `/validation/magnetometer/[sessionId]` (etc.)
11. Works on tablet viewport (768px+)
12. No backend changes — purely frontend
13. Matches existing BIMS card/component styling

## 8. Testing

### Test with SPU 0238 (BT-M01-0000-0238)
- Magnetometer: FAILED — should show red, expanded by default
- Wells 3 & 4 Ch A Z values should be red
- Wells 1, 2, 5 should be normal/green
- Channels B & C all green
- Thermocouple, Lux, Spect: pending — gray badges

### Test with SPU 0205 (BT-M01-0000-0205)
- Magnetometer: PASSED — green badge, collapsed by default
- Thermocouple: FAILED — red badge, expanded
- All 5 wells should show green Z values in mag detail
- Thermo stats should show out-of-range highlighted

### Test with any new SPU (no validations run)
- All 4 cards show ⏳ Pending
- Expanding any shows "No data yet"
- No errors or blank panels

## 9. Implementation Notes for the AI Agent

- **Stack:** SvelteKit 2 + Svelte 5 (use `$props()`, `$state()`, `{#snippet}` — NOT Svelte 4 syntax)
- **Component location:** `src/lib/components/spu/` — create this folder if it doesn't exist
- **Styling:** Use existing CSS patterns from the app. Check other `.svelte` files in `src/lib/components/` for class naming conventions.
- **Only edit these files:** The new component files listed above + `src/routes/spu/[spuId]/+page.svelte`. Do NOT rewrite or restructure any other files.
- **Make surgical edits only.** Do NOT rewrite `+page.svelte` from scratch — add the import and component render in the appropriate location within the existing template.
- **The data is already available** as `data.spu.validation` in the page component. You just need to pass it to the new component.
