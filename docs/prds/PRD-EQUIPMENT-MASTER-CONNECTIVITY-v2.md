# PRD v2 — Equipment Master-Controller Connectivity + Legacy Nav Cleanup

> **Revision summary (2026-04-24):** v1 reconciled against `dev` HEAD `cb6ff0d`. Findings that forced a rewrite:
> - **S1a is partially live.** `resolveFridgeId` helper exists; 3 of 5 writers already use it. Only two reagent-side writers remain unnormalized. Scope narrowed accordingly.
> - **S2 line number drifted** from 158-159 to 168-169 in the wax-opentron writer. Schema `ovenCure` block now at line 78 (was 64).
> - **S7 line numbers drifted significantly** — `transferTimeSeconds` now at **line 47** (v1 said 35), `containerBarcode` now at **line 88** (v1 said 72), `finalizedAt` now at **line 138** (v1 said 122). Schema file has grown since the v1 audit.
> - **S9 line numbers drifted** hard in `opentrons/+page.svelte` (the page was shrunk when manual checkout moved to `/manufacturing/scrap`): 156→80, 274→198, 282→206. Other files unchanged.
> - **Three NEW stories added** covering gaps v1 missed:
>   - **S2b** — cooling-tray reference normalization (unique-index risk).
>   - **S2c** — deck reference normalization (unique-index risk).
>   - **S10** — equipment hard-delete orphan guard.
> - **S8 gains one merge source** — the `manual_cartridge_removals` collection, created 2026-04-23.
> - **`getCheckedOutCartridgeIds()` filter** (added 2026-04-23, threaded through 9 occupancy queries) is orthogonal to this PRD — no conflict, no change needed. Document it so the activity feed in S8 references the collection correctly.
> - **Freezer equipment type** — explicitly **out of scope.** Per user, fridges only; freezer as a distinct type is deferred to a future PRD.
> - **Dependency graph** adds `S2 → S8`, `S2b → S4`, `S2c → S4`.

## Overview
The Equipment page (`/equipment/*`) is the intended single source of truth for every piece of equipment — fridges, ovens, decks, cooling trays, robots, temperature probes. The 2026-04-23 audit plus the 2026-04-24 follow-up confirmed it is a **metadata master** but NOT a **transaction master**: occupancy, locks, probe data, and history join inconsistently across consumer collections. This PRD makes every consumer join `equipment` on a single canonical identifier (`Equipment._id`) with denormalized display fields kept intentionally and transparently stale (historical snapshots, not live joins). It also retires the legacy `/manufacturing/wax-filling` links that still point operators to merged-out pages, puts guards on equipment deletion, and normalizes cooling-tray and deck references.

## Background

Sources: BIMS audit 2026-04-23 (v1 PRD), reconciliation audit 2026-04-24. Ten connectivity disconnects plus one legacy-nav cleanup:

1. **HIGH** — Fridge storage refs use name/barcode strings, not `Equipment._id`. Writers: 3 of 5 migrated; 2 reagent writers remain raw.
2. **HIGH** — `OpentronsRobot` shadow collection dual-written with `equipment` — no transaction, drift risk.
3. **HIGH** — Cooling-tray refs (`waxStorage.coolingTrayId`, `WaxFillingRun.coolingTrayId`) written as raw strings; `WaxFillingRun` has a partial-unique index on the tray, so drift → hard join failures.
4. **HIGH** — Deck refs (`WaxFillingRun.deckId`, `CartridgeRecord.waxFilling.deckId`) same raw-string problem; same unique-index risk, which blocks new runs from starting.
5. **CRITICAL** — `/equipment/fridges-ovens/+page.server.ts:333` performs `Equipment.findByIdAndDelete(id)` with no orphan check. Deleting a fridge that has stored cartridges silently orphans them. Same risk likely exists on `/equipment/decks-trays` delete actions.
6. **MEDIUM** — In-use lock state scattered across 4 surfaces (`Equipment.status`, `WaxFillingRun` partial unique indexes, `WaxFillingRun.status`, `CartridgeRecord.status`).
7. **MEDIUM** — `CartridgeRecord.ovenCure.locationId` ambiguous (could be `_id`, name, or barcode depending on write path).
8. **MEDIUM** — `/equipment/temperature-probes` missing a batch "refresh all" action; load is already DB-only.
9. **LOW** — `calibration_records` exists but is dead from the UI.
10. **LOW** — Orphan schema fields declared but never written (`storage.containerBarcode`, `waxFilling.transferTimeSeconds`, `finalizedAt`).
11. **LEGACY NAV** — 7 `.svelte` files still route operators to `/manufacturing/wax-filling*`; the canonical entry point is now `/manufacturing/opentron-control`. Listed in S9 with refreshed line numbers.

## Goals
- Every consumer joins `equipment` by `Equipment._id` for fridges, ovens, cooling trays, decks, and robots.
- Denormalized name/barcode fields on consumer docs are treated as **historical snapshots** — they're not kept in sync on rename and never used as join keys.
- One canonical "is this equipment in use right now?" answer, computed identically everywhere it's shown.
- Retire the `opentrons_robots` shadow collection (read-only soak, not dropped).
- Every legacy link to `/manufacturing/wax-filling*` redirected to `/manufacturing/opentron-control`.
- Equipment deletion can no longer silently orphan historical data.
- Migrations preserve sacred-document finalization and write one aggregate `AuditLog` per back-fill batch.

## Non-goals
- Adding a `freezer` equipment type — deferred to a future PRD.
- UI redesign of the Equipment section — we fix data shape and connectivity; visual layout stays.
- Replacing the Mocreo cron pipeline (stays `*/5 * * * *` via Vercel Cron).
- Changing the root-level `+layout.svelte`.
- Back-propagating renames to historical denormalized fields — those are treated as snapshots.
- Fixing the SPU sidebar dead links — separate PRD.

## Constraints — read before writing code
- **CLAUDE.md:** `.svelte` files are frozen by default. This PRD explicitly authorizes `.svelte` edits only for the files named inside each story's Acceptance Criteria.
- **Sacred docs:** `CartridgeRecord` mutations after `finalizedAt` must use the corrections array. For bulk back-fills, use the **raw MongoDB driver** via `mongoose.connection.db.collection('cartridge_records').updateMany(...)` so Mongoose sacred middleware doesn't reject the batch. Docs with `finalizedAt` set are skipped and logged as `MIGRATION_SKIPPED_FINALIZED`.
- **Checkout filter coexistence:** every new occupancy query must compose with `getCheckedOutCartridgeIds()` from `src/lib/server/checkout-utils.ts`. It filters by `_id` globally and is orthogonal to the locationId join; both filters stack with `$and` implicitly via `$nin` + other conditions in the same match.
- **Audit trail:** every mutation writes an `AuditLog` entry. Bulk migrations write one aggregate per batch with counts.
- **Mongoose, not Drizzle:** no `schema.ts`, no `npm run db:push`. Schema changes are runtime; data shape adjusted by migration scripts.
- **nanoid IDs:** no ObjectIds anywhere.
- **Validation gate per story:** `npm run check` + `npm run lint` + `npm run test:unit` must pass before commit. If schema touched, also `npx tsx scripts/seed.ts` + `npm run test:contracts`.
- **Branching:**
  - Branch naming: `ralph/ecc-<NN>-<slug>` off `dev`.
  - **NEVER push/merge to `main`.** Stop at `master`; hand off for `main` promotion.
  - Feature branch → PR into `dev` → human reviewer merges.
- **Failure handling:** if a migration discovers unresolved data (e.g., a `storage.fridgeName` value that doesn't map to any Equipment doc), skip the record, log to `audit_logs` as `MIGRATION_UNRESOLVED`, and emit a summary at end of run. Do not guess.

## Stories

### S1a — Canonicalize fridge storage references (finish the remaining writers)
**As a** BIMS developer **I want** every writer of fridge storage refs to resolve through `resolveFridgeId()` **so that** the Equipment._id-first design is complete.

**State on dev `cb6ff0d`:**
- Helper `resolveFridgeId()` in `src/lib/server/services/equipment-resolve.ts:57` — EXISTS.
- Writers already normalized: `/cartridge-admin/storage/+page.server.ts:122`, `/manufacturing/wax-filling/+page.server.ts:1101`, `/manufacturing/opentron-control/wax/[runId]/+page.server.ts:402`.
- **Writers still raw** (do these):
  - `/manufacturing/reagent-filling/+page.server.ts:~912` — writes `storage.locationId` only, from raw form input.
  - `/manufacturing/opentron-control/reagent/[runId]/+page.server.ts:~351` — writes `storage.locationId` + `storage.fridgeName` directly.

**Changes:**
1. Both remaining reagent writers call `resolveFridgeId()` before the `$set`; persist both `storage.fridgeId` (authoritative `Equipment._id`) and `storage.fridgeName` (denormalized display, keep writing for now). If `resolveFridgeId()` returns null, fail the action with a user-visible error — do NOT silently store the raw string.
2. Add a unit test for `resolveFridgeId` covering: by `_id`, by `barcode`, by `name`, null input, unknown value.
3. Final grep gate: `grep -rn "storage.fridgeName['\"]?:\s*" src/routes/` returns only writer sites inside `$set` blocks that also write `fridgeId`, plus reader `.select()` / `.find()` clauses.

**Acceptance criteria**
- [ ] All 5 writers use `resolveFridgeId()`.
- [ ] `resolveFridgeId` unit test covers 4 cases above.
- [ ] No `storage.fridgeName` write without a sibling `storage.fridgeId` write.
- [ ] `npm run check` + `npm run lint` + `npm run test:unit` pass.

**Estimated effort:** small (½ context window). **Depends on:** none.

---

### S1b — Fridge storage migration + reader switchover
**As a** BIMS developer **I want** existing cartridge records back-filled with `Equipment._id` and every reader switched to the canonical field.

**Migration script** — `scripts/migrate-fridge-refs-to-equipment-id.ts`:
1. Build `barcodeOrName → Equipment._id` map for `equipmentType: 'fridge'`.
2. For each `cartridge_records` doc where `waxStorage.location` is set and `waxStorage.locationId` is empty: resolve and `$set` `locationId`. Normalize `location` to the Equipment's current `name` only if the doc is NOT finalized; otherwise leave the string as a snapshot.
3. Same for `storage.fridgeName` → `storage.fridgeId`.
4. Skip finalized docs (log as `MIGRATION_SKIPPED_FINALIZED`).
5. Unresolvable refs — log to aggregate `AuditLog.newData.unresolved` array, do not mutate.
6. Idempotent: re-runs on already-migrated collection are no-ops (filter on "locationId empty").
7. Two phases: `--plan` (read-only, print counts) and `--apply`. One aggregate `AuditLog` per `--apply` run with action `MIGRATION_EQUIPMENT_ID_BACKFILL`.

**Reader changes** — filter occupancy by `locationId` first, fall back to the legacy string only when `locationId` is missing (log that fallback as a console warning):
- `/equipment/fridges-ovens/+page.server.ts`
- `/equipment/location/[locationId]/+page.server.ts`
- `/equipment/activity/+page.server.ts`
- `/cartridge-admin/storage/+page.server.ts`
- `/manufacturing/opentron-control/wax/[runId]/+page.server.ts`
- `/inventory/fridge-storage/+page.server.ts` — **note:** this was patched on 2026-04-23 with the checkout filter; S1b must preserve that filter when switching to `locationId`.
- `/cartridge-dashboard/+page.server.ts` — same note.

**Rename-safety property** — once every reader prefers `locationId`, renaming a fridge via the equipment page immediately flows through all active-occupancy queries without a re-migration. Denormalized display fields (`fridgeName`, `location`) remain as historical snapshots at the time of storage. Document this explicitly in `progress.txt`.

**Acceptance criteria**
- [ ] Migration runs idempotently, `--plan` then `--apply`.
- [ ] `AuditLog` entry with counts + unresolved list.
- [ ] Pre- and post-migration occupancy counts on `/equipment/fridges-ovens` match.
- [ ] Every listed reader prefers `locationId`, logs legacy fallback.
- [ ] Manual test: rename a test fridge via `/equipment/fridges-ovens` edit action; verify the occupancy count on `/inventory/fridge-storage` still attributes to the renamed fridge (by `_id`).
- [ ] `npm run check` + `npm run lint` + `npm run test:unit` pass.

**Estimated effort:** medium (½ to 1 context window). **Depends on:** S1a.

---

### S2 — Canonicalize oven references
**As a** BIMS developer **I want** every `ovenCure.locationId` write to go through a resolver.

**State on dev `cb6ff0d`:**
- `resolveOvenId()` EXISTS in `src/lib/server/services/equipment-resolve.ts:63`.
- Schema: `ovenCure.locationId` + `ovenCure.locationName` at `src/lib/server/db/models/cartridge-record.ts:78` (the block starts at line 78).
- Writer: `src/routes/manufacturing/opentron-control/wax/[runId]/+page.server.ts:168-169` writes both fields **but does NOT resolve** — the raw form value lands in `locationId`.

**Changes:**
1. Wrap the ovenCure write site in the resolver; set `locationName` from the resolved Equipment's `name` rather than trusting the caller.
2. Grep `grep -rn "ovenCure" src/routes/` — if any other writer exists, wrap it too.
3. Migration `scripts/migrate-oven-cure-refs.ts` — `--plan` / `--apply`. For every `CartridgeRecord` with `ovenCure.locationId`, resolve against oven-typed Equipment by (`_id` | `name` | `barcode`). Rewrite if resolvable, log `MIGRATION_UNRESOLVED` if not. Raw driver, skip finalized.
4. Add a unit test for `resolveOvenId`.
5. Inline comment at line 78 (ovenCure block) clarifying `locationId` is authoritative, `locationName` is a snapshot.

**Acceptance criteria**
- [ ] `resolveOvenId` unit-tested.
- [ ] Writer normalized.
- [ ] Migration runs idempotently; unresolved docs logged.
- [ ] `npm run check` + `npm run lint` + `npm run test:unit` pass.

**Estimated effort:** small (½ context window). **Depends on:** S1a (shares helper file).

---

### S2b — NEW — Canonicalize cooling-tray references
**As a** BIMS developer **I want** cooling-tray refs to join on `Equipment._id` **so that** `WaxFillingRun`'s unique-index on tray doesn't fail against drifted strings.

**Affected fields:**
- `CartridgeRecord.waxStorage.coolingTrayId`
- `WaxFillingRun.coolingTrayId`

**State on dev `cb6ff0d`:** both are written as raw form strings. Multiple readers across `/equipment/decks-trays/*`, `/equipment/activity`, `/cartridge-admin/*`.

> **Note:** the resolver's type union at `src/lib/server/services/equipment-resolve.ts:23` uses `'cooling-tray'` (dash) while the Mongoose schema enum uses `'cooling_tray'` (underscore). Fix the union before wiring the helper — otherwise `resolveByType('cooling-tray', ...)` finds nothing.

**Changes:**
1. Fix the schema-enum mismatch: the canonical type string is `'cooling_tray'`. Update the type union in the resolver to match. Add a narrow overload or a third helper.
2. Add `resolveCoolingTrayId(barcodeOrName)` in `equipment-resolve.ts`, filtering on `equipmentType: 'cooling_tray'`.
3. Update writers of `coolingTrayId` — primarily `src/routes/manufacturing/opentron-control/wax/[runId]/+page.server.ts` and `src/routes/manufacturing/wax-filling/+page.server.ts`. Resolve before write. Fail action on null resolution.
4. Migration `scripts/migrate-cooling-tray-refs.ts`, same pattern as S2. Back-fill `waxStorage.coolingTrayId` and `WaxFillingRun.coolingTrayId` on non-finalized docs.
5. Schema: keep the field name `coolingTrayId` (it IS an id now), but comment-document "holds Equipment._id (cooling_tray)".

**Acceptance criteria**
- [ ] Resolver's type union fixed to `'cooling_tray'`.
- [ ] `resolveCoolingTrayId` exported + unit-tested.
- [ ] Every writer of `coolingTrayId` in `src/routes/` resolves through the helper.
- [ ] Migration runs idempotently, `--plan` then `--apply`.
- [ ] `WaxFillingRun` partial-unique index verified green after migration (no index violation errors).
- [ ] `npm run check` + `npm run lint` + `npm run test:unit` pass.

**Estimated effort:** medium (1 context window). **Depends on:** S1a (shares helper file).

---

### S2c — NEW — Canonicalize deck references
**As a** BIMS developer **I want** deck refs to join on `Equipment._id` **so that** `WaxFillingRun`'s unique-index on deck doesn't fail against drifted strings, blocking new runs.

**Affected fields:**
- `WaxFillingRun.deckId`
- `CartridgeRecord.waxFilling.deckId`

**State on dev `cb6ff0d`:** both written as raw form strings. The `/equipment/decks-trays/+page.svelte:312` create form accepts "Deck barcode / ID…" as free text.

**Changes:**
1. Add `resolveDeckId(barcodeOrName)` in `equipment-resolve.ts`, `equipmentType: 'deck'`.
2. Update writers — `/manufacturing/wax-filling/+page.server.ts`, `/manufacturing/opentron-control/wax/[runId]/+page.server.ts`, plus any other grep hit. Resolve before write.
3. Migration `scripts/migrate-deck-refs.ts`, same pattern.
4. Comment-document the field as an Equipment._id.

**Acceptance criteria**
- [ ] `resolveDeckId` exported + unit-tested.
- [ ] Every writer of `deckId` in wax-flow routes uses the helper.
- [ ] Migration idempotent.
- [ ] `WaxFillingRun` partial-unique index on deck verified green.
- [ ] `npm run check` + `npm run lint` + `npm run test:unit` pass.

**Estimated effort:** small-to-medium (½ to 1 context window). **Depends on:** S1a.

---

### S3 — Retire `opentrons_robots` shadow collection
**As a** BIMS developer **I want** `equipment` to be the single source of truth for robots.

**Discovery phase:** grep every `OpentronsRobot` import and `opentrons_robots` string in `src/`. Record every read site in `docs/migration/notes/ecc-03-robot-discovery.md`. Do NOT pollute `progress.txt` with discovery notes; only the final summary goes there.

**Changes:**
- All reads switch to `equipment` with `equipmentType: 'robot'`.
- Remove dual-write from `/equipment/robots` actions.
- Run-once sync script `scripts/backfill-equipment-from-opentrons-robots.ts`:
  - For each `opentrons_robots._id`, find matching `equipment._id`. If missing, abort with a human-readable report.
  - For matched pairs, copy fields present on `opentrons_robots` but missing on the equipment doc.
  - `--plan` / `--apply`, aggregate AuditLog.
- Mark `OpentronsRobot` model file with a top-of-file `// DEPRECATED — see PRD Equipment Connectivity v2 S3. Read from equipment collection instead.` comment. Keep the export (soak period).
- The `opentrons_robots` collection is **not** dropped; read-only soak.

**Acceptance criteria**
- [ ] `grep -r "opentrons_robots\|OpentronsRobot" src/` returns only (a) the deprecated model file, (b) migration script, (c) any remaining intentional read with a `// TODO remove post-soak` marker.
- [ ] `/api/opentrons-lab/robots/[id]/*` endpoints read from `equipment`.
- [ ] Validation script `scripts/validate-no-robot-shadow-drift.ts` exits 0.
- [ ] `npm run check` + `npm run lint` + `npm run test:unit` pass.

**Estimated effort:** 1 context window. **Depends on:** none.

---

### S4 — Single canonical `computeInUseState()`
**As a** BIMS developer **I want** one server-side function that answers "is equipment X in use right now?"

**Module:** `src/lib/server/services/equipment-status.ts` exporting
```
computeInUseState(equipmentId: string, equipmentType: EquipmentType)
  : Promise<{ inUse: boolean; reason: string | null; lockedByRunId: string | null; lockedUntil: Date | null; operationalState: 'active' | 'offline' | 'maintenance' | 'unknown' }>
```

`inUse` means **actively locked by a run** (not "has inventory"). `operationalState` is the manual-override axis from `Equipment.status` — orthogonal to `inUse`, reported separately so UIs can show both (e.g. "offline AND in an in-flight run" is a conflict worth surfacing). Docstring must clarify this.

**Composition rule per equipment type:**
- **Robot:** `inUse` iff any `WaxFillingRun` with `robot._id === equipmentId` has `status` ∈ `WAX_PAGE_OWNED`, OR any `ReagentBatchRecord` equivalent.
- **Deck:** same, filter on `deckId`.
- **Cooling tray:** same, filter on `coolingTrayId`, status ∈ `WAX_NON_TERMINAL`.
- **Fridge:** always `{ inUse: false, reason: null, lockedByRunId: null, lockedUntil: null }`. Capacity is a separate concern.
- **Oven:** `inUse` iff any `BackingLot` with `ovenLocationId === equipmentId` and `status` ∈ `['in_oven', 'ready']`.

Every branch reads `Equipment.status` only to populate `operationalState`; never to set `inUse`.

**Reader changes:** every page that currently reads `Equipment.status` to display "In Use" (Equipment detail, fridges-ovens, decks-trays, activity, any wax-filling page still live) switches to `computeInUseState()`. Inline `Equipment.status === 'in_use'` checks removed from page loaders.

**Acceptance criteria**
- [ ] Unit tests for all 5 equipment types.
- [ ] Every consumer page uses the service.
- [ ] Inline `Equipment.status === 'in_use'` checks removed from page loaders (except where status is read into `operationalState`).
- [ ] `npm run check` + `npm run lint` + `npm run test:unit` pass.

**Estimated effort:** 1 context window. **Depends on:** S3, S2b, S2c (all three produce the identifiers this function queries on).

---

### S5 — Temperature-probes batch refresh
**As an** operator **I want** a batch "Refresh all probes" button **so that** I can force-sync the fleet without waiting for the cron.

**State on dev `cb6ff0d`:** `load()` in `src/routes/equipment/temperature-probes/+page.server.ts` reads DB-only. Existing actions: `mapSensor`, `pingSensor`, `acknowledgeAlert`, `setThresholds`.

**Changes:**
- Add form action `?/refreshAll` — invokes `runMocreoSync()` for the full fleet; returns `{ synced, errored }`.
- `.svelte` edit (authorized): one "Refresh all probes" button, ≥44px touch target, loading state, disabled during submit. Near the existing per-sensor Ping controls.
- Permission: same as page load.

**Acceptance criteria**
- [ ] `?/refreshAll` action exists.
- [ ] UI button present, loading state works.
- [ ] `load()` remains DB-only (no regression).
- [ ] `npm run check` + `npm run lint` + `npm run test:unit` pass.

**Estimated effort:** small (½ context window). **Depends on:** none.

---

### S6 — Calibration records on Equipment detail
**As an** operator **I want** to see and add calibration history on Equipment detail.

**Permission seeding (prerequisite):**
- Add `calibration:read` and `calibration:write` to `src/lib/server/permissions.ts` and the role seed. Assign `read` to all roles, `write` to admin + manufacturing-operator (mirror existing `manufacturing:write`).

**Server changes:**
- Load: `CalibrationRecord.find({ equipmentId }).sort({ calibrationDate: -1 }).limit(50).lean()`.
- Action `?/logCalibration` — creates a `CalibrationRecord` with `{ calibrationDate, nextCalibrationDue, performedBy, results, status, notes, certificateUrl? }`; writes an `AuditLog`.
- Compute "last calibrated at" as `MAX(calibrationDate)` — no denormalized field on `Equipment`.

**`.svelte` changes (authorized):** calibration section on detail page, table + add-form.

**Acceptance criteria**
- [ ] Permissions exist and are seeded.
- [ ] Table renders last 50 entries sorted desc.
- [ ] Adding persists + writes AuditLog + appears on reload.
- [ ] `calibration:write` gates the action.
- [ ] `npm run check` + `npm run lint` + `npm run test:unit` pass.

**Estimated effort:** 1 context window. **Depends on:** none.

---

### S7 — Remove orphan schema fields
**As a** BIMS developer **I want** fields that are never written by any action removed from the schema.

**Scope (all confirmed present on dev `cb6ff0d` with line numbers re-verified 2026-04-24):**
- `CartridgeRecord.waxFilling.transferTimeSeconds` — `src/lib/server/db/models/cartridge-record.ts:47` (v1 said 35).
- `CartridgeRecord.storage.containerBarcode` — `:88` (v1 said 72; comment now reads "ORPHANED: never written by any action — pending S7 cleanup").
- `CartridgeRecord.finalizedAt` — `:138` (v1 said 122).

**Changes:**
- Remove the three fields.
- Migration `scripts/scrub-orphan-cartridge-fields.ts`: `$unset` each field across all `cartridge_records` docs. Raw driver. Skip finalized docs and log `MIGRATION_SKIPPED_FINALIZED`.
- Aggregate `AuditLog`.

**Acceptance criteria**
- [ ] Three fields gone.
- [ ] Migration idempotent.
- [ ] `npm run check` + `npm run lint` + `npm run test:unit` pass.

**Estimated effort:** small (½ context window). **Depends on:** S1a (ensures `storage.fridgeId` is repurposed before any orphan scrub touches the storage subdoc).

---

### S8 — Unified equipment activity feed
**As an** operator **I want** one chronological activity feed on Equipment detail.

**Server changes:** new helper `loadUnifiedActivity(equipmentId, { since, limit })` that merges into one sorted list:
- `DeviceEvent.find({ deviceId: equipmentId })`
- `CartridgeRecord.find({ 'waxStorage.locationId': equipmentId, 'waxStorage.recordedAt': { $gte: since } })` → "Cartridge {id} stored"
- `WaxFillingRun.find({ $or: [{ deckId: equipmentId }, { coolingTrayId: equipmentId }, { 'robot._id': equipmentId }, { ovenLocationId: equipmentId }] })`
- `BackingLot.find({ ovenLocationId: equipmentId })`
- `TemperatureAlert.find({ equipmentId })`
- **NEW — `ManualCartridgeRemoval.find({ cartridgeIds: { $in: [...resolvedCartIds] } })`** where `resolvedCartIds` = cartridge IDs that had `waxStorage.locationId === equipmentId` (resolved via a nested lookup). Each hit emits a "Cartridge {id} checked out — {reason}" event.

If the equipment has no `mocreoDeviceId` but is a temp-sensitive type (fridge/oven), emit a sentinel `{ kind: 'mocreo_unmapped', summary: 'No Mocreo device mapped — temperature history unavailable' }`.

Every merged event emits `{ at: Date, kind: string, source: string, summary: string, payload: object }`.

**`.svelte` changes (authorized):** new "Activity" tab with kind-specific icons + client-side `kind` filter.

**Acceptance criteria**
- [ ] Activity tab shows a chronological merged feed from all 6 sources (including manual_cartridge_removals).
- [ ] Capped at 200 entries or 30 days, whichever is smaller.
- [ ] `mocreo_unmapped` sentinel shown when applicable.
- [ ] `kind` filter works client-side.
- [ ] `npm run check` + `npm run lint` + `npm run test:unit` pass.

**Estimated effort:** 1 context window. **Depends on:** S1a+S1b (`waxStorage.locationId` populated), S2 (`ovenCure.locationId` normalized), S4 (lock-state context in events).

---

### S9 — Legacy `/manufacturing/wax-filling` link cleanup — **LINE NUMBERS REFRESHED**
**As an** operator **I want** every "Go to Wax Filling" link to land on `/manufacturing/opentron-control`.

**Scope:** 7 `.svelte` files, 12 call sites. `opentron-control` hub replaces wax-filling and MUST NOT be touched.

**File-by-file mapping (re-verified on dev `cb6ff0d`):**

| # | File | Line | Replace with |
|---|---|---|---|
| 1 | `src/routes/manufacturing/+page.svelte` | 130 | `/manufacturing/opentron-control/settings` |
| 2 | `src/routes/manufacturing/+page.svelte` | 236 | `/manufacturing/opentron-control?robot={robot.robotId}` |
| 3 | `src/routes/manufacturing/+page.svelte` | 248 | `/manufacturing/opentron-control?robot={robot.robotId}` |
| 4 | `src/routes/manufacturing/opentrons/+page.svelte` | **80** (was 156) | `/manufacturing/opentron-control/settings` |
| 5 | `src/routes/manufacturing/opentrons/+page.svelte` | **198** (was 274) | `/manufacturing/opentron-control?robot={robot.robotId}` (single target, no ternary) |
| 6 | `src/routes/manufacturing/opentrons/+page.svelte` | **206** (was 282) | `/manufacturing/opentron-control?robot={robot.robotId}` |
| 7 | `src/routes/manufacturing/opentron-control/+page.svelte` | 66 | **Ambiguous — see note below.** |
| 8 | `src/routes/manufacturing/cart-mfg-dev/+page.svelte` | 173 | `/manufacturing/opentron-control?robot={robot.robotId}` |
| 9 | `src/routes/manufacturing/cart-mfg-dev/+page.svelte` | 186 | `/manufacturing/opentron-control?robot={robot.robotId}` |
| 10 | `src/routes/manufacturing/reagent-filling/+layout.svelte` | 202 | `/manufacturing/opentron-control?robot={robotState.robotId}` |
| 11 | `src/routes/manufacturing/reagent-filling/+page.svelte` | 341 | `/manufacturing/opentron-control?robot={data.robotId}` |
| 12 | `src/routes/manufacturing/opentron-control/settings/+page.svelte` | 30 | **Ambiguous — see note below.** |

**Rows 7 and 12** are self-links from the new hub back to the legacy settings page; resolve in PR (either remove or point to `/manufacturing/opentron-control/settings`).

**Out of scope:** internal nav inside the `src/routes/manufacturing/wax-filling/*` tree (soft-orphan soak).

**Pre-flight verification:**
1. Confirm `/manufacturing/opentron-control/settings` exists — `src/routes/manufacturing/opentron-control/settings/` should be present. If absent, fall back to `/manufacturing/opentron-control` and flag in PR.
2. Final grep: `grep -rn "/manufacturing/wax-filling" src/routes/` returns only the wax-filling tree's own internal nav and the legacy component imports under `src/lib/components/manufacturing/wax-filling/`.

**Acceptance criteria**
- [ ] All 12 call sites updated.
- [ ] Manual click-test from manufacturing dashboard lands every robot-related link on opentron-control.
- [ ] `npm run check` + `npm run lint` + `npm run test:unit` pass.

**Estimated effort:** small-to-medium (½ to 1 context window). **Depends on:** none.

---

### S10 — NEW — Equipment delete orphan guard
**As a** BIMS developer **I want** equipment deletion to fail safely when historical data still references the target **so that** we don't silently orphan cartridges, runs, or alerts.

**State on dev `cb6ff0d`:** `/equipment/fridges-ovens/+page.server.ts:333` does `Equipment.findByIdAndDelete(id).lean()` unconditionally. Verified 2026-04-24: `/equipment/decks-trays/+page.server.ts` and `/equipment/robots/+page.server.ts` do NOT have equivalent delete actions — only fridges-ovens. S10 scope is therefore fridges-ovens only, but the `hasReferences()` helper is written generically so future delete-capable pages can adopt it.

**Changes:**
1. Introduce `hasReferences(equipmentId: string, equipmentType: string): Promise<{ total: number; breakdown: Record<string, number> }>` in `src/lib/server/services/equipment-status.ts` (or a new module). Checks, per type:
   - Fridge: `CartridgeRecord.countDocuments({ $or: [{ 'waxStorage.locationId': equipmentId }, { 'storage.fridgeId': equipmentId }, { 'waxStorage.location': eq.name }, { 'waxStorage.location': eq.barcode }, { 'storage.fridgeName': eq.name }, { 'storage.fridgeName': eq.barcode }] })` plus `TemperatureAlert.countDocuments({ equipmentId })`.
   - Oven: `CartridgeRecord.countDocuments({ 'ovenCure.locationId': equipmentId })` plus `BackingLot.countDocuments({ ovenLocationId: equipmentId })` plus `LotRecord.countDocuments({ 'ovenPlacement.ovenId': equipmentId })`.
   - Robot: `WaxFillingRun.countDocuments({ 'robot._id': equipmentId })` + `ReagentBatchRecord.countDocuments({ 'robot._id': equipmentId })`.
   - Deck: `WaxFillingRun.countDocuments({ deckId: equipmentId })`.
   - Cooling tray: `WaxFillingRun.countDocuments({ coolingTrayId: equipmentId })` + `CartridgeRecord.countDocuments({ 'waxStorage.coolingTrayId': equipmentId })`.
2. Modify the fridges-ovens delete action to call `hasReferences()` first. If `total > 0`, return `fail(409, { error: 'Cannot delete: N cartridges/runs/alerts still reference this equipment' })` with breakdown.
3. Add a second action `?/archiveEquipment` that sets `isActive: false` + `status: 'offline'` + `archivedAt: <now>` instead of deleting. This is the user-facing replacement when they want equipment out of active pickers but references must persist.
4. `.svelte` edit (authorized): the delete button on `/equipment/fridges-ovens` becomes "Archive" when `hasReferences > 0`, with a tooltip explaining why.

**Acceptance criteria**
- [ ] `hasReferences()` implemented + unit-tested for all 5 types.
- [ ] Delete actions refuse when `total > 0`.
- [ ] `?/archiveEquipment` action works and sets the three flags.
- [ ] UI swaps Delete for Archive based on reference count.
- [ ] `npm run check` + `npm run lint` + `npm run test:unit` pass.

**Estimated effort:** 1 context window. **Depends on:** S1a, S2b, S2c (so `hasReferences` can join on `_id` first and fall back to name-string for un-migrated records).

---

## Dependency graph (revised)

```
S1a → S1b
S1a → S2    (shared helper)
S1a → S2b   (shared helper)
S1a → S2c   (shared helper)
S1a → S7    (storage.fridgeId repurpose before orphan scrub)
S1a → S10   (hasReferences joins fridgeId first)

S2  → S8    (ovenCure.locationId normalized before activity feed queries it)
S2b → S4    (tray _id available before computeInUseState queries it)
S2c → S4    (deck _id available before computeInUseState queries it)
S2b → S10   (tray reference check uses canonical id)
S2c → S10   (deck reference check uses canonical id)

S3  → S4    (canonical robot source before in-use computation)
S1b → S8    (locationId populated before activity feed references it)
S4  → S8    (lock-state used in event rows)

S5, S6, S9: independent, no predecessors.
```

**Recommended execution order:** S1a → S1b → S2 → S2b → S2c → S3 → S4 → S7 → S10 → S5 → S6 → S9 → S8.

## Ralph execution notes
Each story is one sub-agent session unless marked otherwise. Sub-agent steps:
1. `git checkout dev && git pull origin dev`.
2. `git checkout -b ralph/ecc-<NN>-<slug>`.
3. Read `AGENTS.md`, `CLAUDE.md`, `SECURITY.md`, **this PRD**, `progress.txt` (Codebase Patterns + recent entries).
4. Implement only the named story.
5. For any migration script: run `--plan` first, eyeball counts, then `--apply`.
6. Validate: `npm run check` + `npm run lint` + `npm run test:unit`. If schema touched: `npx tsx scripts/seed.ts` + `npm run test:contracts`.
7. Append one entry to `progress.txt`.
8. Commit with message `feat(equip-conn): ECC-<NN> - <short title>`.
9. Push the feature branch; open PR against `dev`. **Do not merge.**
10. **NEVER push or merge to `main`.**

## Rollback strategy
- Every migration keeps legacy fields populated where possible — revert by re-reading the denormalized name field.
- Each aggregate `AuditLog` has enough metadata to reconstruct pre-migration state.
- S3 regressions → revert commit, restore dual-write path; `opentrons_robots` stays in DB for soak.
- S10 regressions (false-positive refusals) → temporarily disable the `hasReferences()` gate while root-causing.
- S9 is purely link-text — revert is a one-line-per-file `.svelte` revert.

## Done definition (all 11 stories merged)
- Every page under `/equipment/*` joins `equipment` by `_id` for fridges, ovens, trays, decks, robots.
- `grep -rn "waxStorage\.location['\"]?\s*:\s*" src/routes/` as a FILTER (not a write) returns zero matches.
- `grep -rn "storage\.fridgeName['\"]?\s*:\s*" src/routes/` as a FILTER returns zero matches.
- `grep -rn "coolingTrayId['\"]?\s*:\s*" src/routes/` as a FILTER returns zero matches.
- `grep -rn "deckId['\"]?\s*:\s*" src/routes/` as a FILTER returns zero matches.
- Every equipment delete action calls `hasReferences()` first.
- `computeInUseState()` called from every "is this in use" rendering site.
- `grep -r "/manufacturing/wax-filling" src/routes/` returns only in-tree-internal matches under `src/routes/manufacturing/wax-filling/`.
- No `opentrons_robots` reads outside the deprecated model file + migration script.
- `npm run check` + `npm run lint` + `npm run test:unit` + `npm run test:contracts` green.
- `progress.txt` has one entry per story.

---

## Self-audit (required before handoff)

**Accuracy spot-checks done while drafting:**
- Line numbers in S1a/S2/S7/S9 re-grepped on dev `cb6ff0d`. S7 corrected after the first draft (the three orphan fields are now at 47/88/138, not 35/76/126 as the first draft claimed). S2 schema line corrected to 78.
- Reagent-writer raw-string state verified by grep: `reagent-filling/+page.server.ts:966-967` and `opentron-control/reagent/[runId]/+page.server.ts:351` both write `location` verbatim to both `storage.fridgeName` AND `storage.locationId` — same raw value in both fields, no resolver.
- `resolveFridgeId` at `equipment-resolve.ts:57`, `resolveOvenId` at `:63`. Three call sites verified: `cartridge-admin/storage/+page.server.ts:122`, `opentron-control/wax/[runId]/+page.server.ts:402`, `wax-filling/+page.server.ts:1101`.
- `getCheckedOutCartridgeIds()` filter composition with `locationId` join — both are `$and`-composable in a single `$match` stage.
- S2b note about `'cooling_tray'` vs `'cooling-tray'` — verified against `src/lib/server/db/models/equipment.ts` enum and `src/lib/server/services/equipment-resolve.ts:23`.
- Equipment hard-delete call confirmed at `/equipment/fridges-ovens/+page.server.ts:333`. `decks-trays` and `robots` confirmed to have NO equivalent delete action, narrowing S10's scope.
- S9 line numbers in `opentrons/+page.svelte` verified: 80, 198, 206. Other S9 files carry unchanged v1 line numbers.

**Logic coherence checks:**
- Dependency graph has no cycles. Manually walked S1a → … → S8 longest chain.
- S4 cleanly separates `inUse` (run-lock) from `operationalState` (manual override), removing the v1 ambiguity about offline fridges.
- S8's new `ManualCartridgeRemoval` source depends on `waxStorage.locationId` being populated (S1b) — graph edge exists.
- S10's `hasReferences` depends on all three canonicalizers (S1a, S2b, S2c) so it can join on `_id` first and fall back to name strings only for un-migrated records. Graph edges exist.

**Known remaining risks:**
- **S1b rename safety** is tested manually (rename a fridge, watch occupancy). Consider adding an automated test once the pattern stabilizes.
- **S10 false positives during migration window** — between S1a finish and S1b finish, `hasReferences` has to join both `locationId` and the legacy string fields to catch cartridges in either state. Code must not accidentally drop the legacy branch until S1b has landed and `MIGRATION_UNRESOLVED` count is zero.
- **S3 soak period** — exact duration unspecified. Recommend 2 weeks of production reads before anyone considers dropping `opentrons_robots`.
- **Freezer type** — explicitly out of scope per user; if a future freezer is added, it'll need its own enum entry plus updates to S4's per-type table.

**PRD is ready to hand off.**
