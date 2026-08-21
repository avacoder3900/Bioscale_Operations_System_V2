# VALIDATION-05: SPU Validation Runs — Multi-SPU Validation Tracking

**Author:** Alejandro Valdez (via Claude Code)
**Date:** 2026-07-20
**Status:** Draft
**Priority:** P1 — validation today is per-instrument and per-SPU with no batch view; operators lose track of which SPU has done which test
**Target branch:** `feat/spu-validation-runs` (branch from **`master`**)
**Related:** VALIDATION-01 (particle-driven testing), VALIDATION-02 (mag dashboard), VALIDATION-04 (optical confirmation analysis; removes the Spectrophotometer tab)

> All file paths below were verified against **`master`** (via `git show master:...` from the `perf/data-health-01` working tree on 2026-07-20).

**Decisions locked in (from product owner):**
1. Build against master.
2. A successful upload of the thermocouple CSV/XLSX file means **uploaded**, not passed. Pass/fail is a separate determination against a **set temperature acceptance range** (values to be defined — OQ-1).
3. **One SPU per UDI per run, one active run per UDI** — the same UDI cannot appear twice in a run or be in two in-progress runs at once.
4. The standard step sequence is **Magnetometer → Thermocouple → Optical Confirmation** (display order), but **no order is enforced** — any step can be executed at any time.
5. The thermocouple step reuses **master's existing `upload` pathway** (`/validation/thermocouple` — client CSV/XLSX parse → readings → stats → `ValidationSession`), not the older branch's `attachCsv` file-attachment flow (that mechanism appears only in stretch story S9 for optional raw-file retention).

---

## 1. Problem Statement

SPU validation in BIMS is organized **by instrument, not by unit or by batch**. The Validation area (`/validation`) has one tab per test type, and each tab shows only its own recent-session history. To validate a batch of SPUs an operator must:

1. Remember which SPUs are "in validation" — there is no filtered roster. `/spu/mfg` lists all SPUs with a small `Val:` badge, and its status dropdown includes `validating` only as a value you can *set*, not a lens you can *browse*.
2. Walk each SPU through each tab separately, re-selecting the SPU each time.
3. Reconstruct after the fact which tests each SPU has completed and what the results were — the only per-SPU rollup is the `validation` sub-object on the SPU detail page. **No view answers "for these 8 SPUs I'm validating this week, what's done and what's left?"**

We want a first-class **SPU Validation Run**: pick the SPUs currently in validation, start a run that logs their UDIs, and get a single live matrix of *SPU × validation step* showing exactly what has happened and what the result was. During the thermocouple step, the run prompts for the data file and pushes it through the **existing** thermocouple upload path on master — client-side CSV/XLSX parse → readings → stats → `ValidationSession` — with no new upload mechanism.

## 2. Goals

1. **"In Validation" roster:** an easy-to-navigate view listing all SPUs whose lifecycle `status` is `validating` (plus `assembled` SPUs with `validation.status: 'pending'`), with per-test progress at a glance.
2. **Start a run:** select multiple SPUs from that roster and create a **Validation Run** that snapshots their UDIs as run members.
3. **Track per-SPU, per-step state:** for every member SPU, track each step (magnetometer, thermocouple, optical confirmation) with status, links to the underlying `ValidationSession`/result data, timestamps, and operator. Steps display in the standard order but are executable in any order.
4. **Thermocouple step = existing upload path:** inside the run, the thermocouple step presents the file upload for each SPU and reuses master's current pipeline: client-side `XLSX.read` parse (CSV/XLSX), readings JSON to the server, `computeChannelStats`, `THERMO-` barcode mint, `ValidationSession` (type `'thermo'`) with full readings, and the `spu.validation.thermocouple` rollup write.
5. **Upload ≠ pass:** the step records **uploaded** on successful upload. Pass/fail is evaluated against a **standard acceptance range** (a configured min/max °C, not per-upload free entry) and recorded as a distinct state transition.
6. **Run lifecycle & audit:** runs are created, progressed, completed (or aborted) with full `AuditLog` coverage, and remain browsable as history.

## 3. Non-Goals

- **No change to how individual instrument tests execute.** Magnetometer polling, optical confirmation, and the thermocouple parsing/stats stay exactly as they are. The run is an *orchestration and bookkeeping layer*.
- **No new file-storage backend.** Raw readings continue to live on the `ValidationSession` (`results[].rawData.readings`); the original file can optionally be retained via the existing inline `spu.attachments[]` mechanism. No R2/S3.
- **No changes to sacred/finalization middleware** or non-additive schema changes.
- Lux validation (in the SPU schema, no route) is out.
- Spectrophotometer is out — VALIDATION-04 removes it.

---

## 4. Current State (master — verified 2026-07-20)

### 4.1 Validation area — `src/routes/validation/`
- `+layout.svelte` renders the tab nav; `+page.server.ts` redirects `/validation` → `/validation/magnetometer`.
- Tabs: Magnetometer (fully wired to Particle hardware; the reference flow), Spectrophotometer (being removed by VALIDATION-04), Thermocouple, Optical Confirmation.

### 4.2 Thermocouple flow — the path this PRD reuses
`src/routes/validation/thermocouple/+page.server.ts` + `+page.svelte`:
- **Client** (`+page.svelte`): drag-drop file input; `XLSX.read` parses the workbook (handles CSV and XLSX; the input's `accept` is `.csv` — widen to `.csv,.xlsx`, OQ-2), auto-detects the temperature column (header containing "temp", "°C", "celsius", "T"), builds `readings[] = {timestamp, temperature}` sorted by time, and posts them as JSON.
- **Server `upload` action** (guarded `spu:write`): validates `spuId` + readings + `minTemp/maxTemp` → `computeChannelStats(temps, minTemp, maxTemp)` (`src/lib/server/thermocouple-stats.ts`) → derives passed/failureReasons from out-of-range counts → mints `THERMO-000001` via `GeneratedBarcode` (`$inc`, upsert) → creates a `ValidationSession` (`type:'thermo'`, full `rawData.readings`, `processedData.stats/interpretation/criteria`, `config:{minTemp,maxTemp}`) → `Spu.updateOne` sets the whole `validation.thermocouple` sub-object (status/sessionId/completedAt/rawData/results/failureReasons/criteriaUsed) → `AuditLog.create({action:'thermocouple_validation_upload', ..., details})`.
- **Today the acceptance range is operator-entered per upload** and pass/fail is computed at upload time. This PRD splits that: upload records the data; evaluation applies the *standard* range (§7.3).
- The `load` returns an SPU dropdown (`status ∉ {voided, retired}`) and the last 10 thermo sessions with min/max/avg stats.

### 4.3 SPU model — `src/lib/server/db/models/spu.ts`
- Identifier is **`udi`** (unique index; nanoid `_id`); `barcode` sparse.
- **`status`** enum includes `validating` / `validated` (line 86) — the "in validation" lifecycle state; `statusTransitions[]` records changes.
- **`validation`** block: `validation.status` (`pending|passed|failed`) + per-type sub-objects `magnetometer|thermocouple|lux|spectrophotometer`, each `{status, sessionId, completedAt, rawData, results, failureReasons[], criteriaUsed}`.
- **`attachments[]`** (line 100): inline small-file storage (`kind`, `fileName`, `mimeType`, `fileSize`, `rowCount`, `content`, `sessionId`, `uploadedAt`, `uploadedBy`); pushed/pulled via actions on `/spu/[spuId]` (`+page.server.ts` ~310/332); downloaded via `GET /spu/[spuId]/attachments/[attachmentId]`.
- Servicing loop: `servicingIssues[]` + `validationResetAt` — a returned-from-servicing SPU re-enters validation (roster query must include these, OQ-3).
- SPU is **sacred**: `finalizedAt` blocks direct writes.

### 4.4 ValidationSession — `src/lib/server/db/models/validation-session.ts`
`type` (`'thermo'|'mag'|'spec'`), `spuId`, `spuUdi`, `generatedBarcodeId`, `barcode`, `status` (`pending|in_progress|running|completed|failed|timed_out`), `startedAt/completedAt`, `userId`, `config`, `results[]` (`{testType, rawData, processedData, passed, notes}`). **No run/batch grouping field today.**

### 4.5 Roster, permissions, audit
- `/spu/mfg` paginates all SPUs 50/page; no server-side status filter.
- Permissions are `spu:read` / `spu:write` everywhere in validation; no `validation:*` strings exist.
- `AuditLog` (immutable, append-only): schema is deliberately loose (free-string `action` — see the comment at `audit-log.ts:12` about enum 500s); validation flows write rich `details` objects. Follow the thermocouple action's shape.

---

## 5. Data Model

### 5.1 New model: `ValidationRun` — `src/lib/server/db/models/validation-run.ts`, collection `validation_runs`

```ts
{
  _id: string,                    // nanoid
  runNumber: string,              // 'VALRUN-000001' via GeneratedBarcode prefix 'VALRUN'
  name?: string,                  // optional operator label ("July 20 batch")
  status: 'in_progress' | 'completed' | 'aborted',
  steps: string[],                // ordered step keys — standard default:
                                  // ['magnetometer','thermocouple','optical_confirmation']
                                  // (display order only; execution order NOT enforced)
  spus: [{
    spuId: string,
    udi: string,                  // snapshot at add time (the UDI log requirement)
    addedAt: Date,
    removedAt?: Date,             // soft-remove; membership history preserved
    steps: {
      [stepKey]: {
        status: 'not_started' | 'in_progress' | 'uploaded' | 'passed' | 'failed' | 'skipped',
        //  'uploaded' is thermocouple-specific: data file received, not yet judged
        sessionId?: string,       // ValidationSession._id
        attachmentId?: string,    // optional raw-file retention on spu.attachments[]
        result?: Mixed,           // summary (e.g. {min, max, average, readingCount, durationMs})
        evaluation?: {            // thermocouple: the pass/fail determination, distinct from upload
          criteria: { minTemp: number, maxTemp: number },
          passed: boolean,
          failureReasons: string[],
          evaluatedAt: Date,
          evaluatedBy: { _id, username }
        },
        completedAt?: Date,
        completedBy?: { _id, username },
        notes?: string
      }
    }
  }],
  createdBy: { _id, username },
  startedAt: Date,
  completedAt?: Date,
  abortReason?: string,
  notes?: string
}
```

Indexes: `{ status: 1, startedAt: -1 }`, `{ 'spus.spuId': 1 }`, unique `runNumber`.

### 5.2 Membership invariants (Decision 3)
- A UDI appears **at most once** in a run's `spus[]` (enforced in `startRun`/`addSpu` actions).
- A UDI may be a member of **at most one `in_progress` run** — `startRun` checks `validation_runs.findOne({ status:'in_progress', 'spus.spuId': ..., 'spus.removedAt': null })` and rejects duplicates with a per-UDI message.

### 5.3 Source-of-truth rule
The run document is the **orchestration record**; instrument truth stays where it lives today:
- `ValidationSession` remains the per-test execution record. **Additive:** optional `runId` field so sessions created from a run are linked.
- `spu.validation.{type}` remains the per-SPU rollup the SPU detail page reads. Step completions write **both** the run cell and the existing rollup — same shape master writes today. For thermocouple, the rollup's `status` stays `pending` while the run cell is `uploaded`, and flips to `passed|failed` only on evaluation (the rollup enum has no 'uploaded' value; the run cell carries the finer state).
- **Additive config:** the standard thermocouple acceptance range lives in one place — `src/lib/server/validation/thermo-criteria.ts` exporting `{ minTemp, maxTemp }` (values TBD, OQ-1; promote to a settings document later if it needs runtime editing).

No existing field is renamed or repurposed; every field we write is declared in its schema (strict-mode lesson from the CV incident).

---

## 6. UX Specification

New tab **"Runs"** in the validation nav (`src/routes/validation/+layout.svelte`), route subtree `src/routes/validation/runs/`.

### 6.1 `/validation/runs` — roster + run list
Two stacked sections:

**A. SPUs in Validation (the roster)**
- Load: `Spu.find({ $or: [{ status: 'validating' }, { status: 'assembled', 'validation.status': 'pending' }] })` `.select('udi barcode status validation batch.batchNumber createdAt')` (never `attachments.content`), newest-first, `.lean()` + JSON round-trip.
- Table: `☑ | UDI | Batch | Status | Mag | Thermo | Optical | Active Run` — per-test chips colored from `spu.validation.{type}.status` (gray pending / green passed / red failed; thermo shows an amber "uploaded" chip when its active-run cell says so), "Active Run" links to the member run.
- Checkbox-select → **"Start Validation Run (n)"** → `?/startRun` → redirect to run detail. Rows already in an in-progress run render disabled with the run number shown (Decision 3).

**B. Validation Runs (history)**
- Table: `Run # | Name | SPUs | Progress | Status | Started | Completed | By` — progress as `passed / total steps` (e.g. `5/9`). Filter chips: In Progress / Completed / Aborted. Row links to detail.

### 6.2 `/validation/runs/[runId]` — the SPU × step matrix
Header: run number, editable name, status, started/by, notes, **Complete Run** / **Abort Run**.

One row per member SPU; columns in the standard order **Magnetometer | Thermocouple | Optical Confirmation** (display order only — every cell is actionable regardless of neighbors):

| UDI | Magnetometer | Thermocouple | Optical Conf. | Overall |
|---|---|---|---|---|
| SPU-0042 | ✅ passed · [session] | 📄 uploaded · 1,204 rows · awaiting eval | ⬜ — | 1/3 |
| SPU-0043 | ❌ failed · [session] | ✅ passed (35–41 °C) · [session] | ⬜ — | 1/3 |

- **Magnetometer / Optical cells:** deep-link to the existing instrument page pre-filled (`/validation/magnetometer?udi=...&runId=...`); completed cells link to the `ValidationSession` result. A "Record result" popover covers tests executed outside BIMS (passed/failed + notes).
- **Thermocouple cell — the data prompt (Goals 4–5):** when not complete, the cell opens the upload panel: the **same client-side parse UI as `/validation/thermocouple`** (extracted into a shared component, §7.2 — drag-drop, CSV/XLSX, temp-column autodetect, preview stats) posting to the run's `?/uploadThermo` action with the SPU pre-bound.
  - On success the cell shows **`📄 uploaded · {n} readings · min/max/avg`** — explicitly *not* a pass (Decision 2).
  - If the standard acceptance range is configured, evaluation runs immediately after upload and the cell advances to `✅ passed` / `❌ failed` with the criteria shown; if no range is configured yet, the cell stays `uploaded` with an **Evaluate** button that activates once the range exists (§7.3).
- **Row actions:** soft-remove SPU from run (audit-logged), open SPU detail.
- **Overall:** per-SPU `passed/total`; when all steps pass, a **"Mark validated"** button runs the existing `transitionStatus` path `validating → validated`.

### 6.3 SPU detail tie-in
`/spu/[spuId]` validation section gains a "Validation Runs" line listing runs the SPU is/was in, linking to run detail.

---

## 7. Design / Architecture

### 7.1 Route/server structure
```
src/routes/validation/runs/+page.server.ts        # roster + run list; startRun action
src/routes/validation/runs/+page.svelte
src/routes/validation/runs/[runId]/+page.server.ts  # run load (join sessions);
                                                    # actions: uploadThermo, evaluateThermo,
                                                    # recordStepResult, removeSpu,
                                                    # completeRun, abortRun, updateName
src/routes/validation/runs/[runId]/+page.svelte
src/lib/server/db/models/validation-run.ts
src/lib/server/validation/thermo-upload.ts        # shared server helper (7.2)
src/lib/server/validation/thermo-criteria.ts      # standard acceptance range (7.3)
src/lib/components/validation/ThermoFileUpload.svelte  # shared client parse UI (7.2)
```

### 7.2 Reusing the thermocouple upload path (the one refactor)
Master's `upload` action body moves into `src/lib/server/validation/thermo-upload.ts::processThermoUpload({ spuId, readings, criteria?, runId?, user })`, preserving today's sequence exactly: readings validation → `computeChannelStats` → `THERMO-` barcode mint → `ValidationSession` create (now with optional `runId`) → `spu.validation.thermocouple` write → `AuditLog`. Then:
- `/validation/thermocouple` `upload` calls the helper with operator-entered min/max — **zero behavior change** for the standalone page.
- The run's `?/uploadThermo` calls the helper with the **standard range** (or no criteria while OQ-1 is unresolved), then sets the run cell.
- The client-side parser (XLSX read, column autodetect, preview) is likewise extracted from `thermocouple/+page.svelte` into `ThermoFileUpload.svelte` and used by both pages, with `accept=".csv,.xlsx"`.

### 7.3 Upload vs. evaluation (Decision 2)
Two distinct records, two distinct audit events:
1. **Upload** — always succeeds independent of temperatures: stores readings + stats, creates the session, sets run cell `status:'uploaded'` with `result:{min,max,average,readingCount,durationMs}`. `spu.validation.thermocouple.status` remains `pending`.
2. **Evaluation** — applies `{minTemp, maxTemp}` from `thermo-criteria.ts` to the stored readings (re-running `computeChannelStats`): sets `evaluation{}` on the run cell, advances cell status to `passed|failed`, updates the session's `results[].passed`/`processedData.criteria`, and flips `spu.validation.thermocouple.status`. Runs automatically post-upload when the range is configured; otherwise via the **Evaluate** action later. Re-evaluation after a criteria change is allowed while the run is `in_progress` (audit-logged with old/new verdicts).

### 7.4 Write-ordering & concurrency
- Magnetometer convention: **sacred-gated SPU write first** (may throw on finalized docs), then run-doc update, then `AuditLog`.
- Run-doc updates use targeted positional `$set` (`{ _id: runId, 'spus.spuId': spuId }`, `spus.$.steps.{key}`) — never whole-array read-modify-write (PERF-01 discipline; safe under two operators sharing a run).
- `completed`/`aborted` runs are read-only at the action layer.
- Finalized SPUs are viewable in a run; mutating steps on them fail with the standard corrections message.

### 7.5 Permissions & audit
- Reads `spu:read`, mutations `spu:write` (consistent with all validation routes; no new permission string).
- `AuditLog` entries follow the master thermocouple action's shape (free-string `action` + rich `details`): `validation_run_created` (runNumber + UDI list), `validation_run_thermo_uploaded`, `validation_run_thermo_evaluated` (criteria + verdict), `validation_run_step_recorded`, `validation_run_spu_removed`, `validation_run_completed` / `_aborted`. The helper keeps emitting today's `thermocouple_validation_upload` entry unchanged.

---

## 8. Stories

### VAL-05-S1 — `ValidationRun` model + `VALRUN` sequence
Model per §5.1 with indexes; `runNumber` minted via the existing `GeneratedBarcode` `$inc` upsert pattern (mind the known `generated_barcodes` E11000 gotcha — `$setOnInsert` on upsert).
**AC:** Registered in `models/index.ts`; two concurrent creates yield distinct sequential run numbers; `npm run check` passes.

### VAL-05-S2 — Roster + run list page (`/validation/runs`)
Server-filtered roster with per-test chips and active-run linkage; run history table; "Runs" nav tab.
**AC:** Only `validating` (+ `assembled`/validation-pending) SPUs appear; chips reflect `spu.validation.*.status`; members of an active run are disabled with their run number shown; queries are `.lean()`, exclude `attachments.content`, paginate at 50 if large.

### VAL-05-S3 — `startRun` action
Multi-select → run doc with UDI snapshots, standard step set, `status:'in_progress'`; audit-logged; redirect to `[runId]`.
**AC:** Every selected SPU present with `spuId`+`udi`, all steps `not_started`; a UDI already in an active run is rejected with a per-UDI message and no partial run is created; duplicate UDIs within one submission are collapsed; empty selection → `fail(400)`.

### VAL-05-S4 — Run detail matrix (read path)
`[runId]` load joins linked `ValidationSession`s (metadata + stats, never full `rawData.readings`) and renders the matrix in the standard column order with per-SPU progress. Add optional `runId` to `ValidationSession` schema.
**AC:** Matrix reflects DB state on refresh; session links resolve; all cells actionable regardless of other cells' states (no order enforcement); a 12-SPU run loads without fetching reading arrays.

### VAL-05-S5 — Shared thermocouple upload (helper + component extraction)
Extract `processThermoUpload` (§7.2) and `ThermoFileUpload.svelte`; rewire the standalone page through both (zero behavior change); widen `accept` to `.csv,.xlsx`.
**AC:** Standalone `/validation/thermocouple` behaves byte-identically (same session shape, same audit entry, same UI flow); an `.xlsx` file parses; shared component renders on both pages.

### VAL-05-S6 — Run thermocouple step: upload then evaluate
`?/uploadThermo` (per-SPU, sets cell `uploaded` + stats; rollup stays `pending`) and `?/evaluateThermo` (applies standard range from `thermo-criteria.ts`, sets `evaluation{}`, advances to `passed|failed`, updates session + rollup). Auto-evaluate post-upload when the range is configured.
**AC:** Upload of an out-of-range file still reports **uploaded** success (Decision 2); evaluation records criteria + verdict + evaluator; re-evaluation on an in-progress run overwrites with audit trail of old→new; finalized SPU → clean error; session visible from the standalone page's history too.

### VAL-05-S7 — Record/step-result for mag & optical
`recordStepResult` (step, passed/failed, notes) for instrument-page or off-BIMS results; deep links carry `?udi=&runId=`; mirrors into `spu.validation.{type}`.
**AC:** Marking a step updates cell + rollup + audit; a magnetometer session launched from the matrix deep link appears linked in the run.

### VAL-05-S8 — Run lifecycle: complete / abort / mark-validated
`completeRun` (any time; warns on incomplete steps), `abortRun` (reason required), per-SPU **"Mark validated"** via existing `transitionStatus` when all steps passed.
**AC:** Completed/aborted runs reject mutations; abort requires a reason; "Mark validated" transitions `validating → validated` with the standard `statusTransitions[]` entry; history shows final progress.

### VAL-05-S9 (stretch) — Raw-file retention
Optionally push the original uploaded file onto `spu.attachments[]` (existing mechanism + download endpoint) with `runId`/`sessionId` links, so the as-received file survives alongside the parsed readings.
**AC:** Attachment appears on SPU detail and downloads intact; run cell links to it; 5 MB inline cap respected.

---

## 9. Open Questions / Risks

- **OQ-1 (acceptance range values):** the standard min/max °C for thermocouple acceptance is **TBD by the team**. Until set, uploads park at `uploaded` and the Evaluate action is disabled with a "criteria not yet configured" notice. Also decide: constant in `thermo-criteria.ts` vs. an editable settings doc (recommend constant first).
- **OQ-2 (xlsx accept):** master's dropzone parses XLSX fine but the file input `accept` is `.csv` only; S5 widens it to `.csv,.xlsx` on both pages — confirm no downstream assumption on CSV mimeType.
- **OQ-3 (roster scope):** should SPUs returned from servicing (`validationResetAt` set, `servicingIssues[].status:'returned'`) surface on the roster for re-validation runs? Recommend yes — include in the roster query.
- **OQ-4 (session auto-linking):** sessions started directly from instrument tabs (without the run deep link) won't auto-attach to a run; v1 accepts manual "Record result" for those. Retroactive UDI-based matching is a follow-up if it bites.
- **RISK-1 (rollup enum gap):** `spu.validation.thermocouple.status` enum is `pending|passed|failed` — no `uploaded`. We deliberately leave it `pending` until evaluation rather than widening a shared enum; anything reading the rollup keeps working. Revisit only if "uploaded but unevaluated" must be visible outside the run UI.
- **RISK-2 (concurrent operators):** two operators on one run — mitigated by positional `$set` cell updates (§7.4); last-writer-wins per cell is acceptable.
- **RISK-3 (large runs):** run docs stay small (readings live on sessions), but matrix load joins N sessions — select stats fields only, never `rawData.readings`.

## 10. Validation / Test Plan

- `npm run check` locally; Vercel branch preview build is the gate (local prod build OOMs on this machine).
- Contract-test additions: startRun → matrix load → thermo upload (out-of-range file still "uploaded") → evaluate → step record → complete; rejections: duplicate active-run UDI, duplicate UDI in one submission, mutating a completed run, finalized SPU, evaluate with no criteria configured.
- Manual: seed 3 SPUs as `validating` → roster shows them → start run → upload a real thermocouple XLSX and a CSV from the run → cells show **uploaded** with stats → set the standard range → evaluate → passed/failed with criteria shown → record mag result via deep link → complete run → SPU detail shows run link + rollups.
- Regression: standalone `/validation/thermocouple` unchanged (same session/audit shapes, same UI flow).

## 11. Out of Scope

Firmware/Particle changes; new file storage; lux workflow; spectrophotometer (removed by VALIDATION-04); enforced step ordering; batch reporting exports; editing instrument execution flows.

---

## Appendix A — File change map (all master paths)

**Add**
- `src/lib/server/db/models/validation-run.ts` (+ register in `models/index.ts`)
- `src/lib/server/validation/thermo-upload.ts` (extracted from the `upload` action)
- `src/lib/server/validation/thermo-criteria.ts` (standard acceptance range; values TBD)
- `src/lib/components/validation/ThermoFileUpload.svelte` (extracted client parse UI)
- `src/routes/validation/runs/+page.server.ts` / `+page.svelte`
- `src/routes/validation/runs/[runId]/+page.server.ts` / `+page.svelte`

**Modify**
- `src/routes/validation/+layout.svelte` — add "Runs" nav item
- `src/routes/validation/thermocouple/+page.server.ts` — `upload` delegates to shared helper (no behavior change)
- `src/routes/validation/thermocouple/+page.svelte` — use shared upload component; `accept=".csv,.xlsx"`
- `src/lib/server/db/models/validation-session.ts` — optional `runId`
- `src/routes/spu/[spuId]/+page.server.ts` — run-membership line

**Reused unchanged**
- `src/lib/server/thermocouple-stats.ts` (`computeChannelStats`)
- `GeneratedBarcode` sequence minting; `transitionStatus`; `AuditLog` pattern; `spu:read`/`spu:write`
- `GET /spu/[spuId]/attachments/[attachmentId]` (stretch S9 only)
