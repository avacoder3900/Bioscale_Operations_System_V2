# Reagent System Unification — PRD

**Status:** Draft v2 (revised 2026-05-17 after schema-decision pass and Phase A1 server code)
**Branch:** `jq/reagent-qc-lot-tracking` (forked from Nic's `feat/reagent-qc-lot-tracking`)
**Worktree:** `C:\Users\jacobq\Documents\GitHub\Bioscale_Operations_System_V2-jq-reagent-qc-lot-tracking`
**Pilot scope:** SuperQD Phase 1 → Phase 2 end-to-end

---

## 1. Context

Two reagent systems exist in parallel against the same MongoDB Atlas cluster:

1. **Research-v2** (`brevitest-research-v2`) — Jacob's flexible system. Optimized for "drop in an Excel, get a parsed protocol" via `src/lib/server/protocol-parser.ts` (ExcelJS-only deterministic walker — no LLM). Excel templates live in `reference spread sheets/`: Antibody Biotinylation v2, Active Beads v2, Nano-Orange Quantification v4, Super QD Phase 1/2 TEOS, Cortisol Cartridge Fill TEMPLATE.
2. **BIMS** (`Bioscale_Operations_System_V2`, branch `feat/reagent-qc-lot-tracking`, authored by Nic) — Rigid system focused on the three conjugation workflows that drive batch-to-batch variability: biotinylation, bead conjugation, quantum dot (SuperQD) conjugation. Adds sacred-doc finalization, lineage tree, concern-flagged observations, admin-gated delete.

Both apps share `reagent_catalog` and `reagent_inventory` collections already. The fork is on the protocol layer.

### 1.1 Live data snapshot (2026-05-17)

| Collection | Count | Notes |
|---|---|---|
| `reagent_catalog` | 78 | Real lab data. 13 bead-prepared, 13 QD-prepared, 11 stock-other, 8 buffer-prepared, 4 antibody-prepared, 4 linker-stock, 6 QD-stock, others. **Keep entirely.** |
| `reagent_inventory` | 324 | Real lab data. 287 prepared + 37 stock, all `status=active`. **0** have `preparedFromExecutionId` set — nothing has been prepped via research-v2's execution path yet. **Keep entirely.** |
| `protocol_definitions` | 8 | Research-v2 templates. Mostly draft. Only "Active Beads v3" is active. Keep — these are reference content. |
| `reagent_protocol_templates` | 6 | BIMS templates, all active: SuperQD Phase 1, SuperQD Phase 2, Antibody Biotinylation (LP2) v2, HEPES Cortisol Buffer, Cortisol Bead Mix v2, Cortisol Tracer. |
| `protocol_executions` | 3 | All `in_progress`. Effectively empty/prototyping leftovers. **Wipeable.** |
| `reagent_lots` | 20 | 1 `in_progress` (`RGN-20260514-0001`) + 19 `finalized` (10 HIST-*, 8 SIM-*, 4 UUID-named). **Keep all per Jacob's call** (even if some are test data, no harm). |
| `reagent_batch_records` | 61 | Pre-existing OT-2 cartridge filling runs. Out of scope. |

### 1.2 Why unify

- Excel templates overlap with rigid templates (SuperQD P1/P2, Antibody Biotinylation, Bead Mix exist in both systems with different schemas).
- Lineage requires cross-app visibility (research-v2 prepped vials may feed BIMS runs, and vice versa).
- Drift risk grows the longer two pipelines run side-by-side. Catch it now while real `reagent_lots` data is small.

---

## 2. Architecture Decision

**Unified schema. Both apps' models converge to the same shape. Two collections for now (one per app); merge to a single collection is a future cleanup (Phase A2).**

### 2.1 Mode tagging — what `mode` means

A new `mode: 'rigid' | 'flexible'` tag on templates (and on runs, via templateMode lookup) distinguishes provenance and UI affordances. **No behavior depends on mode at runtime** — sacred middleware applies whenever `finalizedAt` is set, regardless of mode (Jacob's call: "finalized = locked, universally"). The mode tag is for:

- Dashboards filtering "show me all rigid runs from this month"
- UI distinguishing which template was authored via Excel parse vs hand-built
- Catalog reporting (provenance of templates)

### 2.2 Three conjugation workflows are rigid

These are the templates BIMS owns under the rigid pattern:
- SuperQD Phase 1 (TEOS Shell)
- SuperQD Phase 2 (Protein Conjugation)
- Antibody Biotinylation (LP2)
- Cortisol Bead Mix
- (additional bead/QD/biotinyl protocols added by explicit decision)

Everything else (Cortisol Tracer, HEPES Cortisol Buffer, Cortisol Reagent Aliquoting, Nano-Orange, ad-hoc Excel imports) runs in research-v2's flexible mode.

### 2.3 Two collections, one schema (for now)

Both `reagent_protocol_templates` (BIMS) and `protocol_definitions` (research-v2) carry the same field shape going forward. Same for `reagent_lots` and `protocol_executions`. Cross-app queries union the two. When ready to merge into a single collection (Phase A2), it's a rename + data merge with low coordination cost because the shapes already match.

### 2.4 Where each app owns code

| Concern | BIMS owns | Research-v2 owns |
|---|---|---|
| Rigid template authoring + UI | ✓ | — |
| `ReagentLot` execution runner UI (per-step QC, observations, lineage tree) | ✓ | — |
| `protocol_definitions` Excel-parse UI | — | ✓ |
| `protocol-parser.ts` (ExcelJS deterministic walker) | — | ✓ |
| Catalog + Inventory CRUD UI | — | ✓ (BIMS reads) |
| Cartridge-fill consumption from rigid lots | ✓ (Phase E) | — |
| LLM-assisted Excel parser (future) | — | ✓ (Phase F, deferred to post-Monday once agent code reviewed) |

### 2.5 Cross-repo policy

The folder `brevitest-research-v2 (refrence 5_17_25)/` inside the BIMS worktree is a **reference snapshot for reading only.** Schema updates to research-v2's models live in the actual `brevitest-research-v2` repo at `C:\Users\jacobq\Documents\GitHub\brevitest-research-v2\` and are applied via that repo's own PR/review process. This PRD describes the research-v2 schema deltas as **specifications** — they are NOT changes made in this branch.

---

## 3. Shared Substrate

Both modes read and write the same physical-data collections. **Schema changes are additive.**

### 3.1 `reagent_catalog` (78 docs)

Master list of reagent types. No structural change. Both apps continue to read.

### 3.2 `reagent_inventory` (324 docs)

Per-tube inventory with barcode `_id`. **Two additive fields on the BIMS-side model, mirror needed in research-v2-side model:**

```ts
preparedFromReagentLotId: String  // BIMS-origin tubes (ReagentLot._id)
source: 'bims' | 'research-v2' | 'manual'  // provenance tag
```

A prepared tube has exactly one of `preparedFromExecutionId` (research-v2 origin) or `preparedFromReagentLotId` (BIMS origin) set. Stock tubes have neither.

### 3.3 Cross-mode lineage

```
ReagentInventory tube (barcode = _id)
  ├─ preparedFromExecutionId → ProtocolExecution (research-v2)
  │                              └─ materialsUsed[].inventoryId → ReagentInventory parents
  │                                                                  └─ ... recurse ...
  └─ preparedFromReagentLotId → ReagentLot (BIMS)
                                  └─ inputLots[].sourceId → ReagentLot (BIMS parent — direct)
                                  └─ inputLots[].sourceId (source='reagent_inventory')
                                                          → ReagentInventory tube → either backlink → recurse
```

BIMS's `buildLineage()` walker (in `[lotId]/+page.server.ts`) now traverses `source='reagent_inventory'` and follows whichever backlink the tube has. Research-v2 origins render as a leaf with a label like "Prepared via research-v2 execution {id}" — full drill-in via the traceability API.

---

## 4. Shared `observations[]` Subdoc

Free-form notes at every step in both modes (Jacob's call):

```ts
const observationSchema = new Schema({
  _id: { type: String, default: () => generateId() },
  promptKey: String,            // optional: ties to template observationPrompts[].key
  body: String,                 // free-form
  concern: { type: Boolean, default: false },
  enteredBy: { _id: String, username: String },
  enteredAt: Date,
  updatedAt: Date
});
```

- **BIMS `ReagentLot.stepEntries[].observations[]`** — already present, no change.
- **Research-v2 `ProtocolExecution.stepRecords[]`** — spec calls for adding `observations[]` alongside the existing `notes: String` (back-compat one release, then drop). One-shot migration script `scripts/migrate-execution-notes-to-observations.ts` mirrors `notes` → `observations[0]` for the 3 existing in-progress docs.

Concern-flagged observations auto-surface to dashboards across both apps via `db.collection.find({ 'stepEntries.observations.concern': true })`.

---

## 5. SuperQD Phase 1 → Phase 2 Pilot

### 5.1 Templates (already seeded)

The 6 BIMS templates are in `reagent_protocol_templates`. Phase 1 and Phase 2 already have the `canSourceFromSlugs` filter wired (Phase 2's "input QD-shell lot" material only accepts Phase 1 finalized lots). Verified via the diagnostic script `scripts/diag-reagent-state.ts`.

What still needs to happen per template: **`outputSpec.catalogId` must be set** so finalize knows which catalog row to file output tubes under. The script `scripts/backfill-template-output-catalogids.ts --review` proposes matches by name heuristic; `--apply` writes them. Operator-reviewed before any DB write.

### 5.2 Lot lifecycle (Phase 1 → Phase 2) — physical barcode flow

**Phase 1 lot creation** (`/manufacturing/reagent-lots/new`)
1. Chemist picks template, enters parameters (wavelength, final volume), scans/types lot barcode.
2. Creates `ReagentLot` with `status='in_progress'`, `templateId`/`templateVersion` pinned.
3. `inputLots[]` lists stock materials scanned in.

**Phase 1 execution** (`/manufacturing/reagent-lots/[lotId]`)
4. Operator records per-step `qcReadings[]` (typed against template `qcCheckpoints[]`), `observations[]` (with optional `concern: true`), step notes. Out-of-range readings auto-push to `lot.flags[]`.
5. Lot-level summary (`saveFinal` action) captures concentration / volume / notes the chemist intends as the run's headline output.

**Phase 1 finalize — barcode capture (NEW flow)**
6. Chemist physically labels each output tube with a printed barcode.
7. In the finalize popover (UI per §7.1), chemist adds one row per tube and **scans each barcode** into the row. Optional per-tube concentration / volume / notes (defaults inherit from `outputSpec`).
8. Zero rows is valid (failed run — lot still finalizes, no inventory rows created).
9. Submit triggers `finalize` action which:
   - Validates barcodes (non-empty unique within submission, not already present in `reagent_inventory`).
   - Resolves catalog for each tube (per-tube `outputSpecKey` → `template.outputSpecs[].catalogId`, fallback to `template.outputSpec.catalogId`).
   - Creates one `ReagentInventory` row per tube with `_id=barcode`, `type='prepared'`, `preparedFromReagentLotId=lot._id`, `source='bims'`, concentration/volume per scan.
   - Stamps `lot.outputs[]` with the barcode list for self-contained record.
   - Sets `finalizedAt = now` → sacred middleware locks subsequent direct mutations.
   - Writes an `AuditLog` row per action: one for the lot finalize, one per created inventory tube.

**Phase 2 lot creation**
10. Chemist picks `SuperQD - Phase 2`. The "input QD-shell lot" material dropdown shows finalized Phase 1 lots (via `candidateLots` query + `canSourceFromSlugs`).
11. Operator can also pick directly from `reagent_inventory` tubes — that goes in `inputLots[]` with `source='reagent_inventory'` (handled by the lineage walker).

**Phase 2 execution + finalize** — same pattern, generates the next-generation inventory tubes.

### 5.3 Lineage display

`buildLineage()` walks `inputLots[]` recursively (depth-capped at 4). Behavior per source:
- `source='reagent_lot'` — fetch parent ReagentLot, recurse.
- `source='reagent_inventory'` — fetch inventory tube, then:
  - If `preparedFromReagentLotId` set → recurse into that BIMS lot.
  - Else if `preparedFromExecutionId` set → render as leaf labelled "Prepared via research-v2 execution {id}".
  - Else → render as leaf labelled "Stock vial (mfr lot {x})".
- `source='stock' | 'receiving_lot' | 'manual'` → leaf, no recursion.

### 5.4 Cartridge consumption — deferred

`ReagentLot.remainingVolume` exists but isn't decremented yet. Cartridge-fill consumption tracking is **Phase E** per §9 (out of scope for the pilot per Jacob's call).

---

## 6. Schema Changes — Applied vs Specified

### 6.1 BIMS (applied in this branch)

**`src/lib/server/db/models/reagent-protocol-template.ts`** — added:
- `mode: 'rigid' | 'flexible'` (default 'rigid')
- `parameter.cellRef` (Excel provenance, optional)
- `parameter.isInput` (input vs derived flag, default true)
- `material.catalogId` (direct catalog link, optional)
- `material.amountFormula` (Excel formula, optional)
- `stepReagent.pipette / volume / frequency / isIntermediate` (lab choreography, optional)
- `step.substeps[]` (flexible-mode sub-bullets, optional)
- `step.contentOrder[]` (flexible-mode instruction/reagent interleave, optional)
- `outputSpec.catalogId` (REQUIRED for finalize — backfill script provided)
- `outputSpecs[]` (multi-output array with per-output catalogId)
- `cellMap: Mixed` (Excel formula preservation, optional)
- Indexes: `(mode, status)`, `outputSpec.catalogId`, `outputSpecs.catalogId`

**`src/lib/server/db/models/reagent-lot.ts`** — added:
- `inputLots.source` enum extended to include `'reagent_inventory'`
- `materialsUsed[]` (comprehensive scan log; raw activity log distinct from curated lineage)
- `stepEntry.skipped / skipReason / actualVolumes` (carried from research-v2)
- `outputs[]` (per-tube barcode array — created at finalize; supports multi-aliquot)
- `finalOutputs` kept singular for back-compat with 19 finalized lots
- Indexes: `outputs.barcode`, `inputLots.sourceId`

**`src/lib/server/db/models/reagent-inventory.ts`** — added:
- `preparedFromReagentLotId: String` (BIMS-origin backlink)
- `source: 'bims' | 'research-v2' | 'manual'` (provenance tag, default 'manual')
- Indexes: `preparedFromReagentLotId`, `source`

**`src/routes/manufacturing/reagent-lots/[lotId]/+page.server.ts`**:
- Imports `ReagentInventory` from models index
- `load` returns `outputTubes` (reverse-lookup against inventory for display)
- `finalize` action rewritten: accepts `outputs` JSON, validates uniqueness + catalog resolution, creates inventory rows, stamps `lot.outputs[]`, locks lot, writes audit rows
- `buildLineage` extended to traverse `source='reagent_inventory'` with both BIMS-lot and research-v2-execution backlinks

**`src/routes/manufacturing/reagent-lots/[lotId]/+page.svelte`** (authorized .svelte edit):
- Svelte 5 state added: `pendingTubes`, `outputsPayload` (derived JSON), `addTubeRow` / `removeTubeRow` helpers
- Simple finalize button replaced with `<details>` popover containing:
  - One row per tube: barcode input, optional outputSpec dropdown (if template has multiple), concentration/unit, volume/unit, notes
  - "+ Add another tube" button
  - Hidden field carrying `outputs` JSON payload
  - Submit button labels: "Finalize with no output (failed run)" / "Finalize & register 1 tube" / "Finalize & register N tubes"

**`scripts/`** — new:
- `diag-reagent-state.ts` (re-runnable, read-only Atlas inventory + sample shapes + lineage check)
- `backfill-template-output-catalogids.ts` (`--review` / `--apply` / `--force` — proposes matches per template, idempotent on apply)
- `migrate-execution-notes-to-observations.ts` (`--dry-run` / `--execute` — for research-v2's 3 in-progress docs)

**Type check status:** 10 pre-existing errors in BIMS (r2.ts Buffer/BodyInit, AskBimsWidget literal comparison, assembly/[sessionId]/+page.svelte implicit-any ×8). **My changes added 0 new errors.**

### 6.2 Research-v2 (specified — to be applied in the research-v2 repo separately)

Mirror the BIMS schema additions in `brevitest-research-v2/src/lib/server/db/models/`:

**`ProtocolDefinition.ts`** — add:
- `slug: String` (auto-derive from name if absent)
- `mode: 'rigid' | 'flexible'` (default 'flexible')
- `parameter.type` enum extended to include `'text'` (BIMS name)
- `parameter.helpText`
- `material.type` enum extended to include `'reused'` (BIMS name)
- `material.canSourceFromSlugs[]`
- `material.notes`
- `step.qcCheckpoints[]` (typed: key, label, type, unit, expectedMin/Max, expectedValue, helpText)
- `step.observationPrompts[]`
- `outputSpecs[]` (multi-output with per-output catalogId)
- Indexes: `(slug, version)`, `(mode, status)`, `outputSpecs.catalogId`

**`ProtocolExecution.ts`** — add:
- `definitionSlug: String`
- `finalizedAt: Date` (no enforcement middleware yet — added when research-v2 grows finalize UI)
- `status` enum extended with `'finalized'` and `'voided'`
- `voidedAt`, `voidReason`
- `inputLots[]` (same shape as BIMS, source enum includes `'protocol_execution'` for self-references)
- `stepRecords[].observations[]` (shared subdoc shape)
- `stepRecords[].qcReadings[]` (typed)
- `stepRecords[].stepKey / stepTitle / startedAt / flagged`
- `postProtocolReadings[]`
- `outputs[].outputSpecKey / catalogId / concentration / concentrationUnit / volumeUnit` (extends existing barcode/volume/notes)
- `lotNotes[]`, `flags[]`, `corrections[]`
- Indexes: `(definitionSlug, status)`, `inputLots.sourceId`

**`ReagentInventory.ts`** — add:
- `preparedFromReagentLotId: String`
- `source: 'bims' | 'research-v2' | 'manual'` (default 'manual')
- Indexes: `preparedFromReagentLotId`, `source`

These three files were drafted and reverted in the reference snapshot during this session — they are SPECIFICATIONS, not commits. Apply them in the live research-v2 repo via that repo's own PR.

---

## 7. UI Surface — What Operators See

### 7.1 Finalize popover

Click "Finalize Lot" → popover with:
- Header: "Output tubes — Scan the barcode of each physically labelled output tube..."
- Tube rows: one per labelled tube. Each row has barcode input (autofocus on scan), optional output-spec dropdown (when template has multiple outputs), per-tube concentration / unit, volume / unit, notes.
- "✕" to remove a row (always at least one empty row remains).
- "+ Add another tube" to add rows.
- Submit button auto-labels with current tube count.

If template `outputSpec.catalogId` isn't set, the server rejects with a clear error pointing the operator to the backfill script.

### 7.2 Lot detail page

Existing features (kept):
- Step rail with progress indicators
- Per-step QC reading inputs (typed against template checkpoints)
- Per-step observation inputs with concern checkbox
- Lineage tree (now cross-mode)
- Lot notes (multi-entry)
- Corrections panel for post-finalize edits

New from this branch:
- Lineage tree renders `reagent_inventory` parents (BIMS or research-v2 origin) as labelled leaves
- Once finalized: load function returns `outputTubes[]` (reverse-lookup against inventory) for display of what tubes the lot produced

---

## 8. Data Plan

### 8.1 Wipe scope (per Jacob's call: keep everything)

**Do NOT wipe anything.** Even the SIM-* and HIST-* test lots stay — no harm. The 4 UUID-named SuperQD Phase 2 finalized lots stay regardless of whether they're real.

The only data write to expect from this branch (before any operator demo):
- `scripts/backfill-template-output-catalogids.ts --apply` — sets `outputSpec.catalogId` on the 6 templates (operator-reviewed via `--review` first).
- `scripts/migrate-execution-notes-to-observations.ts --execute` — mirrors `notes` → `observations[0]` on the 3 research-v2 in-progress docs (run AFTER the research-v2 schema is applied in that repo, otherwise its model won't recognize the new field; can defer).

### 8.2 Verification

Re-run `npx tsx scripts/diag-reagent-state.ts` any time to inventory counts + sample shapes. The diagnostic script is read-only.

---

## 9. Phasing

**Phase A1 — Server schemas + finalize + lineage + UI (THIS BRANCH, COMPLETE)**
- BIMS schema additions applied
- `finalize` action rewritten with physical barcode flow
- `buildLineage` extended for cross-mode traversal
- `.svelte` finalize popover added (user-authorized .svelte edit)
- Migration + backfill scripts written (not yet run)
- `npm run check` clean (0 new errors)

**Phase A2 — Research-v2 schema mirror (SEPARATE REPO)**
- Apply the §6.2 spec to `brevitest-research-v2`'s models
- Run `migrate-execution-notes-to-observations.ts --execute` once the model recognizes `observations[]`
- Coordinate via research-v2 repo's PR/review process

**Phase B — Operator validation (THIS BRANCH, after A1 ships)**
- Operator reviews `--review` output of `backfill-template-output-catalogids.ts`, adjusts hints if needed, runs `--apply`
- Operator runs a real Phase 1 → Phase 2 chain end-to-end:
  - Phase 1 in_progress → record observations + QC readings → finalize with 1+ scanned barcodes
  - Verify ReagentInventory rows appear in research-v2's inventory page
  - Create Phase 2 lot → confirm Phase 1 tube appears as eligible input → run → finalize
  - Verify Phase 2 lineage tree shows Phase 1 → stock chain

**Phase C — Promote pattern to other rigid templates (FOLLOW-UP BRANCH)**
- Antibody Biotinylation: backfill `outputSpec.catalogId`, validate finalize flow
- Cortisol Bead Mix: same
- Any other conjugation that earns rigid promotion: same

**Phase D — Collection merge (FOLLOW-UP BRANCH)**
- Migrate research-v2's 8 `protocol_definitions` into `reagent_protocol_templates` with `mode='flexible'`
- Update research-v2 model files to point at the merged collections (or maintain dual reads during transition)
- Drop old collections

**Phase E — Cartridge consumption (FOLLOW-UP BRANCH)**
- `ReagentLot.remainingVolume` decrement on reagent-fill runs
- Aliquot UI (add child tubes to an already-finalized lot)

**Phase F — LLM-assisted Excel parser (DEFERRED until Monday)**
- Jacob has the original Brevitest-agent parser code at work, will share Monday
- New endpoint in research-v2 (or shared module) that accepts Excel → LLM → proposed `ProtocolDefinition` for human review before save
- Out of scope for this PRD

---

## 10. Open Questions — Status

| # | Question | Resolution |
|---|---|---|
| 1 | Should the 4 UUID-named Phase 2 lots be wiped? | **Keep all. No wipe.** |
| 2 | Auto-create inventory tube on finalize with barcode = lot barcode? | **No — physical scan required.** Chemist labels tube then scans barcode in finalize popover. Implemented. |
| 3 | `outputSpec.catalogId` on template vs picked at finalize? | **On template** (backfill script provided). Implemented. |
| 4 | `source` tag on `reagent_inventory`? | **Yes** — `'bims' | 'research-v2' | 'manual'`. Implemented. |
| 5 | Phasing — pilot first vs unified upfront? | **Phase A1 done first; research-v2 mirror happens in separate repo via PR there.** |
| 6 | LLM parser in this PRD or separate? | **Separate (Phase F deferred to post-Monday).** |
| 7 | Permission model for cross-app writes? | Resolved via source tag — no enforcement, passive provenance. |

### 10.1 Still-open (small)

- **a.** Template authoring UI for `outputSpecs[]` (multi-output). Today, multi-output templates need to be hand-seeded via script. Acceptable for the 6 current templates. If chemists add new multi-output templates frequently, this becomes a Phase C-adjacent ask.
- **b.** Should research-v2's `protocol_executions` get sacred middleware enforcement, or stay editable? Research-v2 has no finalize UI today; field is added in the spec but not enforced. Apply enforcement when research-v2 grows a finalize action.
- **c.** Cross-app dashboards (concern-flagged observations across both apps, out-of-range readings rollup). Nice-to-have; Phase D-adjacent.

---

## 11. Success Criteria for Pilot

- ✅ A chemist creates a SuperQD Phase 1 lot, runs it, drops at least one concern-flagged observation, finalizes with 1+ scanned barcodes → corresponding `ReagentInventory` rows appear linked to the lot.
- ✅ The chemist then creates a SuperQD Phase 2 lot, the new-lot page shows that Phase 1 tube as a selectable input, picks it, runs Phase 2, finalizes → a second-generation inventory tube appears linked to Phase 2.
- ✅ The Phase 2 lot detail page renders lineage: Phase 2 → Phase 1 → (stock materials).
- ✅ Attempting to edit either lot after finalize is rejected by sacred middleware; corrections-only via the corrections UI.
- ✅ The traceability API returns the full chain when queried by Phase 2 lot ID.
- ✅ A research-v2-prepared tube (if any exist with `preparedFromExecutionId` set) used as input to a BIMS lot renders correctly as a cross-mode leaf in the lineage tree.

---

## 12. Out of Scope for This Document

- Research-v2 code changes (live in separate repo, separate PR)
- Cartridge consumption tracking (Phase E)
- LLM-assisted Excel parser (Phase F)
- Hardening biotinyl / bead workflows beyond their existing templates (Phase C)
- Collection merge (Phase D)
- Cross-app reporting / dashboards
- New protocol authoring UX
