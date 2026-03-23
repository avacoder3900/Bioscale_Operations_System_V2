# PRD: Part Accession & Barcode Registration

## Overview
Build a Part Accession page that generates and assigns barcodes to parts in the system. This serves two purposes: (1) a one-time bulk registration of all existing parts that currently lack barcodes, and (2) the ongoing workflow for assigning barcodes to new parts as they enter the system — normally at receiving but available standalone.

## Background
- `PartDefinition.barcode` field exists but is optional, has no auto-generation, and no uniqueness enforcement
- Current flow: create part → manually navigate to detail page → manually type barcode → save. No generation, no validation.
- `GeneratedBarcode` model exists (used for validation barcodes like THERMO-000001) but is NOT used for parts
- Receiving creates `ReceivingLot.lotId` (vendor barcode) but this is independent of `PartDefinition.barcode` — no cross-reference
- Box.com bulk import (`box-sync.ts`) syncs parts from spreadsheet but has NO barcode column
- Many existing parts in the system have no barcode assigned — these need one-time registration
- Part barcodes are what operators scan during WI assembly to deduct inventory

## Stories

### S1: Barcode Generation Service for Parts
**As a** developer, **I want** a reusable barcode generation service for parts **so that** barcodes are sequential, unique, and consistent.

**Acceptance Criteria:**
- Reuse `GeneratedBarcode` model with prefix `'PART'`
- Generation pattern: `PART-000001`, `PART-000002`, etc.
- Function: `generatePartBarcode()` returns next sequential barcode
  ```typescript
  async function generatePartBarcode(): Promise<string> {
    const doc = await GeneratedBarcode.findOneAndUpdate(
      { prefix: 'PART' },
      { $inc: { sequence: 1 } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    return `PART-${String(doc.sequence).padStart(6, '0')}`;
  }
  ```
- Barcode is guaranteed unique via GeneratedBarcode.barcode unique index
- Service file: `src/lib/server/services/barcode-generator.ts`

**Technical Notes:**
- The GeneratedBarcode model already exists and handles atomic sequence increment
- Add the generated barcode string to `GeneratedBarcode.barcode` field and `type: 'part'`
- This same service can later be extended for other barcode types (IPK, etc.)

### S2: Enforce Unique Barcodes on PartDefinition
**As a** developer, **I want** barcode uniqueness enforced at the model level **so that** no two parts share a barcode.

**Acceptance Criteria:**
- Change `PartDefinition.barcode` index from sparse to **unique sparse**
  - Sparse means parts without barcodes don't conflict
  - Unique means no two parts can have the same barcode
- Verify existing data has no duplicates before applying index change
- If duplicates exist, flag them in console output for manual resolution
- Update `updateBarcode` action in `parts/[partId]/+page.server.ts` to check uniqueness before saving:
  ```
  const existing = await PartDefinition.findOne({ barcode, _id: { $ne: partId } });
  if (existing) return fail(400, { error: `Barcode already assigned to ${existing.partNumber}` });
  ```

**Technical Notes:**
- Modify: `src/lib/server/db/models/part-definition.ts` (index change)
- Modify: `src/routes/parts/[partId]/+page.server.ts` (uniqueness check in updateBarcode)

### S3: Part Accession Page — Bulk Registration
**As an** operator, **I want** to see all parts that need barcodes and assign them in bulk **so that** I can register all existing inventory in one session.

**Acceptance Criteria:**
- New page route: `/parts/accession/+page.server.ts`
- Load function returns:
  - All PartDefinition records, split into:
    - `unregistered[]`: parts where `barcode` is null/empty (need barcodes)
    - `registered[]`: parts where `barcode` exists (already done)
  - Counts: `{ total, registered, unregistered }`
- Display:
  - Summary bar: "42 of 58 parts registered" with progress indicator
  - **Unregistered parts table:** partNumber, name, category, bomType, inventoryCount, [Assign Barcode] button
  - **Registered parts table:** partNumber, name, barcode, registeredAt
- Permission: `inventory:write`

**Technical Notes:**
- Route: `src/routes/parts/accession/+page.server.ts`
- The .svelte file will need to be created (exception to DO NOT MODIFY rule — this is a new page)
- Use existing Tailwind patterns from other list pages

### S4: Single Part Barcode Assignment (Accession Action)
**As an** operator, **I want** to click "Assign Barcode" on an unregistered part and have the system generate and save a barcode **so that** each part gets a unique scannable identifier.

**Acceptance Criteria:**
- Form action `assignBarcode` on accession page
- Input: `partDefinitionId`
- Behavior:
  1. Call `generatePartBarcode()` → gets next sequential barcode (e.g., `PART-000013`)
  2. Update `PartDefinition.barcode = generatedBarcode`
  3. Create AuditLog entry:
     ```
     action: 'barcode_assigned',
     resourceType: 'part_definition',
     resourceId: partDefinitionId,
     newData: { barcode: generatedBarcode }
     ```
  4. Return `{ success: true, barcode: generatedBarcode }`
- Part moves from unregistered table to registered table
- Permission: `inventory:write`

### S5: Bulk Barcode Assignment (Assign All)
**As an** operator, **I want** to assign barcodes to all unregistered parts at once **so that** I can complete the one-time registration quickly.

**Acceptance Criteria:**
- Form action `assignAll` on accession page
- Behavior:
  1. Find all PartDefinition where `barcode` is null/empty
  2. For each part (in sequence):
     - Call `generatePartBarcode()`
     - Update `PartDefinition.barcode`
     - Create AuditLog entry
  3. Return `{ success: true, count: N, barcodes: [...] }`
- Confirmation prompt before executing ("This will assign barcodes to N parts. Continue?")
- Shows results: list of partNumber → assigned barcode
- Permission: `inventory:write`

**Technical Notes:**
- Process sequentially (not parallel) to maintain barcode sequence order
- If any assignment fails (e.g., duplicate), skip that part and continue, report failures at end

### S6: Part Accession at Receiving (Integration)
**As an** operator, **I want** new parts that arrive at receiving to get barcodes if they don't have one **so that** every part in the system is scannable going forward.

**Acceptance Criteria:**
- When a ReceivingLot is accepted (`status: 'accepted'`):
  - Look up the associated `PartDefinition`
  - If `PartDefinition.barcode` is null/empty:
    - Auto-generate barcode via `generatePartBarcode()`
    - Assign to `PartDefinition.barcode`
    - AuditLog entry: `barcode_auto_assigned_at_receiving`
  - If `PartDefinition.barcode` already exists: no action
- This is automatic — no operator action needed
- Display assigned barcode in receiving lot acceptance confirmation

**Technical Notes:**
- Modify: `src/routes/receiving/new/+page.server.ts` (in the acceptance block after inventory increment)
- Modify: `src/routes/receiving/[lotId]/+page.server.ts` (in disposeLot acceptance block)
- This ensures all FUTURE parts get barcodes automatically at receiving

### S7: QR Code Generation & Label Export
**As an** operator, **I want** QR codes generated for each part and a printable label sheet **so that** I can print and stick QR labels on parts/bins for scanning.

**Acceptance Criteria:**
- All part barcodes are rendered as **QR codes** (not 1D barcodes)
- QR code content: the `PART-XXXXXX` string (scanner reads this, system looks up the part)
- Accession page shows a QR code preview next to each registered part
- Form action `exportLabels` on accession page:
  - Input: selection of part IDs (or "all registered")
  - Generates a **printable HTML/PDF page** with QR code labels:
    - Each label shows: QR code image + part number + part name (human-readable below QR)
    - Grid layout suitable for label sheets (e.g., Avery 5160 or similar)
  - File name: `part-qr-labels-YYYY-MM-DD.pdf` or printable HTML page
- QR codes also displayed on individual part detail pages (`/parts/[partId]`)
- Permission: `inventory:read`

**Technical Notes:**
- Use a server-side QR library (e.g., `qrcode` npm package) to generate QR as SVG or PNG data URI
- QR generation happens server-side in the load function — returns base64 SVG/PNG per part
- For the printable label page: generate a full-page HTML with CSS print styles, or use a PDF library
- QR codes encode the `PART-XXXXXX` string only — scanners emit this as keyboard input, which the system already handles
- The accession page and part detail page show QR inline; the export action generates the printable sheet

## Implementation Order

```
Phase 1 — Core Registration (one-time bulk setup)
  S1: Barcode generation service
  S2: Enforce unique barcodes
  S3: Part accession page (list view)
  S4: Single part barcode assignment
  S5: Bulk barcode assignment (assign all)

Phase 2 — Ongoing Integration
  S6: Auto-assign at receiving
  S7: Label data export
```

## Out of Scope
- Physical label printer integration (Zebra/DYMO drivers)
- ~~QR code generation~~ — QR codes are IN SCOPE (see S7)
- Barcode format customization per part category
- Vendor barcode ↔ part barcode cross-reference validation
- Mobile barcode scanning UI (existing scanner input works via keyboard emulation)

## Models Summary

| Model | Collection | Change |
|-------|-----------|--------|
| PartDefinition | `part_definitions` | Enforce unique sparse index on `barcode` |
| GeneratedBarcode | `generated_barcodes` | Reused with prefix `'PART'`, type `'part'` |
| AuditLog | `audit_log` | New action types: `barcode_assigned`, `barcode_auto_assigned_at_receiving` |

## Routes Summary

| Route | Method | Purpose |
|-------|--------|---------|
| `/parts/accession` | GET | List registered/unregistered parts |
| `/parts/accession` (action: assignBarcode) | POST | Generate + assign barcode to single part |
| `/parts/accession` (action: assignAll) | POST | Bulk assign barcodes to all unregistered parts |
| `/parts/accession` (action: exportLabels) | POST | Generate printable QR code label sheet |
