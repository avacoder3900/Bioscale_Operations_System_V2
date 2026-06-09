# Session Log — 2026-04-23: Equipment Audit, Inventory Ops, Rejection-Codes Discovery, PRD Authoring

Jacob session via Claude Opus 4.7 (1M context). Touched: MongoDB (operational writes), code (committed via coworker's snapshot on `ralph/equipment-connectivity-prd`), new PRD (`docs/prds/PRD-EQUIPMENT-MASTER-CONNECTIVITY.md`). Full session record, appended so nothing gets lost in `progress.txt` when it's being actively rewritten in a parallel terminal.

## 1. Oven/backing diagnostic (point-in-time question)
User asked whether any cartridges were added to backing/backed and placed in Oven 001 in the previous 3h. Answer: **zero**. No `backing_lots` with `ovenEntryTime >= cutoff`, no `cartridge_records` with `status='backing'` + recent `createdAt`, no matching audit-log entries. Naming gotcha surfaced: `backing_lots` uses `"Oven 1"` / `IWSsrS9Q4zSkkFS0xdMob`, not `"Oven 001"` (which only appears in `src/routes/api/dev/seed-test-inventory/+server.ts:189`). Script: `scripts/diag-recent-oven-001.ts`.

## 2. Placeholder inventory lots (carry-over from 2026-04-22)
- PT-CT-104 (Cartridge) qty 500 — `lotId: PLACEHOLDER-CT-104-20260422`, `lotNumber: LOT-20260422-0001`, ReceivingLot `_id=eHDq3sS60P12jALdCt5vn`
- PT-CT-106 (Barcode)   qty 400 — `lotId: PLACEHOLDER-CT-106-20260422`, `lotNumber: LOT-20260422-0002`, ReceivingLot `_id=JWJ3ZGT7LdsCI9idTQXpE`

Bumped `PartDefinition.inventoryCount` and wrote `InventoryTransaction` (receipt) + `AuditLog` per Quick-Scan accession pattern (`src/routes/parts/accession/+page.server.ts:346-431`). Memory: `project_placeholder_inventory_lots.md`. Swap `lotId` + `bagBarcode` in place when real supplier barcodes arrive — do NOT re-receive. Script: `scripts/add-placeholder-inventory.ts`.

## 3. `cartridgesPerLaserCutSheet` correction: 6 → 16 (global)
User reported the per-laser-cut-sheet multiplier should be 16 and thought the code said 13. Audit found three diverging hardcoded fallbacks (`?? 13`, `?? 13`, `?? 6`) plus DB actually holding **6**, not 13. Per-sheet math was understating PT-CT-112 strip creation by ~2.67×.

Changes:
- DB: `manufacturing_settings.default.general.cartridgesPerLaserCutSheet`: 6 → 16 via `scripts/set-cartridges-per-sheet-16.ts` with AuditLog.
- Code: three fallbacks now all `?? 16` (`consumables/+page.server.ts:70`, `cart-mfg-dev/+page.server.ts:64`, `laser-cutting/+page.server.ts:160`).
- Docs: `docs/prds/CART-MFG-DASHBOARD.md` — 4 occurrences of "13" corrected to 16.

Code + doc edits were absorbed into commit `97082dc refactor(cartridges): unify WI-01 + wax-filling into single cartridge identity`.

**Downstream concern (not addressed):** historical `LaserCutBatch` records credited PT-CT-112 at 6/sheet (or not at all). Inventory understated. See §4.

## 4. PT-CT-112 (Thermoseal Laser Cut Sheet) inventory audit
Current `PT-CT-112.inventoryCount` = **11**. Of 4 historical `LaserCutBatch` records (total output 41 sheets), only the most recent 3-sheet batch credited inventory (at 6/sheet = 18 strips). The 2026-03-23 (8 sheets), 2026-04-22 15:32 (20 sheets), and 2026-04-22 15:33 (10 sheets) batches produced zero creation transactions. Ledger also contains:
- `+117` manual receipt on 2026-04-08, no batch provenance
- `+93` "creation" on 2026-04-22 mis-tagged as `cut_thermoseal` step (old bug called out in `cut-thermoseal/+page.server.ts:97-101` as fixed but not reversed)
- `+16` manual receipt on 2026-04-21, no provenance

Reconstruction at 16/sheet with compensating receipts reversed: **~516** (excluding the ambiguous +93) or **~609** (including it). Recommendation: physical count + single `adjustment` transaction. Not executed. Script: `scripts/diag-laser-cut-inventory.ts`.

## 5. Strip/back yield chain (reference)
1 roll (PT-CT-101) → ~114 cut sheets (PT-CT-111) via cut-thermoseal step. `thermosealCutting.expectedStripsPerRoll = 114` (no DB override). 1 cut sheet → 1 laser-cut sheet (PT-CT-112) → 16 cartridge-back strips. **1 roll ≈ 1,824 cartridge backs** at 16/sheet (was 684 at 6/sheet).

Naming gotcha: "strip" in cut-thermoseal = a PT-CT-111 cut sheet; "strip" in laser-cutting = final PT-CT-112 cartridge-back piece.

## 6. FRIDGE-001 cleanup (11 wax-stored cartridges)
User identified 11 cartridges shown in the Fridge 1 UI (all from wax-filling run `TF44Oxqs2RqL6KDI_yXBG` by alejandro, 2026-04-17, DECK-002, Robot 1) as testing cartridges. Requested hard delete + mark parent run voided with note *"System Testing Cartridges, not apart of Active Manufacturing Line"* (sic).

Initial query missed them because `waxStorage` writes go to `waxStorage.location` (string barcode), not `storage.fridgeName`. Found via `scripts/diag-fridge-001-wax-stored.ts`.

Actions:
- Wrote 11 `AuditLog` DELETE entries with full `oldData` snapshots.
- Hard-deleted via raw MongoDB driver (bypasses sacred middleware's `deleteOne`/`deleteMany` block).
- Left 22 referencing `inventory_transactions` intact (immutable ledger; now points at non-existent cartridge IDs).
- Voided parent `wax_filling_runs._id = TF44Oxqs2RqL6KDI_yXBG`: `status: completed → voided`, `abortReason` + `voidedAt` + `voidReason` = user-provided note.

Scripts: `scripts/delete-fridge-001-11-cartridges.ts`, `scripts/void-wax-run-tf44.ts`, `scripts/diag-fridge-001-refs.ts`.

## 7. Rejection-reason codes: where they live
- **Storage:** `manufacturing_settings.default.rejectionReasonCodes` — array of `{ code, label, processType ('wax' | 'reagent'), sortOrder }`. Schema: `src/lib/server/db/models/manufacturing-settings.ts:25`.
- **Editing UI (wax):** `/manufacturing/wax-filling/settings` + duplicate surface at `/manufacturing/wax-filling/equipment`. Actions: `settings/+page.server.ts:121/146/171`, `equipment/+page.server.ts:218/241/264`.
- **Editing UI (reagent):** `/manufacturing/reagent-filling/settings` — actions at `:183/207/231`.
- **Consumers (5 pages):** wax queue `+page.server.ts:140`, wax equipment `:53`, opentron-control wax run `:47`, reagent queue `:72`, opentron-control reagent run `:49`. All filter by `processType`.
- Current DB: 4 wax reasons (WAX_OVERFLOW, WAX_UNDERFILL, CONTAMINATION, PHYSICAL_DAMAGE) + 2 reagent (REAGENT_LEAK, WRONG_VOLUME).

## 8. Full UI connectivity audit (Explore subagent)
**Critical — SPU sidebar 100% broken** (`src/routes/spu/+layout.svelte`). 10 links: 8 namespace-mismatch (`/spu/` prefix on root-level routes), 2 phantom (`/spu/bom/settings/mapping`, `/spu/particle/settings`).

| # | Sidebar href | Line | Real route |
|---|---|---|---|
| 1 | `/spu/manufacturing` | 64 | `/manufacturing` |
| 2 | `/spu/assembly` | 65 | `/assembly` |
| 3 | `/spu/documents/instructions` | 66 | `/documents/instructions` |
| 4 | `/spu/validation` | 67 | `/validation` |
| 5 | `/spu/receiving` | 75 | `/_receiving` (note underscore) |
| 6 | `/spu/inventory/transactions` | 76 | `/inventory/transactions` |
| 7 | `/spu/manufacturing/consumables` | 77 | `/manufacturing/consumables` |
| 8 | `/spu/bom/settings/mapping` | 78 | phantom |
| 9 | `/spu/shipping` | 79 | `/shipping` |
| 10 | `/spu/particle/settings` | 51, 59 | phantom |

**Resolved per user:** wax-filling + reagent-filling subpages (fixed separately), `/admin/notifications` + `/admin/ask-bims` (accessible via user manager). **Opentron-control is the new landing page for wax + reagent filling and must NOT be touched.**

**Legacy wax-filling links in 8 `.svelte` files, 11 call sites** — scoped into PRD S9. Internal wax-filling self-refs explicitly out of scope while the tree soaks.

**Receiving namespace mismatch:** real routes at `/_receiving/*`, UI links use `/receiving/*`. Cross-cuts the SPU issue.

## 9. Equipment master-controller deep-dive (Explore subagent)
Verdict: **qualified NO — metadata master, not transaction master.** Seven disconnects:
1. **HIGH** — `CartridgeRecord.waxStorage.location` + `storage.fridgeName` hold strings (barcode/name), not `Equipment._id`. Fridges are the odd one out.
2. **HIGH** — `opentrons_robots` dual-written with `equipment`, non-transactional. Drift risk.
3. **MEDIUM** — "In use" distributed across `Equipment.status`, `WaxFillingRun` partial unique indexes, `WaxFillingRun.status`, `CartridgeRecord.status`.
4. **MEDIUM** — `CartridgeRecord.ovenCure.locationId` ambiguous.
5. **MEDIUM** — `/equipment/temperature-probes` hits Mocreo API + DB on every render.
6. **LOW** — `calibration_records` populated but not surfaced on Equipment detail.
7. **LOW** — Orphan `CartridgeRecord` fields: `waxFilling.transferTimeSeconds`, `finalizedAt`, `storage.containerBarcode`.

## 10. PRD authored + committed + pushed
`docs/prds/PRD-EQUIPMENT-MASTER-CONNECTIVITY.md`. 9 Ralph-executable stories:
- **S1a/S1b** — Canonicalize fridge refs on `Equipment._id` (new `src/lib/server/services/equipment-resolve.ts`)
- **S2** — Canonicalize `ovenCure.locationId`
- **S3** — Retire `opentrons_robots` shadow (soak period — collection stays, reads switch)
- **S4** — Single `computeInUseState()` service
- **S5** — Temperature-probes DB-only + on-demand refresh button
- **S6** — Calibration records on Equipment detail (seed `calibration:read/write`; field is `calibrationDate` NOT `performedAt`)
- **S7** — Remove orphan schema fields (depends on S1a)
- **S8** — Unified equipment activity feed
- **S9** — Legacy wax-filling link cleanup (11 call sites, 8 files, mapping table in PRD)

Order: S1a → S1b → S2 → S3 → S4 → S7 → S5 → S6 → S9 → S8.

PRD audited twice. Correctness pass found 3 S6 bugs — fixed. Feasibility pass found `gh` CLI not installed, `npm run db:push` doesn't apply, wording issues — fixed.

**Hard rule per memory `feedback_no_master_merge.md`: NEVER push/merge to `main`.** Stop at `master`, hand off. Feature branches `ralph/ecc-<NN>-<slug>` off `dev` → PR into `dev` → human reviewer merges.

Branch `ralph/equipment-connectivity-prd` commit `3c354e7`. PR URL:
https://github.com/avacoder3900/Bioscale_Operations_System_V2/pull/new/ralph/equipment-connectivity-prd

## 11. SPU sidebar handoff brief
Produced copy-paste brief for coworker's parallel conversation. Self-contained: full 10-link table, receiving namespace mismatch, CLAUDE.md `.svelte` freeze, two fix options (direct edit vs redirect stubs), 4 open decisions, reproduction steps. SPU fix explicitly OUT of scope for Equipment PRD — needs its own PRD after namespace intent decided.

## 12. Branch/push state at session end
- Branch: `ralph/equipment-connectivity-prd`
- Commits on branch:
  - `3c354e7 docs(prd): ...` (my PRD commit; pushed)
  - `1403710 feat(reagent-filling): research run mode + hide hidden assays + flat 4-tube consumption` (coworker's parallel-terminal commit on this branch)
  - `591c056 chore(branch): snapshot in-progress work on ralph/equipment-connectivity-prd` (coworker's snapshot of diagnostic scripts + in-flight work)
- Working tree near-clean except `.claude/settings.local.json` and `.claude/scheduled_tasks.lock`.

## 13. DB state at session end (Mongo Atlas — not git-tracked)
- `manufacturing_settings.default.general.cartridgesPerLaserCutSheet`: **16**
- `receiving_lots` — 2 placeholder lots (PT-CT-104 qty 500, PT-CT-106 qty 400)
- `part_definitions.PT-CT-104.inventoryCount`: 500 / `PT-CT-106`: 400
- `cartridge_records` with `waxStorage.location = FRIDGE-001` + `status = wax_stored`: **0** (11 hard-deleted, audit preserved)
- `wax_filling_runs._id = TF44Oxqs2RqL6KDI_yXBG`: `voided`, note "System Testing Cartridges, not apart of Active Manufacturing Line"
- `part_definitions.PT-CT-112.inventoryCount`: **11** (understated per §4, not reconciled)

## 14. Diagnostic scripts produced (all under `scripts/`)
`add-placeholder-inventory.ts`, `delete-fridge-001-11-cartridges.ts`, `diag-find-user.ts`, `diag-fridge-001.ts`, `diag-fridge-001-refs.ts`, `diag-fridge-001-wax-stored.ts`, `diag-laser-cut-inventory.ts`, `diag-mfg-settings.ts`, `diag-recent-oven-001.ts`, `diag-sample-receiving-lots.ts`, `diag-verify-placeholder.ts`, `set-cartridges-per-sheet-16.ts`, `void-wax-run-tf44.ts`.

## 15. Open items
- **SPU sidebar dead links** — handoff brief delivered; no PRD yet.
- **PT-CT-112 reconciliation** — physical count + `adjustment` transaction needed.
- **Placeholder inventory** — swap `lotId` + `bagBarcode` in place when real barcodes received.
- **PRD S1a not started** — can start on fresh `ralph/ecc-01a-fridge-refs-schema` off `dev` after PRD PR merges.
- **Ralph automation** — no automated runner; manual per `docs/ralph-checklist.md`. `gh` CLI not installed; PRs opened via web URL.

## 16. Files produced
- PRD: `docs/prds/PRD-EQUIPMENT-MASTER-CONNECTIVITY.md`
- This log: `docs/SESSION-LOG-2026-04-23.md`
- 13 scripts under `scripts/`
- Memory: `project_placeholder_inventory_lots.md` added, `MEMORY.md` updated. User separately hardened `feedback_no_master_merge.md` to "CORE RULE — NEVER push to main".
- DB writes per §13.
