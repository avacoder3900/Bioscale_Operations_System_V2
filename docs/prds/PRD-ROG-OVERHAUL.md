# PRD-2: Receiving of Goods (ROG) Overhaul

## Overview
Build a complete digital receiving workflow that replaces the paper-based ROG and inspection process. Barcode scan initiates lot creation, generic checklist covers all parts, critical parts get structured inspection procedures, and all receiving events create inventory transactions.

## Background
- Current ROG page exists at `/spu/receiving` with basic lot creation
- Paper forms (FRM-07-4 Receiving Inspection, Inspection Procedures) being digitized
- Every received item must create a lot with traceability back to supplier
- Critical parts require dimensional/functional inspections with numeric + pass/fail inputs
- Non-critical parts require Certificate of Conformity (CoC) upload

## Stories

### S1: Barcode Scan → Lot Creation
**As an** operator, **I want** to scan a barcode to start the receiving process **so that** every incoming shipment gets a lot number automatically.

**Acceptance Criteria:**
- ROG page shows a barcode scan input field (auto-focus, keyboard wedge compatible)
- Scanning a part barcode (or selecting from dropdown) identifies the part from `part_definitions`
- Auto-fills: part name, part number, classification, supplier, current inventory count
- Operator enters: quantity received, PO #, supplier lot/job ID, serial # (if applicable)
- System generates unique Brevitest Lot Number (format: `LOT-YYYYMMDD-XXXX`)
- Creates `receiving_lot` document in MongoDB with status "in_progress"
- All users can initiate ROG (not restricted to admin/operator)
- Permission: `receiving:create` (assign to all roles)

### S2: Generic Receiving Checklist
**As an** operator, **I want** to complete a standard checklist for every received item **so that** basic quality checks are documented.

**Acceptance Criteria:**
- After lot creation, checklist appears with Yes/No/N/A toggles:
  1. Packing slip included
  2. Material properly labeled/identified
  3. Material properly packaged
  4. Material free of debris/visual damages/cosmetic defects
  5. Purchase order requirements met
- Classification gate auto-determined from part's `category` field
- Critical parts → proceed to inspection (S3) or CoC upload
- Non-critical parts → Form-fit-function check (Pass/Fail/N/A)
- Any "No" answer flags the lot for review but doesn't auto-reject
- Checklist responses stored on the `receiving_lot` document

### S3: Critical Part Inspection Procedures
**As an** operator, **I want** to follow a structured inspection procedure for critical parts **so that** dimensional and functional requirements are verified.

**Acceptance Criteria:**
- If part has linked inspection procedure, display ordered steps
- Each step shows: step number, instruction text, reference photo (if uploaded)
- Each step has an input type:
  - **Numeric measurement**: input field + unit + acceptance range (min/max from drawing)
  - **Pass/Fail functional test**: toggle (Pass/Fail)
- Tools required listed at top of procedure (e.g., "Digital Caliper", "Inspection Fixture")
- Sample size configurable per part (from `sampleSize` field on part definition)
- Results stored per step per sample on the `receiving_lot` document
- Overall: all steps pass → lot passes inspection. Any fail → flags for disposition.
- First Article Inspection (FAI) checkbox — marks if this is a first article

### S4: Inspection Procedure Management
**As an** admin, **I want** to create and edit inspection procedures for critical parts **so that** operators have clear instructions.

**Acceptance Criteria:**
- Accessible from Part Management page → part detail → "Inspection Procedure" tab
- Create/edit ordered list of inspection steps
- Per step: instruction text, input type (numeric/pass-fail), acceptance criteria (min/max or N/A), reference photo upload
- Tools/equipment list per procedure
- Version history — new revision creates new `inspection_procedure_revision` doc, old ones archived
- Link procedure to part via `partDefinitionId`
- Permission: `inspection:write` (admin only)

### S5: Certificate of Conformity Upload
**As an** operator, **I want** to upload a Certificate of Conformity for non-inspection parts **so that** supplier compliance is documented.

**Acceptance Criteria:**
- For parts without inspection procedures (or when CoC is available alongside inspection)
- File upload (PDF, image) stored and linked to the receiving lot
- Operator marks: CoC meets standards (Yes/No)
- If No → lot flagged for review
- CoC document accessible from lot detail and part traceability views
- Storage: MongoDB GridFS or file system with reference in lot document

### S6: Photo Upload & Operator Notes
**As an** operator, **I want** to upload photos and add notes during receiving **so that** visual documentation supports the inspection record.

**Acceptance Criteria:**
- Photo upload available at any step (lot creation, checklist, inspection, disposition)
- Multiple photos per lot
- Notes field (free text) available at lot level and per inspection step
- Photos stored and thumbnailed for quick viewing
- Accessible from lot detail view

### S7: Final Disposition & Lot Completion
**As an** operator, **I want** to accept or reject a received lot **so that** inventory is updated accordingly.

**Acceptance Criteria:**
- Disposition options: Accepted, Rejected, Return to Supplier, Other (with explanation)
- If Accepted: inventory count on `part_definitions` incremented by quantity received, `inventory_transaction` created (type: "receipt")
- If Rejected: record total rejects, defect description, Nonconformance (NC) number issued
- RMA # field (if returning to supplier)
- Operator signature (logged user) + timestamp
- Lot status updated: "accepted", "rejected", "returned", "other"
- Completed lot is immutable (no edits after disposition without admin override)

### S8: ROG Dashboard & Lot History
**As a** user, **I want** to see all receiving lots and their status **so that** I can track what's been received.

**Acceptance Criteria:**
- Dashboard at `/spu/receiving` showing recent lots
- Filter by: status, part, date range, operator
- Click lot → full detail view (all checklist answers, inspection results, photos, notes, CoC, disposition)
- Search by lot number, part number, PO #
- Export capability (future — not required for v1)

## Dependencies
- PRD-1 (Part Management) must be complete — parts need to exist in Mongo with `bomType` and classification

## Estimated Effort
- 8-12 hours across 1-2 Ralph loops

## Reference Documents
- `projects/v2-overhaul/reference-docs/receiving-inspection-form.docx` — Paper ROG form being digitized
- `projects/v2-overhaul/reference-docs/inspection-procedure-stepper-motor.docx` — Example inspection procedure (PT-SPU-016)
