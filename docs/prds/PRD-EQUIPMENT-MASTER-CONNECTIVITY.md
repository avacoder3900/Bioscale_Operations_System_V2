# PRD — Equipment Master-Controller Connectivity + Legacy Nav Cleanup

> **Reconciliation status (end of day 2026-04-23):** Dev moved while this PRD was being drafted. Stories were re-verified against current `dev` HEAD. Net:
> - **S1a, S1b, S3, S4, S6, S8** — unchanged, still needed as written.
> - **S2** — narrowed. Schema fields already present; one writer (`opentron-control/wax/[runId]`) already writes both `locationId` + `locationName`. Only the resolver helper + migration + remaining-writer grep remain.
> - **S5** — narrowed. `load()` is already DB-only (no Mocreo API calls); existing actions are `mapSensor` / `pingSensor` / `acknowledgeAlert` / `setThresholds`. Only the batch-refresh `?/refresh` action + UI button remain.
> - **S7** — confirmed. All 3 orphan fields still present and still marked `ORPHANED` in `src/lib/server/db/models/cartridge-record.ts`: `waxFilling.transferTimeSeconds` (line 35), `storage.containerBarcode` (line 72), `finalizedAt` (line 122). No scope change.
> - **S9** — line numbers refreshed; **12 call sites** (not 11) across 7 `.svelte` files after recent code drift. Mapping table updated below.
> - **S1a carries an extra data-integrity wrinkle:** `src/routes/cartridge-admin/storage/+page.server.ts:119-120` currently writes `storage.locationId` as a **barcode string, not `Equipment._id`** (the field name lies). S1a's schema repurpose + S1b's migration must normalize or reset these legacy values rather than trusting them.

## Overview
The Equipment page (`/equipment/*`) is intended to be the single source of truth for every piece of equipment — fridges, ovens, decks, trays, robots, temperature probes. The BIMS audit on 2026-04-23 confirmed it is a **metadata master** but NOT a **transaction master**: occupancy, locks, probe data, and history are joined inconsistently across consumer collections. This PRD fixes the connectivity so every consumer (cartridge storage, wax runs, backing lots, Mocreo readings, activity logs) joins the Equipment collection on a single canonical identifier — `Equipment._id` — with denormalized display fields kept in sync. It also retires the legacy `/manufacturing/wax-filling` links that still point operators to the merged-out pages.

## Background

Source: BIMS audit conducted 2026-04-23 (this repo, `dev` branch). Seven connectivity disconnects plus one legacy-nav cleanup:

1. **HIGH** — Fridge storage refs use name/barcode strings, not `Equipment._id` (`CartridgeRecord.waxStorage.location`, `storage.fridgeName`).
2. **HIGH** — `OpentronsRobot` shadow collection dual-written with `equipment` — no transaction, drift risk.
3. **MEDIUM** — In-use lock state scattered across 4 surfaces (`Equipment.status`, `WaxFillingRun` partial unique indexes, `WaxFillingRun.status`, `CartridgeRecord.status`).
4. **MEDIUM** — `CartridgeRecord.ovenCure.locationId` ambiguous (could be `_id`, name, or barcode depending on write path).
5. **MEDIUM** — `/equipment/temperature-probes` dual-renders DB readings + live Mocreo API on every load.
6. **LOW** — `calibration_records` exists but is dead from the UI.
7. **LOW** — Orphan schema fields declared but never written (`storage.containerBarcode`, `waxFilling.transferTimeSeconds`, `finalizedAt`).
8. **LEGACY NAV** — 8 `.svelte` files still route operators to `/manufacturing/wax-filling*` even though the canonical entry point is now `/manufacturing/opentron-control`. Listed in S9.

## Goals
- Every consumer joins `equipment` by `Equipment._id`.
- Display names/barcodes remain on consumer docs for fast rendering (denormalized snapshot) but are never the join key.
- One canonical "is this equipment in use right now?" answer, computed identically everywhere it's shown.
- Retire the `opentrons_robots` shadow collection (leave the collection in place during a soak period).
- Every legacy link to `/manufacturing/wax-filling*` redirected or rewritten to `/manufacturing/opentron-control`.
- Existing production data migrated in place, sacred-document finalization preserved, audit log populated for every back-fill.

## Non-goals
- UI redesign of the Equipment section — we fix data shape and connectivity; visual layout stays.
- Replacing the Mocreo cron pipeline (stays `*/5 * * * *` via Vercel Cron — see memory).
- Changing the root-level `+layout.svelte` (app shell nav).
- Fixing the SPU sidebar dead links — that is a separate PRD (pending).

## Constraints — read before writing code
- **CLAUDE.md:** `.svelte` files are frozen by default. This PRD explicitly authorizes `.svelte` edits **only** for the files named inside each story's Acceptance Criteria. If a story can be completed server-only, prefer server-only.
- **Sacred docs:** `CartridgeRecord` mutations after `finalizedAt` must use the corrections array (CLAUDE.md §"Sacred Document Mutations"). For bulk back-fills, use the **raw MongoDB driver** via `mongoose.connection.db.collection('cartridge_records').updateMany(...)` so Mongoose sacred middleware doesn't reject the batch. Log one aggregate `AuditLog` per batch. Scrubbing docs with `finalizedAt` set is disallowed — skip and log to `audit_logs` as `MIGRATION_SKIPPED_FINALIZED`.
- **Audit trail:** every mutation writes an `AuditLog` entry. Bulk migrations write one aggregate per batch with counts.
- **Mongoose, not Drizzle:** v2 has no `schema.ts` and no `npm run db:push`. Schema changes are runtime; data shape is adjusted by migration scripts.
- **nanoid IDs:** no ObjectIds anywhere.
- **Validation gate per story (standing):** `npm run check` + `npm run lint` + `npm run test:unit` must pass before commit. If schema touched, also run `npx tsx scripts/seed.ts` then `npm run test:contracts`.
- **Branching (hard rules):**
  - Branch naming: `ralph/ecc-<NN>-<slug>` off `dev`.
  - **NEVER push/merge to `main`.** Stop at `master`; hand off to a human for the `main` promotion. (Memory: `feedback_no_master_merge.md`.)
  - Feature branch → PR into `dev` → human reviewer merges.
- **Failure handling:** if any migration script discovers unresolved data (e.g., cartridge `waxStorage.location` that doesn't map to any fridge), skip the record, log to `audit_logs` as `MIGRATION_UNRESOLVED`, and emit a summary at the end of the run. Do not guess.

## Stories

### S1a — Canonicalize fridge storage references on `Equipment._id` (schema + writers)
**As a** BIMS developer **I want** every cartridge-in-fridge reference to join by `Equipment._id` **so that** renaming or re-barcoding a fridge never orphans its inventory.

**Scope:** `CartridgeRecord.waxStorage` and `CartridgeRecord.storage` subdocs. Schema and **writer** sites only. Reader sites + migration in **S1b**.

**Schema changes** (`src/lib/server/db/models/cartridge-record.ts`):
- `waxStorage.locationId: String` — NEW, holds `Equipment._id` of the fridge. Authoritative.
- `waxStorage.location: String` — KEEP, re-document as "denormalized fridge name/barcode for display". Written alongside `locationId`.
- `storage.fridgeId: String` — REPURPOSE (currently orphan). Holds `Equipment._id`. Authoritative.
- `storage.fridgeName: String` — KEEP, denormalized display only.
- `storage.locationId: String` — KEEP, holds `Equipment._id` (already present, now actually written).

**Writer changes** — every server action that writes to these subdocs must resolve the scanned barcode/name to an `Equipment._id` first and set both fields. Writers to update (the sub-agent MUST grep `waxStorage\.` and `storage\.fridgeName` under `src/routes/` to confirm, but seed list is):
- `/manufacturing/wax-filling/+page.server.ts` (store action)
- `/manufacturing/opentron-control/wax/[runId]/+page.server.ts`
- `/manufacturing/opentron-control/+page.server.ts` (if it writes storage)
- `/cartridge-admin/storage/+page.server.ts`
- Any script under `scripts/` that seeds or back-fills storage.

**Helper** — add `src/lib/server/services/equipment-resolve.ts` exporting `resolveFridgeId(barcodeOrName: string): Promise<string | null>` with an in-process LRU cache keyed by input. Writers use this helper; never query Equipment inline.

**Acceptance criteria**
- [ ] Schema updated, `waxStorage.locationId` and `storage.fridgeId` typed as `String`.
- [ ] Every writer of `waxStorage` or `storage.fridgeName` resolves to Equipment._id via the new helper and writes both fields in the same `$set`.
- [ ] Unit test for `resolveFridgeId`: hits by name, by barcode, returns `null` on unknown.
- [ ] `npm run check` + `npm run lint` + `npm run test:unit` pass.
- [ ] `.svelte` files NOT touched in this story.

**Estimated effort:** large (1 full context window).

---

### S1b — Fridge storage migration + reader switchover
**As a** BIMS developer **I want** existing cartridge records back-filled with `Equipment._id` and every reader switched to the canonical field **so that** occupancy queries are consistent.

**Scope:** migration script + reader sites.

**Migration script** — `scripts/migrate-fridge-refs-to-equipment-id.ts`:
1. Build `barcodeOrName → Equipment._id` map from `equipment` collection where `equipmentType: 'fridge'`.
2. Query `cartridge_records` where `waxStorage.location` is set and `waxStorage.locationId` is empty; for each, resolve and `$set` both `locationId` and normalized `location`. Use raw driver (bypass sacred middleware); skip docs with `finalizedAt` set.
3. Same for `storage.fridgeName` → `storage.fridgeId` + `storage.locationId`.
4. Records whose reference can't be resolved: leave untouched; log each unresolved doc's `_id` + unresolvable value to the aggregate `AuditLog.newData.unresolved` array.
5. Idempotent: re-running on an already-migrated collection is a no-op (filter on "locationId empty").
6. Write one aggregate `AuditLog` with `action: 'MIGRATION_EQUIPMENT_ID_BACKFILL'`, `tableName: 'cartridge_records'`, `newData: { waxStorageMigrated, storageMigrated, skippedFinalized, unresolved }`.
7. Default flag `--plan` runs in read-only mode and prints what would change; `--apply` commits.

**Reader changes** — filter occupancy by `locationId` first, fall back to legacy string only when `locationId` is missing (log the fallback as a console warning so back-fill holes are visible):
- `/equipment/fridges-ovens/+page.server.ts`
- `/equipment/location/[locationId]/+page.server.ts`
- `/equipment/activity/+page.server.ts`
- `/cartridge-admin/storage/+page.server.ts`
- `/manufacturing/opentron-control/wax/[runId]/+page.server.ts` (audit flagged it joins by `waxFilling.runId → storage.fridgeName` string match — include in this pass)

**Acceptance criteria**
- [ ] Migration script runs idempotently (`--plan` first, then `--apply`).
- [ ] `AuditLog` entry written with counts and unresolved list.
- [ ] `/equipment/fridges-ovens` occupancy counts match pre-migration counts (verify by capturing counts before and diffing after).
- [ ] Every listed reader prefers `locationId`; legacy fallback logged.
- [ ] `npm run check` + `npm run lint` + `npm run test:unit` pass.

**Estimated effort:** medium (½ to 1 context window). **Depends on:** S1a.

---

### S2 — Canonicalize oven references (`ovenCure.locationId`) — NARROWED
**As a** BIMS developer **I want** every `ovenCure.locationId` write to go through a single resolver so the field unambiguously holds `Equipment._id` **so that** oven-cure history joins cleanly to Equipment.

**What's already done on `dev` (do NOT redo):**
- Schema fields `ovenCure.locationId` + `ovenCure.locationName` already exist in `src/lib/server/db/models/cartridge-record.ts` (line 64).
- `src/routes/manufacturing/opentron-control/wax/[runId]/+page.server.ts:158-159` already writes both `ovenCure.locationId` and `ovenCure.locationName`. It takes an `ovenLocationId` parameter but does NOT normalize it through a resolver — so the written value may be a barcode, a name, or an `Equipment._id` depending on who called the action.

**Remaining scope:**
- Add `resolveOvenId(barcodeOrName: string): Promise<string | null>` to the same helper module introduced by S1a (`src/lib/server/services/equipment-resolve.ts`), filtered to `equipmentType: 'oven'`.
- Wrap the `ovenCure` write in `opentron-control/wax/[runId]/+page.server.ts:158-159` so the value passed to `locationId` is always an `Equipment._id`. Set `locationName` from the resolved Equipment record rather than trusting the caller.
- Grep `grep -rn "ovenCure" src/routes/` in case other writers have landed on dev — if so, wrap them too.
- Migration script `scripts/migrate-oven-cure-refs.ts`:
  1. For each `CartridgeRecord` with `ovenCure.locationId` set, attempt to resolve it against the oven-typed Equipment map (by `_id`, `name`, or `barcode` — in that priority order).
  2. If it resolves, rewrite `locationId` + `locationName` authoritatively.
  3. If it doesn't, log to aggregate AuditLog as `MIGRATION_UNRESOLVED` — do not guess.
  4. `--plan` / `--apply`, raw driver (bypass sacred middleware), one aggregate AuditLog per run.

**Schema documentation:** add inline comments at line 64 marking `locationId` as "Equipment._id, authoritative" and `locationName` as "denormalized display only".

**Acceptance criteria**
- [ ] `resolveOvenId` exported from `equipment-resolve.ts`; unit-tested for `_id` / `name` / `barcode` lookups.
- [ ] `opentron-control/wax/[runId]/+page.server.ts` ovenCure write normalized through the helper.
- [ ] Migration script runs idempotently; unresolved docs logged.
- [ ] `npm run check` + `npm run lint` + `npm run test:unit` pass.

**Estimated effort:** small (½ context window). **Depends on:** S1a (shares the `equipment-resolve.ts` module).

---

### S3 — Retire `opentrons_robots` shadow collection
**As a** BIMS developer **I want** `equipment` to be the single source of truth for robots **so that** drift between the two collections cannot happen.

**Scope:** `opentrons_robots` collection, `/equipment/robots/+page.server.ts`, any `/manufacturing/opentron-control/*` readers, any `/api/opentrons-lab/**/*` readers.

**Discovery phase:** grep every `OpentronsRobot` import and `opentrons_robots` string in `src/`. Record every read site in a dedicated note file at `docs/migration/notes/ecc-03-robot-discovery.md` (create if missing). Do NOT pollute `progress.txt` with discovery notes; only the final summary goes there.

**Changes:**
- All reads switch to `equipment` collection with `equipmentType: 'robot'`.
- Remove dual-write from `/equipment/robots` actions.
- Run-once sync script `scripts/backfill-equipment-from-opentrons-robots.ts`:
  - For each `opentrons_robots._id`, find matching `equipment._id`. If missing, abort with a human-readable report.
  - For each matched pair, copy any field present in `opentrons_robots` but missing on the equipment doc.
  - Aggregate AuditLog, `--plan` / `--apply`.
- Mark the `OpentronsRobot` model file with a top-of-file `// DEPRECATED — see PRD Equipment Connectivity S3. Read from equipment collection instead.` comment. Do NOT remove the export yet (keeps the TS build green until all sites switch).
- The `opentrons_robots` collection is **not** dropped in this story — it stays read-only for a soak period.

**Acceptance criteria**
- [ ] `grep -r "opentrons_robots\|OpentronsRobot" src/` returns only: (a) the deprecated model file, (b) migration script, (c) the sole remaining intentional read (if any) with a `// TODO remove post-soak` marker.
- [ ] `/api/opentrons-lab/robots/[id]/*` endpoints read from `equipment`.
- [ ] Validation script `scripts/validate-no-robot-shadow-drift.ts` exits 0 (confirms every `equipment` robot has no conflicting `opentrons_robots` row).
- [ ] `npm run check` + `npm run lint` + `npm run test:unit` pass.

**Estimated effort:** 1 context window. **Depends on:** none.

---

### S4 — Single canonical `computeInUseState()`
**As a** BIMS developer **I want** one server-side function that answers "is equipment X in use right now?" **so that** every page shows the same answer.

**Scope:** new module `src/lib/server/services/equipment-status.ts` exporting `computeInUseState(equipmentId: string, equipmentType: string): Promise<{ inUse: boolean; reason: string | null; lockedByRunId: string | null; lockedUntil: Date | null }>`.

`inUse` here means **actively locked by a run** (not "has inventory"). Docstring must clarify this.

**Composition rule per equipment type:**
- **Robot:** `inUse` iff any `WaxFillingRun` with `robot._id === equipmentId` has `status` ∈ `WAX_PAGE_OWNED`, OR any `ReagentBatchRecord` equivalent.
- **Deck:** same, filter on `deckId`.
- **Cooling tray:** same, filter on `coolingTrayId`, status ∈ `WAX_NON_TERMINAL`.
- **Fridge:** never "in use" — always `{ inUse: false, reason: null, ... }`. (Capacity check is a separate concern.)
- **Oven:** `inUse` iff any `BackingLot` with `ovenLocationId === equipmentId` and `status` ∈ `['in_oven', 'ready']`.

**Reader changes:** every page that currently reads `Equipment.status` to display "In Use" (Equipment detail, fridges-ovens, decks-trays, activity, any wax-filling page still live) switches to `computeInUseState()`. `Equipment.status` remains the source of truth for manual-override states (`offline`, `maintenance`, etc.) only.

**Acceptance criteria**
- [ ] New service module has unit tests covering all 5 equipment types.
- [ ] Every consumer page imports and uses the service.
- [ ] Inline `Equipment.status === 'in_use'` checks removed from page loaders (except where status means "offline/maintenance").
- [ ] `npm run check` + `npm run lint` + `npm run test:unit` pass.

**Estimated effort:** 1 context window. **Depends on:** S3 (so we're only querying `equipment`, not the shadow).

---

### S5 — Temperature-probes page: DB-only reads + on-demand refresh
**As an** operator **I want** the temperature-probes page to render instantly from the DB **so that** it doesn't hammer the Mocreo API on every page load.

**Scope:** `/equipment/temperature-probes/+page.server.ts` + `/+page.svelte` (single button addition).

**Changes:**
- Remove the live Mocreo API fetch from `load()`. Read only from `temperature_readings`, `temperature_alerts`, and `Equipment.currentTemperatureC` / `lastTemperatureReadAt` (kept fresh by the `*/5 * * * *` cron).
- Add a form action `?/refresh` that invokes `runMocreoSync()` on demand, then redirects back.
- `.svelte` edit (authorized by this story): one "Refresh now" button bound to that action, ≥44px touch target, with loading state.

**Acceptance criteria**
- [ ] Load-time HTTP calls to Mocreo: 0 (verified by grepping the file for `fetch('https://` or Mocreo SDK invocations in `load()`).
- [ ] Manual refresh works and updates timestamps on the next render.
- [ ] Cron sync continues to run `*/5 * * * *`.
- [ ] `npm run check` + `npm run lint` + `npm run test:unit` pass.

**Estimated effort:** small (½ context window). **Depends on:** none.

---

### S6 — Calibration records on Equipment detail
**As an** operator **I want** to see and add calibration history on the Equipment detail page **so that** `calibration_records` isn't dead data.

**Scope:** `/equipment/detail/+page.server.ts` + `/+page.svelte` (table + form), plus permission seeding.

**Permission seeding (prerequisite):**
- Add `calibration:read` and `calibration:write` to the permission list wherever `src/lib/server/permissions.ts` and the role seed file declare permissions. Assign `read` to all roles, `write` to admin + manufacturing-operator (whatever matches existing conventions — grep for similar permissions and mirror).

**Server changes:**
- Load: `CalibrationRecord.find({ equipmentId }).sort({ calibrationDate: -1 }).limit(50).lean()`. (Field is `calibrationDate`, NOT `performedAt` — verified against `src/lib/server/db/models/calibration-record.ts`.)
- New form action `?/logCalibration` that creates a `CalibrationRecord` with `{ calibrationDate, nextCalibrationDue, performedBy, results, status, notes, certificateUrl? }` and writes an `AuditLog` entry.
- Compute "last calibrated at" for display by taking `MAX(calibrationDate)` from the loaded list — do NOT add a denormalized field to `Equipment`.

**`.svelte` changes (authorized by this story):** a calibration section on the detail page rendering the table + add-calibration form.

**Acceptance criteria**
- [ ] Permissions `calibration:read` + `calibration:write` exist and are seeded.
- [ ] Detail page shows last 50 calibrations sorted by `calibrationDate` desc.
- [ ] Adding a calibration persists, writes an AuditLog, and appears in the list on reload.
- [ ] `calibration:write` required for the form action.
- [ ] `npm run check` + `npm run lint` + `npm run test:unit` pass.

**Estimated effort:** 1 context window. **Depends on:** none.

---

### S7 — Remove orphan schema fields
**As a** BIMS developer **I want** fields that have never been written by any action removed from the schema **so that** the model doesn't lie about the data shape.

**Scope:** `CartridgeRecord.waxFilling.transferTimeSeconds`, `CartridgeRecord.finalizedAt` (marked `ORPHANED: never written by any action` in the schema comments), `CartridgeRecord.storage.containerBarcode`.

**Note:** `storage.fridgeId` is NOT in this list — S1a repurposes it.

**Changes:**
- Remove the three fields from `cartridge-record.ts`.
- Migration script `scripts/scrub-orphan-cartridge-fields.ts`: `$unset` the three fields from every `cartridge_records` document. Raw driver (bypass sacred middleware), skip `finalizedAt`-gated docs since the field itself is what we're removing — scrub the field from non-finalized docs, log finalized docs as `MIGRATION_SKIPPED_FINALIZED`.
- Aggregate `AuditLog` with counts.

**Acceptance criteria**
- [ ] Three fields gone from `cartridge-record.ts`.
- [ ] Migration script runs idempotently.
- [ ] `npm run check` + `npm run lint` + `npm run test:unit` pass.

**Estimated effort:** small (½ context window). **Depends on:** S1a (so `storage.fridgeId` has been repurposed first and we don't accidentally scrub the newly-useful field).

---

### S8 — Unified equipment activity feed
**As an** operator **I want** one chronological activity feed on Equipment detail **so that** I don't have to correlate across `device_events`, cartridge storage changes, wax runs, and alerts.

**Scope:** `/equipment/detail/+page.server.ts` + `/+page.svelte`.

**Server changes:** new helper `loadUnifiedActivity(equipmentId, { since, limit })` that merges into one sorted list:
- `DeviceEvent.find({ deviceId: equipmentId })` (field confirmed as `deviceId` in model)
- `CartridgeRecord.find({ 'waxStorage.locationId': equipmentId, 'waxStorage.recordedAt': { $gte: since } })` → "Cartridge {id} stored"
- `WaxFillingRun.find({ $or: [{ deckId: equipmentId }, { coolingTrayId: equipmentId }, { 'robot._id': equipmentId }, { ovenLocationId: equipmentId }] })`
- `BackingLot.find({ ovenLocationId: equipmentId })`
- `TemperatureAlert.find({ equipmentId })`

If the equipment has no `mocreoDeviceId` but is a temp-sensitive type (fridge/oven), emit a sentinel `{ kind: 'mocreo_unmapped', summary: 'No Mocreo device mapped — temperature history unavailable' }` so the missing-mapping is visible instead of silent.

Every merged event emits `{ at: Date, kind: string, source: string, summary: string, payload: object }`.

**`.svelte` changes (authorized by this story):** new "Activity" tab rendering the feed with kind-specific icons + client-side `kind` filter.

**Acceptance criteria**
- [ ] Activity tab shows a chronological merged feed from all 5 sources.
- [ ] Feed capped at 200 entries or 30 days, whichever is smaller.
- [ ] `mocreo_unmapped` sentinel shown when applicable.
- [ ] Filter by `kind` works client-side.
- [ ] `npm run check` + `npm run lint` + `npm run test:unit` pass.

**Estimated effort:** 1 context window. **Depends on:** S1a+S1b (`waxStorage.locationId` populated) + S4 (lock-state context referenced in events).

---

### S9 — Legacy `/manufacturing/wax-filling` link cleanup
**As an** operator **I want** every "Go to Wax Filling" link to route me to the current `/manufacturing/opentron-control` hub **so that** I'm never dropped on a dead or soft-orphaned page.

**Scope:** 8 `.svelte` files carrying legacy `/manufacturing/wax-filling*` links. The `opentron-control` hub is the replacement for wax-filling and MUST NOT be touched.

**File-by-file mapping:**

| File | Line(s) | Current link | Replace with |
|---|---|---|---|
| `src/routes/manufacturing/+page.svelte` | 130 | `/manufacturing/wax-filling/settings` | `/manufacturing/opentron-control/settings` (verify this route exists; if not, see note below) |
| `src/routes/manufacturing/+page.svelte` | 236 | `/manufacturing/wax-filling?robot={robot.robotId}` | `/manufacturing/opentron-control?robot={robot.robotId}` |
| `src/routes/manufacturing/+page.svelte` | 248 | `/manufacturing/wax-filling?robot={robot.robotId}` | `/manufacturing/opentron-control?robot={robot.robotId}` |
| `src/routes/manufacturing/opentrons/+page.svelte` | 80 | `/manufacturing/wax-filling/settings` | `/manufacturing/opentron-control/settings` |
| `src/routes/manufacturing/opentrons/+page.svelte` | 198 | ternary into `/manufacturing/wax-filling` or `/manufacturing/reagent-filling` | `/manufacturing/opentron-control?robot={robot.robotId}` (single target — opentron-control handles the process mode internally) |
| `src/routes/manufacturing/opentrons/+page.svelte` | 206 | `/manufacturing/wax-filling?robot=` | `/manufacturing/opentron-control?robot={robot.robotId}` |
| `src/routes/manufacturing/opentron-control/+page.svelte` | 66 | `/manufacturing/wax-filling?robot={robot.robotId}` | `/manufacturing/opentron-control/wax/new?robot={robot.robotId}` if that's the intent, otherwise remove the link (audit finding: this is a redundant self-link from the new hub back to the old page). **Sub-agent must ask reviewer in the PR description which interpretation is correct.** |
| `src/routes/manufacturing/cart-mfg-dev/+page.svelte` | 173, 186 | `/manufacturing/wax-filling?robot=` | `/manufacturing/opentron-control?robot={robot.robotId}` |
| `src/routes/manufacturing/reagent-filling/+layout.svelte` | 202 | `/manufacturing/wax-filling?robot=` | `/manufacturing/opentron-control?robot={robotState.robotId}` |
| `src/routes/manufacturing/reagent-filling/+page.svelte` | 341 | `/manufacturing/wax-filling?robot={data.robotId}` | `/manufacturing/opentron-control?robot={data.robotId}` |
| `src/routes/manufacturing/opentron-control/settings/+page.svelte` | 30 | `/manufacturing/wax-filling/settings` | internal nav back to `/manufacturing/opentron-control/settings` or remove (same ambiguity as opentron-control/+page.svelte:66 — ask in PR) |

**Explicitly out of scope (self-referential links inside the soft-orphaned wax-filling tree):** `src/routes/manufacturing/wax-filling/+layout.svelte`, `src/routes/manufacturing/wax-filling/settings/+page.svelte`, `src/routes/manufacturing/wax-filling/equipment/+page.svelte`. The wax-filling tree stays in place for the soak period; don't modify its internal nav.

**Pre-flight verification by sub-agent:**
1. Grep to confirm the route `/manufacturing/opentron-control/settings` exists — it's listed in `src/routes/manufacturing/opentron-control/settings/`. If absent, fall back to linking to `/manufacturing/opentron-control` and flag in PR.
2. Confirm no other `/manufacturing/wax-filling` links exist beyond the table — grep the whole `src/` tree as a final sanity check.

**Acceptance criteria**
- [ ] `grep -r "/manufacturing/wax-filling" src/routes/` returns only: (a) legacy component imports under `src/lib/components/manufacturing/wax-filling/`, (b) the wax-filling tree's own internal nav (out of scope for this story).
- [ ] All 11 call sites updated per the mapping table.
- [ ] Manual click-test: root nav → manufacturing dashboard → every robot-related link lands on opentron-control.
- [ ] `npm run check` + `npm run lint` + `npm run test:unit` pass.

**Estimated effort:** small-to-medium (½ to 1 context window). **Depends on:** none.

---

## Dependency graph (explicit)
```
S1a → S1b
S1a → S2  (shared resolver pattern)
S1a → S7  (storage.fridgeId repurpose must precede orphan scrub)
S3  → S4  (canonical robot source before in-use computation)
S1b → S8  (locationId populated before activity feed references it)
S4  → S8  (lock-state used in event rows)
S5, S6, S9: independent, no predecessors
```

**Recommended execution order:** S1a → S1b → S2 → S3 → S4 → S7 → S5 → S6 → S9 → S8.

## Ralph execution notes
Each story is one sub-agent session unless marked otherwise. Sub-agent steps:
1. `git checkout dev && git pull origin dev`.
2. `git checkout -b ralph/ecc-<NN>-<slug>`.
3. Read `AGENTS.md`, `CLAUDE.md`, `SECURITY.md`, **this PRD**, `progress.txt` (Codebase Patterns + recent entries).
4. Implement only the named story.
5. For any migration script: run `--plan` first, eyeball counts, then `--apply`.
6. Validate: `npm run check` + `npm run lint` + `npm run test:unit`. If schema touched: `npx tsx scripts/seed.ts` + `npm run test:contracts`.
7. Append one entry to `progress.txt` (story id, files changed, counts migrated).
8. Commit with message `feat(equip-conn): ECC-<NN> - <short title>` (non-standard format for this project's US-XXX convention is fine here — domain-scoped ID for clarity).
9. Push the feature branch.
10. Open a PR against `dev`. **Do not merge.** Reviewer merges after human approval.
11. **NEVER push or merge to `main`.** Stop at `master`; hand off for `main` promotion.

## Rollback strategy
- Every story's migration script keeps legacy fields populated where possible — revert is "re-read from the denormalized name field."
- Each aggregate `AuditLog` entry has enough metadata to reconstruct pre-migration state.
- If S3 causes any `/api/opentrons-lab` regression, revert the commit and restore the dual-write path; `opentrons_robots` stays in the DB for exactly this soak reason.
- S9 is purely link-text — revert is a one-line-per-file `.svelte` revert if any surface is found to depend on the old URL.

## Done definition (all 9 stories merged)
- Every page under `/equipment/*` joins `equipment` by `_id`.
- `grep -r "waxStorage\.location['\"]?\s*:\s*" src/` (used as a query filter, not as a data write) returns zero matches.
- `/equipment/temperature-probes` load-time external HTTP calls = 0.
- `computeInUseState()` called from every "is this in use" rendering site.
- `grep -r "/manufacturing/wax-filling" src/routes/` returns only in-tree-internal matches under `src/routes/manufacturing/wax-filling/`.
- `npm run check` + `npm run lint` + `npm run test:unit` + `npm run test:contracts` green.
- `progress.txt` has one entry per story, chronological.
