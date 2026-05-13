# PRD: SPU Assembly Tab Revamp — Auto-UDI + Singleton Work Instruction

## Overview
Revamp the SPU assembly tab so a new build starts by auto-assigning the next available UDI, instantiates a draft SPU under that UDI, and surfaces a widget that routes the operator into the single canonical SPU Work Instruction (WI). The SPU has exactly **one** WI for the entire creation process. The WI section exposes two buttons — **Upload** and **Edit** — where Upload runs a parsing pass over the source document to extract `PT-SPU-XXX` part references and `qty=X` quantities, auto-generates barcode fields for every required scan across the WI, presents the result for one-time human review, and inducts the confirmed WI into the system. This PRD covers the assembly entry flow and WI ingestion pipeline only; the WI file-storage location and the manufacturing-page port consume the structures defined here and are specified in a follow-up PRD.

## Background
- Current assembly tab (`src/routes/assembly/+page.server.ts`) lists prior `AssemblySession` records and starts a session against an existing SPU — UDI is created elsewhere and entered manually (`src/routes/+page.server.ts:430` builds `udi = SPU-${serialNumber}` from operator input, with no next-available lookup).
- `Spu.udi` has a unique index (`src/lib/server/db/models/spu.ts:109`), so collisions today are user-visible failures rather than a generated sequence.
- `WorkInstruction` model (`src/lib/server/db/models/work-instruction.ts`) already supports versioned content with `steps[].partRequirements[]` (`partNumber`, `quantity`) and `steps[].fieldDefinitions[]` typed `barcode_scan` — the parser can populate this shape directly.
- Part numbers in the SPU BOM follow `PT-SPU-XXX` (also `SBA-SPU-`, `IFU-SPU-` per `scripts/migrate-bom-parts.ts:48`).
- `GeneratedBarcode` already provides atomic sequential allocation (see `PRD-PART-ACCESSION.md` S1) and is the right primitive for next-available UDI.
- `PRD-BUILD-RUN-IPK.md` covers batch build kickoff, IPK acknowledgment, and step-level scrap. This PRD does **not** replace it; it slots in as the per-SPU entry experience that runs once a BuildRun has been started (or standalone for one-off builds).

## Key Decisions (Owner-Approved)
1. **Auto-assigned UDI on draft create** — operator does not type a serial. The system reserves the next available SPU sequence atomically and writes the SPU draft with `status: 'draft'`, `assemblyStatus: 'created'`.
2. **Exactly one Work Instruction governs SPU creation** — the system enforces a single canonical, active SPU-creation WI. New uploads supersede the prior version (versioned, not duplicated).
3. **WI Upload runs parse → review → induct** — parsing is automatic; induction requires one explicit human confirmation pass. No silent activation.
4. **Parser scope is `PT-SPU-XXX` + `qty=X`** for v1 — additional prefixes (`SBA-SPU-`, `IFU-SPU-`) are recognized but flagged for reviewer attention rather than auto-accepted as primary part rows.
5. **Barcode fields are generated for every required scan in the WI** — one `barcode_scan` field per part-quantity unit, mapped to the step that requires it.
6. **The WI structure must be portable to the manufacturing page** — fields, step ordering, and barcode mappings are stored in a shape the mfg page can consume without re-parsing. The mfg page wiring itself is a separate PRD.

## Stories

### S1: Next-Available SPU UDI Service
**As a** developer, **I want** an atomic next-available UDI generator **so that** every new SPU draft gets a unique, sequential UDI without operator input.

**Acceptance Criteria:**
- Reuse `GeneratedBarcode` with prefix `'SPU'`, type `'spu'`.
- Pattern: `SPU-000001`, `SPU-000002`, …
- Function: `generateNextSpuUdi(): Promise<string>` performs an atomic `findOneAndUpdate({ prefix: 'SPU' }, { $inc: { sequence: 1 } }, { upsert: true, new: true })` and formats the result.
- Concurrency: two simultaneous calls must produce two distinct UDIs (verified by integration test).
- Reservation is consumed at draft create time — there is no "reserve and release" path. If the draft create fails after UDI allocation, the UDI is burned and logged (acceptable for v1).

**Technical Notes:**
- Service file: `src/lib/server/services/udi-generator.ts`.
- Existing `Spu.udi` unique index is the secondary safety net.
- AuditLog entry on each allocation: `{ action: 'allocate', resourceType: 'spu_udi', details: { udi } }`.

### S2: Draft SPU Auto-Create on Assembly Tab Entry
**As an** operator, **I want** the assembly tab to start a new build by allocating a UDI and creating the draft SPU automatically **so that** I do not have to type or look up an identifier.

**Acceptance Criteria:**
- New action `startNewBuild` on the assembly tab:
  1. `requirePermission(locals.user, 'spu:write')`.
  2. Call `generateNextSpuUdi()`.
  3. Create `Spu` document with `_id: generateId()`, `udi`, `status: 'draft'`, `assemblyStatus: 'created'`, `createdBy: locals.user._id`.
  4. Push initial `statusTransitions` entry `{ from: null, to: 'draft', changedBy, changedAt }`.
  5. AuditLog: `tableName: 'spus'`, `action: 'INSERT'`.
  6. Return `{ spuId, udi }` to the page.
- The assembly tab UI shows the newly assigned UDI as a confirmation banner with a **Continue to Work Instruction** widget (CTA → see S3).
- If a draft SPU already exists for this operator that has not yet entered assembly, the action returns that draft instead of allocating a new UDI (idempotency guard against double-clicks). Stale drafts older than 24h are excluded.
- Permission: `spu:write`.

**Technical Notes:**
- Modify: `src/routes/assembly/+page.server.ts` — add `startNewBuild` action.
- The `.svelte` companion file already exists and is frozen; the new widget renders from action return data using existing component patterns. If the page cannot express the widget without a new component, escalate per the BIMS V2 freeze-exception rule.
- Do NOT couple this action to BuildRun — standalone single-SPU starts are valid. If a BuildRun context is present (query param `?buildRunId=`), associate the new SPU with it (`spu.batch._id = buildRun.batchId`).

### S3: Work Instruction Widget on Assembly Tab
**As an** operator, **I want** a widget after UDI assignment that routes me into the SPU Work Instruction **so that** I can begin the build with the correct, current procedure.

**Acceptance Criteria:**
- After successful `startNewBuild`, the page renders a widget with:
  - Assigned UDI (large, scannable).
  - Active SPU WI title, revision, and effective date (read from the singleton — see S4).
  - Primary CTA **Open Work Instruction** linking to `/assembly/[sessionId]` (creating the AssemblySession if it does not yet exist).
  - Secondary affordances: **Manage Work Instruction** (visible only with `documents:write`) → opens the WI Upload/Edit page (S5).
- If no active SPU WI exists, the widget shows a blocking state: "No active SPU Work Instruction. Upload one to begin." with the CTA gated on `documents:write`.

**Technical Notes:**
- Reuse `AssemblySession` model and existing session-create flow.
- WI lookup queries the singleton (S4) — do not surface a list picker.

### S4: Singleton SPU Work Instruction Enforcement
**As a** quality lead, **I want** the system to enforce a single canonical SPU-creation WI **so that** every SPU is built against the same procedure.

**Acceptance Criteria:**
- Introduce a `documentType: 'spu_creation'` discriminator on `WorkInstruction`.
- Invariant: at most one `WorkInstruction` with `documentType: 'spu_creation'` and `status: 'active'` may exist at any time.
- Activating a new revision atomically transitions the prior active record to `status: 'retired'` and bumps `currentVersion`.
- A read helper `getActiveSpuWorkInstruction()` returns the active record or `null`.
- Any code path that creates an SPU assembly session reads via this helper — there is no WI selection UI for the SPU build flow.
- Migration: backfill existing SPU-related WIs by tagging the most recent as `documentType: 'spu_creation', status: 'active'` and retiring others. If multiple plausible candidates exist, the migration logs and skips, requiring manual designation.

**Technical Notes:**
- Modify: `src/lib/server/db/models/work-instruction.ts` — add `documentType` enum (no breaking change; field already typed loosely as `String`).
- Add a partial unique index: `{ documentType: 1, status: 1 }` where `status === 'active'` and `documentType === 'spu_creation'`. (MongoDB partial filter expression.)
- New helper: `src/lib/server/services/spu-work-instruction.ts`.

### S5: Work Instruction Upload + Edit Buttons
**As a** quality lead, **I want** Upload and Edit buttons on the SPU WI page **so that** I can introduce a new revision or amend the current one.

**Acceptance Criteria:**
- New page: `/spu/work-instruction/+page.server.ts` (and accompanying `.svelte` per freeze-exception — escalate before creating).
- Page surfaces:
  - The active SPU WI summary (title, revision, effective date, parsed step count, parsed barcode-field count).
  - **Upload** button → file picker accepting `.docx`, `.pdf`, `.md` for v1. Triggers parse pipeline (S6) and routes to the review screen (S7).
  - **Edit** button → opens an inline editor on the active WI's parsed structure (steps, parts, barcode fields). Saves create a new draft version; activation is a separate explicit action (re-uses S7 induction flow).
- Permissions: `documents:read` to view, `documents:write` to upload or edit.
- AuditLog entry on every upload, save, and induction.

**Technical Notes:**
- Upload streams the file into the existing `File` model; the parsed structure attaches to a new `WorkInstruction.versions[]` entry referencing `fileId`.
- Edit reads the latest version's `steps[]` into a working draft; it does NOT mutate the active version directly.

### S6: WI Parser — `PT-SPU-XXX` + `qty=X` Extraction
**As a** developer, **I want** a parser that extracts SPU part references and quantities from an uploaded WI **so that** the system can auto-generate the barcode-field schema for the entire instruction.

**Acceptance Criteria:**
- Parser entry: `parseSpuWorkInstruction(file: { buffer, mimeType, originalName }): Promise<ParsedWorkInstruction>`.
- For `.docx`: extract text via existing docx pipeline (reuse whatever `ROG`/inspection-procedure parsing already uses; if none, add `mammoth`-based extraction). For `.pdf`: text-layer extraction (page-ordered). For `.md`: read as UTF-8.
- Step segmentation: split on heading markers (`#`, numbered headings `1.`, `Step N`). Each segment becomes a `parsedStep` with `stepNumber`, `title`, `content`.
- Part extraction (per step):
  - Primary regex: `/\bPT-SPU-(\d{3,})\b/g` → `partNumber: 'PT-SPU-XXX'`.
  - Quantity regex: `/qty\s*=\s*(\d+)/i` scoped to the same step. Defaults to `1` when absent.
  - If multiple part references appear in one step, each gets its own `partRequirement`.
  - Recognize but flag `SBA-SPU-` and `IFU-SPU-` references in `parsedStep.warnings[]` for reviewer attention.
- Barcode-field generation:
  - For every `partRequirement { partNumber, quantity }`, emit `quantity` `fieldDefinitions` of `fieldType: 'barcode_scan'`, with `fieldName: '{partNumber}_scan_{n}'`, `fieldLabel: 'Scan {partNumber} ({n} of {quantity})'`, `isRequired: true`, `barcodeFieldMapping: partNumber`, `sortOrder` reflecting step + position.
  - Across the full WI, the parser returns `totalRequiredScans` summing all generated fields.
- Output shape:
  ```typescript
  type ParsedWorkInstruction = {
    title?: string;
    rawContent: string;
    steps: Array<{
      stepNumber: number;
      title: string;
      content: string;
      partRequirements: Array<{ partNumber: string; quantity: number }>;
      fieldDefinitions: Array<FieldDefinition>; // barcode_scan entries
      warnings: string[];
    }>;
    totalRequiredScans: number;
    parserVersion: string;
    warnings: string[];
  };
  ```
- The parser must be deterministic and unit-tested against representative fixtures (3+ docx samples, 1 pdf, 1 md) covering: single-part step, multi-part step, missing `qty=`, multiple `PT-SPU-` in prose, false positives in headers/footers.

**Technical Notes:**
- Service file: `src/lib/server/services/spu-wi-parser.ts`.
- `parserVersion` baked into output enables future re-parse migrations.
- Do not persist anything during parse — the result is held in the review session (S7) until induction.

### S7: Review-and-Induct Flow
**As a** quality lead, **I want** to confirm parsed values once before they go live **so that** a bad parse cannot reach the floor.

**Acceptance Criteria:**
- After Upload (or Edit save), the user is routed to a review screen showing:
  - Per step: title, content snippet, parsed `partRequirements`, generated `fieldDefinitions`, and any `warnings`.
  - Totals: step count, distinct parts, total scans.
  - Inline edit affordances on every parsed value (partNumber, quantity, fieldLabel, sortOrder, isRequired).
  - Add/remove rows for missed parts or false positives.
- A draft is persisted as a new `WorkInstruction.versions[]` entry with the operator's edits as soon as the review screen opens — closing the tab does not lose work.
- **Induct** button:
  - Validates: every step has at least one of (content present) or (partRequirements present); every barcode field has `fieldName`, `fieldLabel`, `barcodeFieldMapping`; no duplicate `fieldName` within a step.
  - Atomically:
    - Sets the new version as `currentVersion`.
    - Sets `WorkInstruction.status = 'active'`, `documentType = 'spu_creation'`.
    - Retires the prior active SPU-creation WI.
    - Writes AuditLog entries for retire + activate.
  - Records `parsedAt`, `parsedBy`, `reviewedBy`, `reviewedAt` on the version.
- **Reject** button discards the draft version (soft delete: keeps the row with `status: 'discarded'`, preserves audit trail).
- Permission: `documents:write` to review; `documents:approve` (or equivalent) to induct. If the project does not yet have a separate approve permission, induct gates on `documents:write` for v1 with a TODO to split.

**Technical Notes:**
- Route: `/spu/work-instruction/review/[versionId]/+page.server.ts`.
- The review screen is the only place where parser output becomes live data — the parser itself never writes to `WorkInstruction.steps[]` directly.

### S8: Manufacturing-Page Port Surface (Stub)
**As a** developer working on the manufacturing page next, **I want** the inducted WI structure to be queryable in a stable shape **so that** the mfg-page PRD can consume it without re-parsing.

**Acceptance Criteria:**
- Public read API: `GET /api/spu/work-instruction/active` returning the current active SPU-creation WI as:
  ```typescript
  {
    workInstructionId: string;
    version: number;
    title: string;
    revision: string;
    effectiveDate: string;
    fileId: string | null;
    steps: Array<{
      stepNumber: number;
      title: string;
      content: string;
      partRequirements: Array<{ partNumber: string; quantity: number }>;
      fieldDefinitions: Array<{
        fieldName: string;
        fieldLabel: string;
        fieldType: 'barcode_scan' | 'manual_entry' | 'date_picker' | 'dropdown';
        isRequired: boolean;
        barcodeFieldMapping?: string;
        sortOrder: number;
      }>;
    }>;
    totalRequiredScans: number;
  }
  ```
- Auth: cookie session OR `x-agent-api-key` header (mirror existing API auth pattern in CLAUDE.md).
- Returns `404` when no active SPU-creation WI exists.
- This endpoint is consumed by the future manufacturing-page PRD; no UI is built against it in this PRD.

**Technical Notes:**
- Route: `src/routes/api/spu/work-instruction/active/+server.ts`.
- Pull through `getActiveSpuWorkInstruction()` from S4.

## Out of Scope (Tracked for Follow-up PRDs)
- WI source-file storage location and retention (separate PRD — file system, Box, or R2 backing).
- Manufacturing-page rendering and operator scan UX consuming the S8 endpoint.
- Migrating prior, manually-built SPU WIs into the new parsed schema (a one-time data project, scoped separately).
- Multi-language WI parsing.
- Image extraction from .docx/.pdf into `step.imageData` (the field exists; v1 parser does not populate it).

## Validation
- Unit: `spu-wi-parser.test.ts` against fixtures in `tests/fixtures/spu-wi/`.
- Integration: end-to-end run of Upload → Review → Induct producing one active WI; second upload retires the first.
- Concurrency: 10 parallel `generateNextSpuUdi()` calls produce 10 distinct UDIs.
- Contract: extend `npm run test:contracts` with the `/api/spu/work-instruction/active` endpoint.
- `npm run check` clean; `npm run build` green.
