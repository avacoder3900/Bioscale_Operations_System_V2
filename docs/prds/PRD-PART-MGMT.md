# PRD-1: Part Management & Data Import

## Overview
Import all SPU and cartridge parts from the Excel BOM into MongoDB `part_definitions`, add a `bomType` field for filtering, clean junk rows, and build a Part Management page for admin/operator editing.

## Background
- 50 SPU parts currently in `part_definitions` — 12 missing, 4 junk rows
- 0 cartridge parts in Mongo — 8 need to be added from "Cartridge BOM Breakdown" sheet
- Excel spreadsheet remains source of truth for inventory counts for now
- Website needs a unified Part Management interface

## Stories

### S1: Data Migration Script
**As an** admin, **I want** all parts from the Excel BOM imported into MongoDB **so that** the website has complete part data.

**Acceptance Criteria:**
- Script reads "Inventory Tracking System" sheet (SPU parts, excluding PT-CT-* duplicates)
- Script reads "Cartridge BOM Breakdown" sheet (cartridge parts only)
- Adds `bomType` field: `"spu"` or `"cartridge"` based on source sheet
- Cross-checks existing Mongo docs — does NOT overwrite, only adds missing parts
- Removes 4 junk rows: "Power Supply" (TBD part#), "R&D VARIATIONS INVENTORY COUNT", duplicate "Silver Sheet Metal Enclosure", duplicate "Enclosure Front" without proper IDs
- Fixes typo: "Cartriedge Sleeve" → "Cartridge Sleeve"
- Adds `bomType` to all 50 existing parts (infer from part number prefix)
- Logs every action (added, skipped, cleaned, updated)
- Fields per part: partNumber, name, category (classification), supplier, supplierPartNumber, qtyPerUnit, unitOfMeasure, unitCost, leadTimeDays, inventoryCount (from column X), bomType, isActive

**Technical Notes:**
- Run as a one-time Node.js script using existing Mongoose models
- Source file: `/Users/agent001/.openclaw/media/inbound/file_217---dd67396c-8fc9-47dd-a18f-77f3433265ce.xlsx`
- Update `PartDefinition` model to include `bomType` and `supplierPartNumber` fields
- Add index on `bomType` for filtering

### S2: Part Management Page — List View
**As an** admin or operator, **I want** to see all parts organized by SPU/Cartridge **so that** I can manage the parts inventory.

**Acceptance Criteria:**
- Page at `/spu/parts` (enhance existing page)
- Tab filter: "SPU Parts" | "Cartridge Parts" (uses `bomType`)
- Table columns: Part #, Name, Classification, Supplier, Qty/Unit, UoM, Unit Cost, Lead Time, Inventory Count
- Search by part number or name
- Sort by any column
- Low inventory highlighting (inventory < qtyPerUnit)
- Color-coded classification badges (Critical = red, Non-Critical = default)
- Permission: `inventory:read` to view

### S3: Part Management Page — Edit/Add
**As an** admin or operator, **I want** to edit part information and add new parts **so that** the parts database stays current.

**Acceptance Criteria:**
- Edit button on each part row → opens edit form (slide-out or modal)
- Editable fields: name, category, supplier, supplierPartNumber, qtyPerUnit, unitOfMeasure, unitCost, leadTimeDays, inventoryCount, isActive
- Part number is read-only after creation (immutable identifier)
- Add New Part button → form with all fields + partNumber (required, unique)
- Must select bomType (SPU or Cartridge) when creating
- Validation: partNumber required + unique, name required
- Permission: `inventory:write` required for edit/add
- Audit log entry on every edit (who, when, what changed)

### S4: Part Definition Model Update
**As a** developer, **I want** the PartDefinition model updated **so that** it supports all required fields.

**Acceptance Criteria:**
- Add fields to schema: `bomType` (String, enum: ['spu', 'cartridge']), `supplierPartNumber` (String)
- Add index: `{ bomType: 1 }`
- Ensure `partNumber` unique index exists
- Export updated model from `$lib/server/db/index.ts`
- No breaking changes to existing queries

## Dependencies
- None — this is the foundation PRD

## Estimated Effort
- 4-6 hours across 1 Ralph loop
