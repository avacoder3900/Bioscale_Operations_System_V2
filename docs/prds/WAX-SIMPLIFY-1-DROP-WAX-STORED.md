# WAX-SIMPLIFY-1 — Collapse `wax_stored` into `wax_filled`

**Date:** 2026-08-17 · **Owner:** Jacob · **Status:** Approved (conversation 2026-08-17)
**Supersedes:** the `wax_filled → wax_stored` step in WAX-FLOW-3 / WAX-INSPECTION-READY-REJECTED
**Series:** WAX-SIMPLIFY-1 (this) · WAX-SIMPLIFY-2 (reject-only inspection) · WAX-SIMPLIFY-3 (reagent gate)

## Intent (Jacob)

"I want to collapse together wax filled and wax stored. I don't think we need a wax stored
status — if they have been filled with wax they are stored. Get rid of stored and let's have
filled."

## Decision

`wax_stored` is retired as a cartridge status. Wax filling ends at **`wax_filled`**. A cart is
`wax_filled` from the moment the robot run completes until it is either rejected at visual
inspection (WAX-SIMPLIFY-2) or scanned onto a reagent deck (WAX-SIMPLIFY-3).

The **fridge scan at deck removal stays** — it records real location data (`waxStorage.location`
/ `locationId`, operator, timestamp) that the fridge-occupancy views depend on. It just no longer
changes status. "Where is it" is a field; "what stage is it in" is the status. They were conflated.

## Changes

1. **Model** — `cartridge-record.ts`: remove `'wax_stored'` from the `status` enum. (Keep
   `waxStorage` subdoc + its index — still written by the fridge scan.) Update the enum comment.
2. **Shared constant** — add `src/lib/shared/cartridge-wax-status.ts` exporting
   `WAX_STAGE_STATUSES = ['wax_filled', 'wax_ready']` (carts in the wax stage, in a fridge or on a
   bench, eligible for reagent fill) and `WAX_ORDER` for lifecycle-order lists. Every consumer
   below imports from here instead of hardcoding.
3. **Producers of `wax_stored` → write `wax_filled` (or leave status alone):**
   - `wax-filling/+page.server.ts` `storeDeckAndComplete` (~L1120-1224): record fridge location,
     leave status at `wax_filled` (the run-complete step already set it), audit `cartridgeStatus:
     'wax_filled'`.
   - `opentron-control/wax/[runId]/+page.server.ts` `completeRun` (~L708-734) + the storage
     action (~L515-591): same — location yes, status flip no. `currentInventory` (~L99) reads
     `waxStorage.recordedAt ? 'in fridge' : 'on deck'` as a *location* label, not a status.
   - `quick-wax-store/+page.server.ts` + `.svelte`: repurpose as **Quick Wax Fill-Store** → lands
     carts at `wax_filled` (creates missing barcodes at `wax_filled`). Rename copy; keep route
     (bookmarks) — or fold into `quick-wax-fill` if that page already lands at `wax_filled` (check;
     if so delete quick-wax-store and its menu entry).
4. **Consumers of `wax_stored` → `WAX_STAGE_STATUSES` (with `waxStorage.location` where the
   query is about fridge contents):** `routes/+page.server.ts` (home fridge occupancy),
   `cartridge-dashboard`, `equipment/fridges-ovens`, `equipment/activity`,
   `equipment/location/[locationId]`, `inventory/fridge-storage`, `manufacturing/consumables`,
   `manufacturing/cart-mfg/+page.server.ts` + `pipeline` + `cart-mfg-dev`, `cartridge-admin`
   (queries.ts type + STAGES lists, statistics phaseOrder, dhr colors), `+page.svelte` color maps,
   `services/equipment-activity.ts` (`cartridge_wax_stored` event kind → `cartridge_wax_filled`),
   `ask-bims.ts` + `ask-bims-tier1.ts` tool descriptions (`list_cartridges_in_storage` filters
   `WAX_STAGE_STATUSES` + `waxStorage.location`; rule 9 "reagent-fill" queue = `WAX_STAGE_STATUSES`).
5. **Lifecycle-order lists** — drop `wax_stored` from every `phaseOrder` / `STAGES` array. New
   order: `… wax_filling → wax_filled → wax_ready → wax_rejected(off-ramp) → reagent_filling …`
   (`wax_qc` stays in the arrays for historical rows only — see WAX-SIMPLIFY-2).
6. **Migration** — `scripts/migrate-wax-simplify.ts` (dry-run default, `--apply`, idempotent):
   `status:'wax_stored'` → `wax_filled`, `priorStatus:'wax_stored'`, one AuditLog per cart
   (`action:'wax_simplify_migration'`). Prints counts. Same script also handles WAX-SIMPLIFY-2's
   `wax_qc` migration. **Run AFTER deploy** (code tolerates unmigrated `wax_stored` rows because
   Mongoose enum validation only applies on write; reads/counts simply won't see them in the
   wax stage until migrated).

## Not in scope

- Deleting the `waxStorage` subdoc or the fridge scan UI.
- Fridge check-out flow (`checkedOutIds` logic) — untouched, it keys on ids not status.

## Acceptance

- Completing a wax run + fridge scan leaves every cart at `wax_filled` with `waxStorage` set.
- Home page / fridges-ovens / cartridge-dashboard fridge occupancy counts still show the carts.
- `wax_stored` appears nowhere in `src/` except the migration script and historical-render
  fallbacks (color maps may keep the key so old AuditLog/DHR rows still render).
- Migration dry-run count == live `wax_stored` count; apply → 0; re-run dry → 0.
- `npm run check` at 11-error baseline, build green.
