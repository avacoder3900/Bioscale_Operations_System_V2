# Reagent / Traceability — Session Pickup Handoff

**Written:** 2026-06-10
**Branch:** `jq/reagent-qc-lot-tracking` (worktree: `Bioscale_Operations_System_V2-jq-reagent-qc-lot-tracking`)
**Purpose:** Pick up the reagent-QC / lot-traceability work after a break. This file is the *entry point* — the canonical design lives in [`docs/REAGENT-UNIFICATION-PRD.md`](REAGENT-UNIFICATION-PRD.md) (read that next).

---

## 0. TL;DR — where you left off

You finished **Phase A1** (server schemas + physical-barcode finalize + cross-mode lineage + finalize UI), and were in the middle of **Phase B validation** for the SuperQD Phase 1 pilot:

> diffing the real **SuperQD Phase 1 Excel SOP** against the seeded **BIMS rigid template** to confirm they match before running the pilot end-to-end and backfilling `outputSpec.catalogId`.

The breadcrumbs are 4 **uncommitted, read-only diagnostic scripts** (still sitting untracked in the working tree):

| Script | What it dumps |
|---|---|
| `scripts/diag-excel-superqd-p1.ts` / `.mjs` | Every parameter / material / step from `Super QD - Phase 1 TEOS (in progress).xlsx` |
| `scripts/diag-template-superqd-p1.ts` | The `reagent_protocol_templates` SuperQD P1 doc, field-by-field |
| `scripts/diag-protocol-definitions.ts` | research-v2's `protocol_definitions` collection (does the Excel parser already have a P1 protocol?) |

These were the "compare Excel SOP ⇄ BIMS template" investigation. They are read-only against Atlas / the reference spreadsheet — safe to re-run anytime.

**Next concrete step:** run the three diag scripts, eyeball the diff, then proceed to the Phase B checklist in §5.

---

## 1. Load context properly (two repos + reference snapshot)

The reagent system spans **two apps sharing one MongoDB Atlas cluster**:

| Role | Path | What it owns |
|---|---|---|
| **BIMS** (this repo) | `…\Bioscale_Operations_System_V2-jq-reagent-qc-lot-tracking` | Rigid conjugation flows: **SuperQD P1→P2, Antibody Biotinylation, Bead Mix**. Sacred finalization, lineage tree, audit. |
| **research-v2** (live, separate repo) | `C:\Users\jacobq\Documents\GitHub\brevitest-research-v2` | Everything else (Cortisol prep, ad-hoc, Excel-driven). `protocol-parser.ts` (ExcelJS). **Apply research-v2 schema changes HERE, via its own PR.** |
| **research-v2 reference snapshot** | `…\<this repo>\brevitest-research-v2 (refrence 5_17_25)\` | **READ-ONLY** copy for diffing + the source Excel SOPs in `reference spread sheets/`. Never edit. |

**To reload context in a fresh session, read in this order:**
1. This file.
2. `docs/REAGENT-UNIFICATION-PRD.md` — full architecture, schema diffs, lifecycle, phasing, success criteria.
3. Memory: `reagent-unification-architecture`, `reagent-system-data-layout`, `feedback_reference_repo_is_readonly`.
4. The 3 lot-detail server files (the heart of it) — see §4.
5. Re-run `npx tsx scripts/diag-reagent-state.ts` (read-only) to confirm live Atlas counts haven't drifted.

---

## 2. The architecture in one paragraph

**Unified schema, two collections (one per app), mode-tagged.** Both apps converge on the same field shape. `mode: 'rigid' | 'flexible'` tags provenance/UI only — **no runtime behavior depends on it**; sacred middleware locks any doc once `finalizedAt` is set, universally. Rigid = the 3 conjugation flows that drive cartridge batch-to-batch variability (BIMS). Flexible = drop-in-an-Excel R&D protocols (research-v2). Shared substrate: `reagent_catalog` (78) + `reagent_inventory` (324). A vial prepped in either app is visible to both; cross-mode lineage works via two backlinks on the inventory vial: `preparedFromExecutionId` (research-v2 origin) or `preparedFromReagentLotId` (BIMS origin).

---

## 3. Current branch state (as of 2026-06-10)

> ⚠️ **The repo has TWO trunk branches that have diverged.** `origin/HEAD → origin/master` (GitHub default), but `origin/main` is the production-deploy branch carrying CV/capture + dev merges. They are **not** the same. See the separate state report — decide your branch base deliberately.

This branch vs the trunks (after `git fetch --all`):

| Compared to | This branch is… |
|---|---|
| `origin/main` | ahead **8**, behind **165** |
| `origin/dev` | ahead **8**, behind **143** |
| `origin/master` | ahead **284**, behind **49** |

The **8 ahead** are your reagent commits (already pushed to `origin/jq/reagent-qc-lot-tracking`, **not** merged anywhere):

```
d19d2e6 refactor(manufacturing): move cart-mfg routes under /manufacturing/cart-mfg/   (2026-05-20)
d120400 feat(reagent-qc): unified schema + physical-barcode finalize + cross-mode lineage (2026-05-17)
f945401 feat(reagent-qc): time + operator tracking, lineage tree, concern obs, quick-log  (2026-05-14)
acd6e74 chore(reagent-qc): simulation + readback scripts
94161f0 feat(reagent-qc): admin-password lot delete + 10-lot historical backfill
a33d6f9 feat(reagent-qc): R&D-flexibility pass — editable Setup, stock-material override
604484a feat(reagent-qc): surface Reagent Lots in root Manufacturing nav
c0bd2ce feat(reagent-qc): R&D reagent-lot tracking framework
```

**Heads up on wax flow:** commit `d19d2e6` moved the wax routes (`wax-filling`, `wax-creation`, `top-seal-cutting`, `wi-01/02/03`, `scrap`) under `src/routes/manufacturing/cart-mfg/`. **That refactor exists only on this branch** — it is not on `main` or `master`. If wax-flow work branches from a trunk, it will start from the *old* route layout.

Uncommitted in the working tree right now: `.claude/settings.local.json` (modified) + the 4 diag scripts (untracked).

---

## 4. Key files

**BIMS server (the engine):**
- `src/routes/manufacturing/reagent-lots/[lotId]/+page.server.ts` — **698 lines, the core.** `load` (returns `outputTubes` reverse-lookup), `finalize` action (physical-barcode flow: validate uniqueness, resolve catalog, create `ReagentInventory` rows, stamp `lot.outputs[]`, lock, audit), and `buildLineage()` (recursive, depth-capped 4, traverses `source='reagent_inventory'` cross-mode).
- `src/routes/manufacturing/reagent-lots/new/+page.server.ts` — lot creation, `candidateLots` for `canSourceFromSlugs` input filtering.
- `src/routes/manufacturing/reagent-lots/{+page,compare}/…` — list + side-by-side compare.
- `src/routes/manufacturing/reagent-lots/[lotId]/+page.svelte` — authorized .svelte edit: finalize popover (`pendingTubes`, `outputsPayload`).

**Models (schema additions applied this branch):**
- `src/lib/server/db/models/reagent-protocol-template.ts` — `mode`, `outputSpec.catalogId` (required for finalize), `outputSpecs[]`, Excel-provenance fields.
- `src/lib/server/db/models/reagent-lot.ts` — `inputLots.source` += `'reagent_inventory'`, `outputs[]`, `materialsUsed[]`.
- `src/lib/server/db/models/reagent-inventory.ts` — `preparedFromReagentLotId`, `source` tag.
- `src/lib/server/db/middleware/sacred.ts` — locks docs once `finalizedAt` set.

**Scripts:**
- `scripts/diag-reagent-state.ts` — read-only Atlas counts + sample shapes (re-runnable verification).
- `scripts/backfill-template-output-catalogids.ts` — `--review` / `--apply` / `--force`. **Must run before pilot** so finalize knows which catalog row to file tubes under.
- `scripts/migrate-execution-notes-to-observations.ts` — `--dry-run` / `--execute`. Run only *after* research-v2's schema is applied.
- The 4 uncommitted `diag-*-superqd-p1` / `diag-protocol-definitions` scripts (§0).

---

## 5. Phase B checklist — the actual next steps

1. **Run the diff** (you were here): `npx tsx scripts/diag-excel-superqd-p1.mjs`, `…/diag-template-superqd-p1.ts`, `…/diag-protocol-definitions.ts`. Confirm the BIMS SuperQD P1 template matches the Excel SOP parameter-for-parameter. Fix template via a seed/patch script if it drifted.
2. **Decide:** commit the 4 diag scripts (they're useful re-runnable tooling) or discard them.
3. **Backfill catalog IDs:** `npx tsx scripts/backfill-template-output-catalogids.ts --review`, eyeball matches, then `--apply`. Finalize will reject with a clear error until `outputSpec.catalogId` is set on the 6 templates.
4. **Run the pilot end-to-end** (PRD §11 success criteria):
   - Create a SuperQD Phase 1 lot → record a concern-flagged observation + QC readings → finalize with 1+ scanned barcodes → confirm `ReagentInventory` rows appear (visible in research-v2 too).
   - Create a Phase 2 lot → confirm the P1 tube shows as a selectable input → run → finalize.
   - Confirm Phase 2 lot detail renders lineage P2 → P1 → stock, and that post-finalize edits are rejected (corrections-only).
5. **research-v2 mirror (Phase A2, separate repo):** apply the §6.2 schema spec from the PRD in `C:\Users\jacobq\Documents\GitHub\brevitest-research-v2`, via that repo's PR. Then run `migrate-execution-notes-to-observations.ts --execute`.

**Later phases** (PRD §9): C = promote pattern to Biotinylation/Bead Mix; D = collection merge; E = cartridge consumption (`remainingVolume` decrement); F = LLM-assisted Excel parser.

---

## 6. Gotchas carried from the PRD / project rules

- **Don't edit the reference snapshot** `brevitest-research-v2 (refrence 5_17_25)/` — read-only. research-v2 changes go in the live repo.
- **Keep all data** — no wipes (per Jacob: even SIM-*/HIST-* test lots stay).
- nanoid string `_id`s, not ObjectId. `await connectDB()` + `.lean()` + JSON round-trip on load returns. `requirePermission()` + `AuditLog` on every mutation.
- `_id: false` (or string default) on subdoc arrays — ObjectId breaks SvelteKit serialization.
- Type check: ~10 pre-existing BIMS errors unrelated to reagent work; this branch added **0** new ones. Validate with `npm run check`.
