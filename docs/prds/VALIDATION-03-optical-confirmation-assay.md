# VALIDATION-03: Optical Confirmation Assay — Per-SPU Cartridge Validation Step

## Overview
Add a new SPU validation step in which a **specific optical confirmation assay cartridge** is
attached to an SPU, run on that SPU's reader optics, and recorded as a pass/fail validation
result. This proves an assembled SPU can correctly read a known-good assay before it is released.

The cartridge-to-container assignment design is **ported from the `brevitest-research` app**
(`leo3linbeck/brevitest-research`, Svelte/SvelteKit + CouchDB), where cartridges are assigned to
an *experiment → arm*. This PRD translates that pattern to BIMS (MongoDB/Mongoose) and folds the
result into the existing per-SPU `validation` block alongside magnetometer / thermocouple /
spectrophotometer / lux.

> Reference build: `brevitest-research` is private; read with `gh api repos/leo3linbeck/brevitest-research/...`.
> It is the *knowledge source*, not a dependency — nothing from it is imported.

---

## Knowledge Transferred from `brevitest-research`

This is the durable knowledge worth carrying forward from the research build. Each item is a
pattern proven there; the BIMS column is how it lands here.

### The assignment model (research)
In research, the data shape is **Experiment → arms[] → cartridges[]**:

```
Experiment {
  _id, schema:'experiment', nextSerialNumber,
  arms: [ ExperimentArm {
    name, assayId, assayName,
    cartridges: [ ArmCartridge { barcode, status, quantity } ]   // lightweight refs
  }]
}
Cartridge {                       // standalone doc, _id === scanned barcode
  _id (=barcode), schema:'cartridge', status:'linked'|'completed',
  serialNumber, assayId, assayName, experiment, arm, expirationDate, quantity, checkpoints
}
```

**Assigning a cartridge** (`api/add-cartridge-to-arm/+server.ts`) does five things:
1. Reject if a cartridge doc with that barcode already exists (`fetchDocumentById` → "already exists").
2. Load the experiment; read the target `arm`.
3. Generate a serial number: `` `${arm.assayId}-${batchKey}-${index}` `` where
   `batchKey = experiment.folderId.slice(0,11)` and `index = experiment.nextSerialNumber % 1000`
   (zero-padded to 3 digits).
4. Create a standalone `cartridge` doc (status `linked`, `quantity:0`, `checkpoints.created/linked`).
5. Push a lightweight `{barcode,status,quantity}` ref into `experiment.arms[arm].cartridges`,
   bump `nextSerialNumber`, `putDocument(experiment)`.

Other endpoints in the cluster:
- `load-experiment-arm-cartridges` — `bulkLoadDocuments` the arm's barcodes, **filter to `status==='completed'`**.
- `update-cartridge-quantity` — fetch, spread, put.
- `remove-experiment-arm` / `get-cartridge-attributes` — splice the arm out of `arms[]`, then
  `deleteDocument` every cartridge it referenced (cascade delete). *(Note: in the research repo
  these two endpoints are byte-identical — `get-cartridge-attributes` is mislabeled; it actually
  removes an arm. Do not copy that naming mistake.)*

### Patterns to keep
| # | Pattern (research) | Why it's valuable | BIMS translation |
|---|---|---|---|
| 1 | **Cartridge `_id` *is* the scanned barcode** | One identifier from scan → DB; no lookup table; idempotent "already exists" check is a primary-key read | `CartridgeRecord._id` already nanoid, but `spu.validation.opticalConfirmation.cartridgeBarcode` stores the scanned code; the duplicate-link guard is a query on it |
| 2 | **Container holds lightweight refs, cartridge is a standalone doc** | Container doc stays small; cartridge lifecycle (run, result) lives on its own doc and can change without rewriting the SPU | SPU stores a thin ref (`{cartridgeRecordId, cartridgeBarcode, assaySkuCode, status}`); the heavy record is the `CartridgeRecord` |
| 3 | **Deterministic serial: `assayId-batchKey-index` off a monotonic counter** | Human-readable, sortable, collision-free per container; ties cartridge to its assay + batch at a glance | Reuse for the generated barcode/serial of the confirmation cartridge (see `GeneratedBarcode` model) |
| 4 | **Status lifecycle `linked → completed`, load filters by status** | Lets the UI show "assigned but not yet run" vs "done"; the load path only surfaces finished results | `opticalConfirmation.status: pending → in_progress → passed/failed`, mirroring the other validation sub-objects |
| 5 | **Optimistic concurrency via `_rev`** | CouchDB rejects stale writes | BIMS has no `_rev`; equivalent safety comes from `applySacredMiddleware` (finalize/correction guard) + atomic `findOneAndUpdate` |
| 6 | **Cascade delete of an arm removes its cartridges** | No orphan cartridge docs | In BIMS prefer *void* over delete (sacred docs); unlink instead of hard-delete |

### Concept mapping (research → BIMS)
| research | BIMS | Notes |
|---|---|---|
| `Experiment` (container) | **`Spu`** | The thing a cartridge attaches to |
| `ExperimentArm` (assay grouping) | **the validation step** (`spu.validation.opticalConfirmation`) | One optical-confirmation step per SPU (not N arms) |
| `arm.assayId / assayName` | **`AssayDefinition`** (`skuCode`, `name`) | The specific optical confirmation assay |
| `Cartridge` (standalone, `_id`=barcode) | **`LabCartridge`** with `cartridgeType:'optical_test'` | New category; manufactured off the standard workflow. Keeps optical-test cartridges out of the product/shipping (`CartridgeRecord`) pipeline. Its `usageLog[]` already carries `spuId` + `validationSessionId` |
| `arm.cartridges[]` ref | `spu.validation.opticalConfirmation` ref fields + `LabCartridge.usageLog` entry | Thin link on the SPU; usage entry on the cartridge |
| `add-cartridge-to-arm` | `POST /api/validation/optical-confirmation/attach` | Translated below |
| `load-experiment-arm-cartridges` | session/SPU load functions | Mongoose `.find().lean()` |
| `nextSerialNumber` | `GeneratedBarcode` model / counter | Existing BIMS barcode generation |
| CouchDB `putDocument` (`_rev`) | Mongoose `save()` / `findOneAndUpdate` + `AuditLog` | + sacred middleware |
| Box (Excel/worksheets) | n/a for this feature | Research-only; ignore |

---

## Current State (BIMS)
- `spu.ts` already has a `validation` block with sibling sub-objects: `magnetometer`,
  `thermocouple`, `lux`, `spectrophotometer`, each `{status, sessionId, completedAt, rawData,
  results, failureReasons, criteriaUsed}`. **There is no `opticalConfirmation` sibling yet.**
- `validation-session.ts` (`ValidationSession`) is generic, keyed by `type` + `spuId` + optional
  `generatedBarcodeId`, with a `results[]` array and `overallPassed`. Reusable as-is.
- `lab-cartridge.ts` (`LabCartridge`) is the registry of lab/test cartridges: `barcode`,
  `serialNumber`, `lotNumber`, `expirationDate`, `status`, `cartridgeType:
  ['measurement','calibration','reference','test']`, `groupId` → `CartridgeGroup`, and a
  `usageLog[]` whose entries already carry `spuId` + `validationSessionId`. **This is the home for
  the new optical-test cartridge category** — it keeps these cartridges out of the product pipeline.
- `cartridge-record.ts` (`CartridgeRecord`) is the *product* cartridge (full wax→reagent→ship
  workflow). Optical-test cartridges are deliberately **not** product records, so they are NOT
  `CartridgeRecord`s — only their physical "captured as wax" provenance is noted on the LabCartridge.
- `assay-definition.ts` (`AssayDefinition`) is the assay master (`skuCode` unique). The optical
  confirmation assay is one of these.
- `manufacturing-settings.ts` (`ManufacturingSettings`, singleton `_id:'default'`) holds tunable
  process settings (wax/reagent/general blocks). **Home for the editable, admin-lockable optical
  confirmation threshold range.**
- Validation UI/route pattern is established and repeated for magnetometer / spectrophotometer /
  thermocouple under `src/routes/spu/validation/<type>/{+page, [sessionId], history}` with
  components in `src/lib/components/validation/<type>/`. **No `optical-confirmation` route/components yet.**
- The `.svelte` UI layer is frozen (CLAUDE.md). New validation-type components will need either the
  freeze exception (per `feedback_bims_svelte_freeze`) or a UI owner to author them.

---

## Infrastructure Needed

### 1. SPU model — add `opticalConfirmation` sub-object
Add a sibling under `spu.validation`, matching the existing shape **plus** the cartridge link:

```typescript
opticalConfirmation: {
  status: { type: String, enum: ['pending','passed','failed'], default: 'pending' },
  sessionId: String,
  completedAt: Date,
  rawData: Schema.Types.Mixed,
  results: Schema.Types.Mixed,
  failureReasons: [String],
  criteriaUsed: Schema.Types.Mixed,
  // cartridge link (the new part — ported from research arm.cartridges ref)
  labCartridgeId: String,             // → LabCartridge._id (cartridgeType:'optical_test')
  cartridgeBarcode: String,           // scanned barcode (research: cartridge _id)
  assay: { _id: String, name: String, skuCode: String },   // which optical confirmation assay
  attachedAt: Date,
  attachedBy: { _id: String, username: String }
}
```
> Additive only. `applySacredMiddleware` already guards finalized SPUs — attaching after finalize
> must go through the corrections path. One cartridge per SPU (Q2); a re-test detaches/re-attaches
> and opens a new `ValidationSession`, so the full attempt trail lives in session history while the
> sub-object always reflects the *current/latest* cartridge.

### 2. New cartridge category + capture feature (resolves Q1)
Optical-test cartridges are **manufactured off the standard workflow** (physically a wax cartridge,
no reagent/seal/ship pipeline) and must be **captured/registered** before they can be attached.

**2a. Extend the category enum** on `LabCartridge.cartridgeType`:
```typescript
cartridgeType: { type: String, enum: ['measurement','calibration','reference','test','optical_test'] }
```
Optionally seed a `CartridgeGroup` named "Optical Test" (the model already has `name/color`) so the
category is filterable in lists.

**2b. Capture endpoint** — `POST /api/validation/optical-confirmation/cartridges` (register a new
optical-test cartridge into inventory):
```typescript
requirePermission(event, 'cartridge:write');
await connectDB();
const { barcode, serialNumber, lotNumber, assaySkuCode, expirationDate } = await readJson(event);

if (await LabCartridge.findOne({ barcode }))
  return fail(400, { error: 'Cartridge already captured' });        // research "already exists" guard
const assay = await AssayDefinition.findOne({ skuCode: assaySkuCode, isActive: true });
if (!assay) return fail(400, { error: 'Optical confirmation assay not found' });

const cartridge = await LabCartridge.create({
  _id: generateId(),
  barcode, serialNumber, lotNumber, expirationDate,
  cartridgeType: 'optical_test',
  status: 'available',
  notes: `Optical confirmation assay ${assay.skuCode} — captured as wax cartridge (off-workflow)`,
  usageLog: [{ action: 'registered', newValue: assay.skuCode,
               performedBy: { _id: user._id, username: user.username }, performedAt: new Date() }],
  createdBy: user._id
});
await AuditLog.create({ /* action:'capture', resourceType:'optical_test_cartridge', resourceId: cartridge._id */ });
```
This is the "assignment feature to capture these new cartridge categories" you proposed — a small
capture screen (scan barcode + pick assay + lot/expiry) that drops cartridges into the `optical_test`
category, ready to attach.

### 3. Attach endpoint — `POST /api/validation/optical-confirmation/attach`
Direct translation of `add-cartridge-to-arm`, MongoDB-style — but it **looks up** an
already-captured optical-test cartridge (it does not mint product records):
```typescript
requirePermission(event, 'validation:write');
await connectDB();
const { spuId, cartridgeBarcode } = await readJson(event);

const spu = await Spu.findById(spuId);
if (!spu) return fail(404, { error: 'SPU not found' });
if (spu.finalizedAt) return fail(400, { error: 'SPU finalized — use corrections' });
if (spu.validation?.opticalConfirmation?.labCartridgeId)
  return fail(400, { error: 'Optical confirmation cartridge already attached' });   // research duplicate guard

const cartridge = await LabCartridge.findOne({ barcode: cartridgeBarcode, cartridgeType: 'optical_test' });
if (!cartridge)                 return fail(400, { error: 'No captured optical-test cartridge for that barcode' });
if (cartridge.status !== 'available') return fail(400, { error: `Cartridge is ${cartridge.status}` });
if (cartridge.expirationDate && cartridge.expirationDate < new Date())
  return fail(400, { error: 'Cartridge expired' });

const assay = await AssayDefinition.findOne({ skuCode: /* from cartridge.notes/group or a stored ref */ });

spu.validation.opticalConfirmation = {
  status: 'pending',
  labCartridgeId: cartridge._id,
  cartridgeBarcode,
  assay: { _id: assay._id, name: assay.name, skuCode: assay.skuCode },
  attachedAt: new Date(),
  attachedBy: { _id: user._id, username: user.username }
};
await spu.save();
// mark the cartridge consumed + log which SPU/session it went to (LabCartridge.usageLog is built for this)
cartridge.status = 'in_use';
cartridge.usageLog.push({ action: 'used', spuId: spu._id,
  performedBy: { _id: user._id, username: user.username }, performedAt: new Date() });
await cartridge.save();
await AuditLog.create({ /* action:'attach', resourceType:'spu_optical_confirmation', resourceId: spu._id */ });
```
> **Store the assay SKU on the LabCartridge** at capture (a small `assay {_id,name,skuCode}` field,
> or via `groupId`) so attach doesn't have to parse `notes`. Recommended: add an explicit
> `assay` sub-doc to `LabCartridge` rather than rely on `notes`.

### 4. Acceptance threshold — editable range, admin-lockable (resolves Q3)
The pass/fail range starts as an **editable field** (tune it as real data comes in) and can be
**locked by an admin** once trusted. Home it on `ManufacturingSettings` (singleton, established
settings pattern), mirroring the lock fields already used on `AssayDefinition` (`lockedAt/lockedBy`):

```typescript
// add to manufacturing-settings.ts
opticalConfirmation: {
  parameters: [{
    name: String,            // e.g. 'opticalDensity', 'channelA'
    unit: String,
    min: Number,             // editable range...
    max: Number,             // ...adjust until data is solid
    target: Number,
    required: { type: Boolean, default: true }
  }],
  locked: { type: Boolean, default: false },     // once true, edits require admin unlock
  lockedBy: { _id: String, username: String },
  lockedAt: Date,
  version: { type: Number, default: 1 }          // bump on each unlock→edit→relock cycle (audit trail)
}
```
- **Edit** (`PUT /api/validation/optical-confirmation/criteria`) — `requirePermission('settings:write')`;
  **refuse if `locked`** unless caller also has admin. Every edit writes `AuditLog` (old→new range).
- **Lock / unlock** (`POST .../criteria/lock`) — admin-only (`requirePermission('settings:admin')`);
  unlock bumps `version` so historical sessions retain the `criteriaUsed` snapshot they ran against.
- At run time, **snapshot** the active range into `ValidationSession.criteriaUsed` /
  `spu.validation.opticalConfirmation.criteriaUsed` so a later range change never rewrites past results.

### 5. Run + result capture
Reuse the VALIDATION-01 execution path (Particle function call → webhook/poll → evaluate criteria):
- Start: create a `ValidationSession { type: 'optical_confirmation', spuId, generatedBarcodeId? }`,
  set `spu.validation.opticalConfirmation.{status:'in_progress', sessionId}`.
- Result: store `rawData`/`results`, evaluate against the snapshotted criteria range, set
  `status: 'passed'|'failed'`, `completedAt`, and roll into the SPU-level `validation.status`.
- Mirror onto the cartridge: `LabCartridge.status` → `depleted`, and a `usageLog` entry referencing
  `validationSessionId`.

### 6. Detach / re-attach
Prefer **unlink** (clear the SPU ref; set `LabCartridge.status` back to `available` or `quarantine`,
with a `usageLog` `returned`/`status_changed` entry) over research's hard cascade delete, because
BIMS records are sacred/auditable. Provide `POST /api/validation/optical-confirmation/detach` with a
`reason`, written to `AuditLog`. Re-attach (Q2 "unless further testing is needed") opens a fresh
`ValidationSession`.

### 7. Routes & UI (freeze-aware)
Add under the existing pattern:
```
src/routes/spu/validation/optical-confirmation/
  +page.server.ts            // start/select SPU + scan cartridge → attach + run
  +page.svelte               // (frozen UI — needs owner/exception)
  [sessionId]/+page.server.ts
  [sessionId]/+page.svelte
  history/+page.svelte
  cartridges/+page.server.ts // capture/list optical-test cartridges (§2 capture feature)
  cartridges/+page.svelte
  criteria/+page.server.ts   // edit + admin-lock the threshold range (§4)
  criteria/+page.svelte
src/lib/components/validation/optical-confirmation/
  OpticalConfirmationCapture.svelte
  OpticalConfirmationResult.svelte
```
Server files are freely editable; `.svelte` files require the freeze exception.

---

## Validation Flow (end-to-end)
```
0. (once, off-workflow) Optical-test cartridges made as wax → CAPTURED via the capture screen →
   LabCartridge { cartridgeType:'optical_test', status:'available' }
1. Operator opens SPU → Validation → "Optical Confirmation"
2. Scan the optical-test cartridge barcode
3. POST /attach → guard duplicate → lookup available LabCartridge → link ↔ SPU (status: pending),
   cartridge.status → in_use
4. "Run" → create ValidationSession(type:'optical_confirmation'), snapshot criteria range → trigger reader
5. Device reads assay → result returns (webhook preferred / poll fallback)
6. Evaluate vs snapshotted range → status passed/failed on:
      - spu.validation.opticalConfirmation
      - ValidationSession.overallPassed
      - LabCartridge.status → depleted (usageLog ← validationSessionId)
7. SPU detail shows the result badge; rolls into spu.validation.status gating release
```

---

## Stories

### Phase 1 — Cartridge category + capture (the new "assignment" feature)
- **OCA-S1: Add `optical_test` category.** Extend `LabCartridge.cartridgeType` enum (§2a); add an
  explicit `assay {_id,name,skuCode}` sub-doc to `LabCartridge`; optionally seed an "Optical Test"
  `CartridgeGroup`. Additive, no migration.
- **OCA-S2: Capture endpoint + screen.** `POST /api/validation/optical-confirmation/cartridges`
  (§2b) — scan barcode + pick assay + lot/expiry → register `optical_test` LabCartridge. Duplicate
  guard + AuditLog. List/manage page at `/spu/validation/optical-confirmation/cartridges`.

### Phase 2 — Attach + SPU model (the ported core)
- **OCA-S3: Extend SPU model.** Add `opticalConfirmation` sub-object (§1). Additive, no migration.
- **OCA-S4: Attach endpoint.** `POST /.../attach` (§3) — lookup available `optical_test`
  LabCartridge, duplicate guard, link ↔ SPU, mark `in_use`, AuditLog. *(port of `add-cartridge-to-arm`)*
- **OCA-S5: Detach / re-attach.** `POST /.../detach` with reason → unlink, return cartridge, AuditLog (§6).
- **OCA-S6: Load functions.** SPU detail + session loads return linked cartridge, assay, latest result.

### Phase 3 — Criteria + execution
- **OCA-S7: Threshold range + admin lock.** Add `opticalConfirmation` block to `ManufacturingSettings`
  (§4); edit endpoint (refuse when locked w/o admin); admin lock/unlock with `version` bump + AuditLog.
  Criteria page at `/spu/validation/optical-confirmation/criteria`.
- **OCA-S8: Start run.** `ValidationSession(type:'optical_confirmation')`, snapshot criteria range,
  trigger reader, set `in_progress`. Reuse VALIDATION-01 Particle layer.
- **OCA-S9: Capture result + evaluate.** Store result, evaluate vs snapshotted range, set pass/fail
  on SPU + session + LabCartridge, roll into `spu.validation.status`.

### Phase 4 — UI + polish
- **OCA-S10: Capture/run page** — select SPU, scan cartridge, attach, run, spinner. *(freeze exception)*
- **OCA-S11: Result + history** — result badge, parameter/range table, raw data, session history.
- **OCA-S12: SPU detail integration** — optical-confirmation row in the SPU validation panel;
  gate release on pass (pending Q3 below).

---

## Open Questions for Alejandro
**Resolved (this round):**
- ✅ *Cartridge source* — captured off-workflow as a wax cartridge, registered as a new
  `LabCartridge` category `optical_test` via a dedicated capture feature (§2). Looked up at attach,
  not minted as product.
- ✅ *One per SPU* — yes, single `opticalConfirmation` sub-object; re-test detaches/re-attaches and
  opens a new `ValidationSession` (§1, §6).
- ✅ *Threshold* — editable range on `ManufacturingSettings`, admin-lockable with `version`
  snapshotting (§4).

**Still open:**
1. **Assay identity** — is there ONE fixed optical confirmation assay `skuCode`, or does the operator
   pick the assay per cartridge at capture? (PRD assumes operator picks at capture, stored on the
   LabCartridge.)
2. **Hardware path** — is the optical read done by the SPU reader via Particle (reuse VALIDATION-01),
   the existing spectrophotometer path, or a separate instrument? Drives §5.
3. **Release gating** — must optical confirmation pass before `validated` / release? All SPUs, or only
   certain customer assignments?
4. **Readout parameters** — which optical values define pass (e.g. optical density, channel A/B), and
   the starting min/max for each? Needed to seed the §4 `parameters[]` (placeholder until then).
5. **Re-test cap** — any limit on detach/re-attach cycles, or quarantine of failed cartridges?

## Technical Notes
- **CouchDB → Mongoose translation gotchas:** research's `_rev` optimistic concurrency has no BIMS
  equivalent — rely on `applySacredMiddleware` + atomic `findOneAndUpdate` for safety. Research's
  `putDocument` returns the doc with a new `_rev`; in BIMS just `save()`/`.lean()` + serialize.
- **No hard deletes.** Research cascade-deletes cartridges when an arm is removed. BIMS records are
  sacred — *unlink + status change* (`available`→`in_use`→`depleted`/`quarantine`), never delete;
  every mutation gets an `AuditLog` and a `LabCartridge.usageLog` entry.
- **IDs:** research cartridge `_id` = scanned barcode; BIMS keeps nanoid `_id` on the `LabCartridge`
  and stores the scanned code in its `barcode` field (and in `opticalConfirmation.cartridgeBarcode`).
  Don't set `_id` to a barcode.
- **Two cartridge models, don't cross them:** `optical_test` cartridges live in **`LabCartridge`**
  (lab/test consumables), never in `CartridgeRecord` (product). This is what keeps optical-test units
  off the shipping pipeline.
- **Serialization:** `.lean()` + `JSON.parse(JSON.stringify(...))` for all SvelteKit returns.
- **Sacred guard:** attaching/detaching on a finalized SPU must use the corrections path.
- **UI freeze:** new `.svelte` validation components need the freeze exception
  (`feedback_bims_svelte_freeze`) or a UI owner.

## Out of Scope (future)
- Multiple optical confirmation cartridges attached to one SPU simultaneously (single per SPU;
  re-test is sequential).
- Bulk attach/run across many SPUs.
- Optical-confirmation trending/analytics over time.
- Importing live data from the research CouchDB/Box instances.
- A general arms/experiment construct in BIMS (this PRD intentionally collapses "arm" into the
  single optical-confirmation validation step).

---

### Reference: research source files
`brevitest-research` @ `main` (read via `gh api repos/leo3linbeck/brevitest-research/contents/<path>`):
- `src/routes/api/add-cartridge-to-arm/+server.ts` — the assignment logic ported in §3 (attach)
- `src/routes/api/load-experiment-arm-cartridges/+server.ts` — status-filtered load
- `src/routes/api/update-cartridge-quantity/+server.ts`
- `src/routes/api/remove-experiment-arm/+server.ts` (== `get-cartridge-attributes`, mislabeled)
- `src/routes/experiment/+page.server.ts` — how arms→cartridges are loaded for the page
- `src/lib/types.ts` — `ArmCartridge`, `ExperimentArm`, `Experiment`, `Cartridge`
- `src/lib/server/couchdb.ts` — `fetchDocumentById`, `putDocument`, `bulkLoadDocuments`
