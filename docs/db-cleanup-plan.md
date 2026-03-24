# MongoDB Database Cleanup Plan

**Date:** March 17, 2026
**Prepared by:** Jacob Quick + Claude Code
**Database:** bioscale (MongoDB Atlas)
**Current state:** 164 collections exist, 53 are active. 111 are dead weight.

---

## Context

The v2 migration from Postgres to MongoDB left behind ~111 ghost collections in Atlas. These fall into three categories:

1. **CamelCase twins** — Mongoose auto-pluralized collection names created by `scripts/seed-domain-data.ts` using raw `db.collection()` calls instead of Mongoose models. The models all explicitly target snake_case names, but the seed script bypasses Mongoose and writes directly to camelCase names.
2. **Postgres-era relics** — Empty collections whose names map to old Postgres junction tables, sub-tables, and relational patterns that were eliminated in the v2 schema redesign (data is now embedded in parent documents).
3. **Post-migration experiments** — Collections created by developers working on features independently, some of which diverge from the v2 spec architecture.

### How we verified

Every collection name was searched across **all branches** (master, dev, main, v2-rog-overhaul, ralph/url-restructure, thermocouple-and-spec-validation, ralph/cv-integration, nick-merge-v2, nick-merge-file, NichEditsandTesting, NickManufacturingFixes, NickEditsandTesting, feature/inventory-spu-server, CV-feature-AV) using `git grep`. Only collections with zero code references (or references limited to old Postgres docs) are in the safe-to-drop list.

---

## TIER 1 — Safe to Drop Now (88 collections)

These have **zero code references** on any branch and are confirmed empty or contain only stale seed data. No feature branch depends on them.

### 1a. Empty CamelCase twins (6 collections)

The model on master points to the snake_case name. The camelCase twin was auto-created and is empty.

| Drop this | Active twin (keep) |
|---|---|
| `agentqueries` | `agent_queries` |
| `manufacturingsettings` | `manufacturing_settings` |
| `opentronsrobots` | `opentrons_robots` |
| `particledevices` | `particle_devices` |
| `auditlogs` | `audit_log` |
| `schemametadatas` | `schema_metadata` |

### 1b. Postgres-era ghost collections (61 collections)

All empty. Names map to eliminated junction tables, sub-tables, and old relational patterns. Zero code references on any branch.

**Eliminated junction tables:**
`assemblysteprecords`, `approvalhistories`, `lotstepentries`, `processsteps`, `productionrununits`, `validationresults`, `spectroreadings`, `locationplacements`, `packagecartridges`, `qaqcreleases`

**Eliminated Kanban sub-tables:**
`kanbancomments`, `kanbantags`, `kanbantasktags`, `kanbanactionlogs`, `kanbantaskproposals`, `kanbanboardevents`

**Eliminated reagent/cartridge sub-tables:**
`waxcartridgerecords`, `reagentcartridgerecords`, `reagentdefinitions`, `reagentsubcomponents`, `reagenttuberecords`, `reagentfillingruns`, `reagentfillingsettings`, `waxfillingsettings`, `topsealbatches`, `topsealcutrecords`, `topsealrolls`

**Eliminated consumables sub-tables:**
`incubatortubes`, `incubatortubeusages`, `coolingtrayrecords`, `deckrecords`

**Old Postgres table names (superseded):**
`assays`, `assaytypes`, `assayversions`, `cartridges`, `cartridgeusagelogs`, `cartridgebomitems`, `bomitemversions`, `bompartlinks`, `spuparts`, `spupartusages`, `boxintegrations`, `particleintegrations`, `particlelinks`, `rejectionreasoncodes`, `opentronsprotocolrecords`, `opentronshealthsnapshots`, `documentrepositories`, `documentrevisions`, `documenttrainings`, `customernotes`, `communicationpreferences`, `equipmenteventlogs`, `laborentries`, `stepfielddefinitions`, `stepfieldrecords`, `steppartrequirements`, `steptoolrequirements`, `bomcolumnmappings`, `workinstructionsteps`, `workinstructionversions`

### 1c. Post-migration dead collections (4 collections)

No model targets these on any branch. The `permissions`/`rolepermissions`/`userroles` pattern diverges from the v2 spec's embedded RBAC and has no active code using it.

`approvalrequests`, `permissions`, `rolepermissions`, `userroles`

### 1d. Additional empty CamelCase twins (17 collections)

All confirmed 0 documents. Models point to snake_case equivalents.

`agentmessages`, `assemblysessions`, `cartridgegroups`, `deviceevents`, `electronicsignatures`, `firmwarecartridges`, `firmwaredevices`, `invitetokens`, `lasercutbatches`, `manufacturingmaterials`, `manufacturingmaterialtransactions`, `productionruns`, `routingpatterns`, `systemdependencies`, `testresults`, `workinstructions`, `bom_column_mapping`

---

## TIER 2 — Migrate Data Then Drop (15 collections)

These camelCase collections contain real data that was written by `scripts/seed-domain-data.ts` (which bypasses Mongoose and writes directly via `db.collection('camelCaseName')`). The active Mongoose models point to the snake_case versions.

**Action:** For each pair, migrate documents from camelCase → snake_case (skip duplicates by `_id`), verify counts match, then drop the camelCase twin.

### 2a. Section 1 split-write pairs — both sides may have data

**Before migrating, check document counts in Atlas for both sides of each pair.**

| CamelCase (drop after migration) | Snake_case (keep) | Notes |
|---|---|---|
| `assaydefinitions` | `assay_definitions` | Schema divergence — see Monday discussion |
| `cartridgerecords` | `cartridge_records` | Most critical sacred document |
| `lotrecords` | `lot_records` | Manufacturing data |
| `reagentbatchrecords` | `reagent_batch_records` | Sacred document |
| `waxfillingruns` | `wax_filling_runs` | Manufacturing runs |
| `kanbantasks` | `kanban_tasks` | Task data |
| `validationsessions` | `validation_sessions` | SPU validation |
| `partdefinitions` | `part_definitions` | BOM/parts data |
| `kanbanprojects` | `kanban_projects` | Project containers |
| `equipmentlocations` | `equipment_locations` | Locations |
| `inventorytransactions` | `inventory_transactions` | Immutable ledger |
| `generatedbarcodes` | `generated_barcodes` | Barcode uniqueness — high priority |

### 2b. Section 2 reversed pairs — camelCase has data, snake_case is empty

The audit doc originally said to drop the snake_case versions, but the models NOW point to snake_case. Data needs to be migrated FROM camelCase INTO snake_case.

| CamelCase (has data, drop after migration) | Snake_case (model target, keep) |
|---|---|
| `processconfigurations` | `process_configurations` |
| `shippinglots` | `shipping_lots` |
| `shippingpackages` | `shipping_packages` |

**Note on `bomitems`:** Model now points to `bom_items`. Data in `bomitems` needs migration. But `bom_items` may also have newer data from recent writes. Merge both, dedup by `_id`.

---

## TIER 3 — Monday Team Discussion (5+ items)

These require team input before any action.

### 3a. `assay_definitions` schema divergence
The camelCase `assaydefinitions` has fields (`assayId`, `bcodeLength`, `checksum`, `duration`, `shelfLifeDays`) absent from `assay_definitions`, which has fields (`metadata.instructions`, `useSingleCost`) absent from the camelCase version. This may represent two different models (firmware-facing vs manufacturing-facing) that were supposed to be merged per v2 spec Open Decision #5. **Need team to clarify before merging data.**

### 3b. `receiving_lots` vs `backing_lots`
Both have data. Could be two different concepts (incoming parts vs manufactured backing lots) or duplicates. Need team confirmation.

### 3c. `calibration_records`
Only exists on `origin/ralph/url-restructure` branch. If that branch merges, this becomes active. Don't drop.

### 3d. `service_tickets`
New model on `origin/thermocouple-and-spec-validation` for SPU repair tracking. Legitimate feature — don't drop.

### 3e. Seed script fix
`scripts/seed-domain-data.ts` uses raw `db.collection()` with camelCase names instead of Mongoose models. This is the root cause of most split-write pairs. Needs to be rewritten to use the Mongoose models or at minimum use the correct snake_case collection names.

---

## Execution Plan

### Step 1: Drop Tier 1 (88 dead collections)
Run `scripts/db-cleanup.ts` with `--tier1` flag. No data at risk.

### Step 2: Migrate Tier 2 (15 collections)
1. User provides document counts from Atlas for each pair
2. Run migration script: for each pair, copy camelCase docs → snake_case (skip existing `_id`s)
3. Verify counts
4. Drop camelCase twins

### Step 3: Team discussion (Monday)
Review Tier 3 items. Decide on assay schema merge, receiving_lots, and seed script fix.

---

## Post-Cleanup State

After Tier 1 + Tier 2: **~61 collections** (down from 164).
After Tier 3 resolution: target ~53 collections (matching the 53 Mongoose models).

### Dry Run Results (March 17, 2026)

**Tier 1 — 88 collections to drop:**
- 82 completely empty (0 documents)
- `auditlogs` — 2 docs (stale experimental writes, no code references)
- `schemametadatas` — 44 docs (seed data in wrong collection)
- `permissions` — 1 doc (orphaned RBAC experiment)
- `rolepermissions` — 1 doc (orphaned RBAC experiment)
- `userroles` — 1 doc (orphaned RBAC experiment)

**Tier 2 — 15 camelCase twins to migrate then drop:**
- `cartridgerecords` (20 docs) → `cartridge_records` (466 docs)
- `lotrecords` (5) → `lot_records` (200)
- `reagentbatchrecords` (2) → `reagent_batch_records` (4)
- `waxfillingruns` (3) → `wax_filling_runs` (35)
- `kanbantasks` (4) → `kanban_tasks` (116)
- `validationsessions` (15) → `validation_sessions` (51)
- `partdefinitions` (5) → `part_definitions` (64)
- `kanbanprojects` (4) → `kanban_projects` (7)
- `equipmentlocations` (4) → `equipment_locations` (3)
- `inventorytransactions` (16) → `inventory_transactions` (703)
- `generatedbarcodes` (10) → `generated_barcodes` (7)
- `processconfigurations` (3) → `process_configurations` (0)
- `shippinglots` (1) → `shipping_lots` (0)
- `shippingpackages` (1) → `shipping_packages` (0)
- `bomitems` (5) → `bom_items` (0)

**Left for Monday:** `assaydefinitions` (3 docs, divergent schema from `assay_definitions`)

---

## Rollback

All drops are permanent. However:
- Tier 1 collections are empty or contain only stale seed data — no production value
- Tier 2 data is migrated before dropping — if migration fails, the camelCase twin is untouched
- Atlas supports point-in-time restore if needed (check your backup policy window)

**Recommendation:** Take an Atlas backup snapshot before running the cleanup script.
