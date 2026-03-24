# Bioscale MongoDB Database Audit
**Date:** March 21, 2026  
**Prepared by:** Claude (external audit via MongoDB Atlas Data Explorer + schema export)  
**Handed to:** Claude Code agent for codebase investigation and cleanup  
**Source files analyzed:** MongoDB Atlas schema export (`bioscale_21_03_2026.customization`), `DATA-REFERENCE.md`, `COMPLETE-SCHEMA-SPECIFICATION.md`

---

## Executive Summary

The database contains **164 collections** when the v2 spec calls for approximately **33**. This is the result of a Postgres → MongoDB migration that left behind three categories of noise: (1) duplicate collections caused by Mongoose auto-pluralization, (2) empty ghost collections from eliminated Postgres-era table patterns, and (3) collections added post-migration by multiple developers working independently.

**The most urgent problem:** 12 collection pairs both have active schemas and are likely receiving live writes simultaneously, meaning data is being silently split across two locations for the same entity type.

---

## How to Use This Report

This report was produced without access to the codebase. The primary task for the Claude Code agent is to **verify each finding against the actual Mongoose model definitions** before taking any destructive action. The methodology section below explains exactly what to look for. Do not drop any collection based solely on this report.

---

## Background: The Migration Context

The system was originally built on PostgreSQL with approximately 110 tables. An agentic migration process redesigned and consolidated this into a MongoDB v2 schema targeting ~33 collections. The key architectural changes were:

- Junction tables eliminated — data embedded into parent documents
- Multiple Postgres tables merged into single MongoDB collections (e.g., `WaxCartridgeRecord` + `ReagentCartridgeRecord` + `PackageCartridge` → one `cartridge_records` document)
- Several sub-tables eliminated entirely (e.g., `KanbanComments`, `KanbanTags` → embedded arrays in `kanban_tasks`)
- A 3-tier data architecture introduced: Sacred documents (append-only, legally traceable), Immutable logs (compliance audit trail), and Operational (normal CRUD)

The migration appears to have been partially completed. Multiple developers then continued building features on top of both the old and new patterns simultaneously, creating the current state.

---

## Root Cause: Mongoose Auto-Pluralization

The primary technical cause of most duplicate collections is Mongoose's default behavior: when you define a model without an explicit collection name, Mongoose lowercases and pluralizes the model name automatically.

```javascript
// Developer A writes:
const AssemblySession = mongoose.model('AssemblySession', schema)
// → Mongoose creates: 'assemblysessions'

// Developer B (or migration script) writes:
const AssemblySession = mongoose.model('AssemblySession', schema, 'assembly_sessions')
// → Mongoose uses: 'assembly_sessions'
```

Both collections now exist and are being written to by different parts of the codebase.

**The fix going forward:** Every Mongoose model definition should include an explicit third argument specifying the collection name in snake_case. This is the canonical pattern per the v2 spec.

---

## Investigation Methodology for Claude Code Agent

Before dropping or migrating anything, do the following for each flagged collection pair:

### Step 1 — Find the Mongoose model files
Search for model definitions across the codebase:

```bash
grep -r "mongoose.model(" --include="*.js" --include="*.ts" -l
```

### Step 2 — Check each model's collection name
For each model file, look for the third argument:

```javascript
mongoose.model('ModelName', schema)              // auto-pluralized → risky
mongoose.model('ModelName', schema, 'collection_name')  // explicit → safe
```

If no third argument exists, Mongoose chose the collection name — derive it by lowercasing and pluralizing the model name.

### Step 3 — Check which twin is being imported
For each duplicate pair, search for imports of each collection name:

```bash
grep -r "collection_name\|collectionName" --include="*.js" --include="*.ts" src/
```

### Step 4 — Check for migration scripts
Look for any one-time migration scripts that may have created collections outside of Mongoose:

```bash
find . -name "migrate*" -o -name "seed*" -o -name "*migration*"
```

### Step 5 — For the truly ambiguous pairs, check document counts via Atlas
The schema export shows which collections have real field schemas (indicating actual data). Before dropping anything, confirm document counts in Atlas Data Explorer.

---

## Section 1: Critical — Both Sides Have Live Schema Data (Split Writes)

These 12 pairs are the highest priority. Both versions have actual field schemas, which strongly indicates both are receiving live writes. Data integrity is at risk.

**For each pair:** identify which version the active Mongoose model points to, migrate any orphaned documents from the dead twin into the live one, then drop the dead twin.

| Snake_case version | CamelCase version | Field count difference | Notes |
|---|---|---|---|
| `assay_definitions` (13 fields) | `assaydefinitions` (15 fields) | +2 in camel | Different field sets — models have diverged. Reconcile schemas before migrating. |
| `cartridge_records` (9 fields) | `cartridgerecords` (12 fields) | +3 in camel | **Highest priority.** Most critical document in the system — the terminal sacred record. |
| `lot_records` (14 fields) | `lotrecords` (12 fields) | +2 in snake | Manufacturing production data split across both. |
| `reagent_batch_records` (15 fields) | `reagentbatchrecords` (15 fields) | Same | Sacred document, identical field count — likely exact duplicate writes. |
| `wax_filling_runs` (11 fields) | `waxfillingruns` (14 fields) | +3 in camel | Manufacturing run data split. |
| `kanban_tasks` (8 fields) | `kanbantasks` (11 fields) | +3 in camel | Task data split — check if proposals/comments fields are the difference. |
| `validation_sessions` (8 fields) | `validationsessions` (9 fields) | +1 in camel | SPU validation records split. |
| `part_definitions` (12 fields) | `partdefinitions` (16 fields) | +4 in camel | BOM/parts data split. |
| `kanban_projects` (7 fields) | `kanbanprojects` (6 fields) | +1 in snake | Project containers split. |
| `equipment_locations` (9 fields) | `equipmentlocations` (9 fields) | Same | Identical schemas — pure duplicate. |
| `inventory_transactions` (9 fields) | `inventorytransactions` (9 fields) | Same | Identical schemas — pure duplicate. |
| `generated_barcodes` (5 fields) | `generatedbarcodes` (6 fields) | +1 in camel | **High priority.** This collection guarantees system-wide barcode uniqueness. Split writes here could cause barcode collisions on physical cartridges or SPUs — a traceability and regulatory risk. |

### Special note on `assay_definitions` vs `assaydefinitions`

These two have meaningfully different schemas beyond just field count. `assaydefinitions` (camelCase) has fields `assayId`, `bcodeLength`, `checksum`, `duration`, and `shelfLifeDays` that are absent from `assay_definitions`. `assay_definitions` (snake_case) has `metadata.instructions` and `useSingleCost` that are absent from the camelCase version. These may represent two different generations of the assay model — a firmware-facing model and a manufacturing-facing model — that were intended to be merged per the v2 spec (Open Decision #5 in the schema spec document) but never were. **Do not merge blindly — resolve the schema difference first.**

---

## Section 2: One Side Has Data, Other Is Empty (Safe Cleanup)

These pairs have a clear winner — one side has a real schema, the other is empty. Verify via the Mongoose model, then drop the empty one.

| Empty collection | Live collection | Action |
|---|---|---|
| `agentqueries` | `agent_queries` (11 fields) | Drop `agentqueries` |
| `bom_items` | `bomitems` (16 fields) | Drop `bom_items` |
| `manufacturingsettings` | `manufacturing_settings` (6 fields) | Drop `manufacturingsettings` |
| `opentronsrobots` | `opentrons_robots` (6 fields) | Drop `opentronsrobots` |
| `particledevices` | `particle_devices` (14 fields) | Drop `particledevices` |
| `process_configurations` | `processconfigurations` (7 fields) | Drop `process_configurations` |
| `shipping_lots` | `shippinglots` (6 fields) | Drop `shipping_lots` |
| `shipping_packages` | `shippingpackages` (8 fields) | Drop `shipping_packages` |

**Confidence note:** These are high-confidence based on schema data, but still verify the Mongoose model before dropping. It's possible a model was recently updated to point to the snake_case name and just hasn't received writes yet — in which case the camelCase version should be dropped instead, and any existing documents migrated.

---

## Section 3: Both Sides Empty — Postgres-Era Ghost Collections

These collections are empty and their names map directly to things the v2 spec explicitly eliminated. The emptiness confirms they are not being actively written to. The name mapping to a discontinued pattern is the real signal.

**Before dropping any of these:** run the codebase grep to confirm there is no active Mongoose model pointing to them. An empty collection with an active model means the feature just hasn't had data yet — do not drop it.

### Eliminated junction tables (should be embedded in parent doc)

| Collection | What the v2 spec says |
|---|---|
| `assemblysteprecords` | Embed into `assembly_sessions.stepRecords[]` |
| `approvalhistories` | Embed into `approval_requests.history[]` |
| `lotstepentries` | Embed into `lot_records.stepEntries[]` |
| `processsteps` | Embed into `process_configurations.steps[]` |
| `productionrununits` | Embed into `production_runs.units[]` |
| `validationresults` | Embed into `validation_sessions.results[]` |
| `spectroreadings` | Embed into `test_results.readings[]` |
| `locationplacements` | Embed into `equipment_locations.currentPlacements[]` |
| `packagecartridges` | Embed into `shipping_packages.cartridges[]` |
| `qaqcreleases` | Embed into `shipping_lots.qaqcReleases[]` |

### Eliminated Kanban sub-tables (should be embedded in kanban_tasks)

| Collection | What the v2 spec says |
|---|---|
| `kanbancomments` | Embed into `kanban_tasks.comments[]` |
| `kanbantags` | String array in `kanban_tasks.tags[]` |
| `kanbantasktags` | Same as above |
| `kanbanactionlogs` | Embed into `kanban_tasks.activityLog[]` |
| `kanbantaskproposals` | Embed into `kanban_tasks.proposals[]` |
| `kanbanboardevents` | Drop or use `audit_log` |

### Eliminated reagent/cartridge sub-tables (merged into cartridge_records or assay_definitions)

| Collection | What the v2 spec says |
|---|---|
| `waxcartridgerecords` | Merged into `cartridge_records.waxFilling` phase |
| `reagentcartridgerecords` | Merged into `cartridge_records.reagentFilling` phase |
| `reagentdefinitions` | Embedded into `assay_definitions.reagents[]` |
| `reagentsubcomponents` | Embedded into `assay_definitions.reagents[].subComponents[]` |
| `reagenttuberecords` | Embedded into `reagent_batch_records.tubeRecords[]` |
| `reagentfillingruns` | Superseded by `reagent_batch_records` |
| `reagentfillingsettings` | Merged into `manufacturing_settings` |
| `waxfillingsettings` | Merged into `manufacturing_settings` |
| `topsealbatches` | Embedded into `reagent_batch_records.topSeal` |
| `topsealcutrecords` | Embedded into `consumables.usageLog[]` |
| `topsealrolls` | Superseded by `consumables` (type: top_seal_roll) |

### Eliminated consumables sub-tables (merged into consumables collection)

| Collection | What the v2 spec says |
|---|---|
| `incubatortubes` | Superseded by `consumables` (type: incubator_tube) |
| `incubatortubeusages` | Embedded into `consumables.usageLog[]` |
| `coolingtrayrecords` | Superseded by `consumables` (type: cooling_tray) |
| `deckrecords` | Superseded by `consumables` (type: deck) |

### Old Postgres-style relational table names (superseded entirely)

| Collection | Note |
|---|---|
| `assays` | Old name — data now lives in `assay_definitions` |
| `assaytypes` | Old name — merged into `assay_definitions` |
| `assayversions` | Old name — embedded as `assay_definitions.versionHistory[]` |
| `cartridges` | Old name — now `lab_cartridges` |
| `cartridgeusagelogs` | Embedded into `lab_cartridges.activityLog[]` |
| `cartridgebomitems` | Merged into `bom_items` with `bomType` discriminator |
| `bomitemversions` | Embedded into `bom_items.versionHistory[]` |
| `bompartlinks` | Embedded into `bom_items.partLinks[]` |
| `spuparts` | Merged into `spus.parts[]` |
| `spupartusages` | Merged into `spus.parts[]` |
| `boxintegrations` | Superseded by `integrations` (type: box) |
| `particleintegrations` | Superseded by `integrations` (type: particle) |
| `particlelinks` | Superseded by `particle_devices` |
| `rejectionreasoncodes` | Merged into `manufacturing_settings` |
| `opentronsprotocolrecords` | Embedded into `opentrons_robots.protocols[]` |
| `opentronshealthsnapshots` | Embedded into `opentrons_robots.recentHealthSnapshots[]` |
| `documentrepositories` | Camelcase twin of `document_repository` — both empty |
| `documentrevisions` | Embedded into `documents.revisions[]` |
| `documenttrainings` | Embedded into `documents.revisions[].trainingRecords[]` |
| `customernotes` | Embedded into `customers.notes[]` |
| `communicationpreferences` | Embedded into `users.communicationPreferences[]` |
| `equipmenteventlogs` | Embedded into equipment or `audit_log` |
| `laborentries` | Open decision in spec — confirm if still needed |
| `stepfielddefinitions` | Work instruction sub-table |
| `stepfieldrecords` | Assembly session sub-table |
| `steppartrequirements` | Work instruction sub-table |
| `steptoolrequirements` | Work instruction sub-table |
| `bomcolumnmappings` | Camelcase twin of `bom_column_mapping` — both empty |
| `workinstructionsteps` | Embedded into `work_instructions.steps[]` |
| `workinstructionversions` | Embedded into `work_instructions` |

---

## Section 4: Post-Migration Additions — Review Required

These collections were not in the original v2 spec. They appear to have been added after the migration by one or more developers. They are not necessarily wrong — they may be legitimate new features — but they need a deliberate architectural decision.

### Has real schema data — likely intentional new features

| Collection | Fields | Notes |
|---|---|---|
| `service_tickets` | 17 required fields | Links to `spus` and `users`. Looks like a device service/repair tracking feature. Not in the v2 spec — document the intent. |
| `receiving_lots` | 23 required fields | Links to `part_definitions`. Likely incoming parts/materials receiving workflow. The name `receiving_lots` vs existing `backing_lots` needs clarification — see ambiguous pairs below. |
| `permissions` | 5 required fields | Part of a granular RBAC system — see note below. |
| `rolepermissions` | 6 required fields | Part of a granular RBAC system — see note below. |
| `userroles` | 6 required fields | Part of a granular RBAC system — see note below. |
| `schemametadatas` | 10 required fields | Camelcase twin of `schema_metadata`. Both appear to have data — standard duplicate issue. |

### `permissions` / `rolepermissions` / `userroles` — architectural concern

The v2 spec defines permissions as a flat array embedded directly in the `roles` document (`roles[].permissions[]`), and role assignment embedded in the `users` document (`users[].roles[]`). The three collections above implement a classic relational RBAC pattern using junction tables instead:

- `permissions` — permission registry
- `rolepermissions` — join table: role → permission
- `userroles` — join table: user → role

This is a significant architectural divergence from the v2 spec. Both patterns can work, but running both simultaneously creates confusion about which is authoritative. **Determine which pattern is actually being used by the auth middleware** and document it. If the junction-table pattern won out in practice, the v2 spec's embedded approach should be updated to reflect reality.

### Empty but plausible new features

| Collection | Notes |
|---|---|
| `calibration_records` | Sounds intentional — calibration tracking for equipment or devices. Confirm if in development. |
| `inspection_results` | Could be QC inspection outcomes. Confirm if in development. |
| `workflow_violations` | Agent/automation related — tracks rule violations. Confirm if in development. |
| `tool_confirmations` | Likely agent tool-use confirmation workflow. Confirm if in development. |

---

## Section 5: Ambiguous Pairs — Lower Confidence

These are cases where the audit is less certain. The Claude Code agent should resolve these by examining the codebase directly before taking any action.

### `receiving_lots` vs `backing_lots`

Both have real schemas and real data. These could be:
- **Two different concepts:** `backing_lots` = manufactured cartridge backing lots (upstream of `cartridge_records`), `receiving_lots` = incoming purchased parts/materials. If so, both are legitimate and should coexist.
- **The same concept, named differently by different developers.** If so, one is a duplicate and needs to be consolidated.

The `receiving_lots` collection links to `part_definitions`, while `backing_lots` is referenced in `cartridge_records.backing.lotId`. This suggests they may be different things — but confirm in the codebase.

### `audit_log` vs `auditlogs`

`audit_log` (345 documents, 7 required fields) and `auditlogs` (2 documents, 8 required fields) have slightly different schemas. `audit_log` does not require `newData` as a field while `auditlogs` does. Both appear to have received writes. Determine which one the audit middleware actually imports. The 2-document `auditlogs` may be from an early experimental write during development. **This is an immutable compliance collection — do not drop either until you are certain which is canonical.**

### `assay_definitions` vs `assaydefinitions` (elaborated)

Beyond being a duplicate pair (covered in Section 1), there is a deeper question here per Open Decision #5 in the schema spec: the old system had a separate `Assay` model (firmware-facing) and `AssayType` model (manufacturing-facing). The v2 spec proposed merging them into a single `assay_definitions` collection. The field differences between the two live twins (`bcodeLength`, `checksum`, `duration` in one vs `metadata.instructions`, `useSingleCost` in the other) suggest this merge may never have fully happened. Clarify whether both are needed or if one is truly a firmware model and one is a manufacturing model that should be reconciled.

### `bomitems` vs `bom_items`

`bomitems` has 16 required fields and is the live collection. `bom_items` is empty. This looks like a clear case (drop `bom_items`), but the v2 spec calls the canonical name `bom_items` (snake_case). It's possible the intention was to rename `bomitems` → `bom_items` and the snake_case version was created in anticipation of that migration, which was never completed. Check the Mongoose model — if it now points to `bom_items`, migrate the data over; if it still points to `bomitems`, just drop the empty `bom_items`.

---

## Section 6: The `audit_log` Split Is a Compliance Risk

This deserves its own section because of the regulatory context. The system operates under FDA and ISO standards with 21 CFR Part 11 compliance requirements. The `audit_log` collection is designated as a **Tier 3 Immutable Log** — every data change in the system is supposed to flow here, and these records can never be modified or deleted.

With writes currently split across `audit_log` (345 docs) and `auditlogs` (2 docs), any audit query that only reads one collection is returning an incomplete picture of system activity. If an auditor or inspector queries `audit_log`, they are missing records that exist only in `auditlogs`, and vice versa.

**Recommended action:**
1. Identify which collection the audit middleware imports
2. Migrate the 2 documents from the losing twin into the canonical collection (maintaining all original timestamps and field values — do not re-create them)
3. Add a comment or document explaining the migration for audit trail purposes
4. Drop the empty twin
5. Add a write-protection guard to the model to prevent future accidental collection name drift

---

## Section 7: Recommended Fix for Mongoose Collection Names

Once the canonical name for each collection is confirmed, lock it in with an explicit third argument on every model definition. The v2 spec uses snake_case as the canonical convention.

```javascript
// Before (auto-pluralized, risky):
const AssemblySession = mongoose.model('AssemblySession', assemblySessionSchema)

// After (explicit, locked):
const AssemblySession = mongoose.model('AssemblySession', assemblySessionSchema, 'assembly_sessions')
```

This should be applied to every model in the codebase as part of the cleanup, not just the ones involved in known duplicates. This prevents any future developer from accidentally creating a new split.

---

## Cleanup Priority Order

| Priority | Action | Risk |
|---|---|---|
| 1 | Resolve `audit_log` vs `auditlogs` | Compliance risk |
| 2 | Resolve `generated_barcodes` vs `generatedbarcodes` | Traceability risk |
| 3 | Resolve `cartridge_records` vs `cartridgerecords` | Data integrity on most critical document |
| 4 | Resolve all remaining Section 1 split pairs | Data integrity |
| 5 | Drop Section 2 confirmed empty twins | Low risk, quick wins |
| 6 | Resolve `permissions`/`rolepermissions`/`userroles` architecture | Auth clarity |
| 7 | Confirm and document Section 4 new features | Documentation |
| 8 | Drop confirmed Section 3 ghost collections | Low risk after codebase confirms no active model |
| 9 | Add explicit collection names to all Mongoose models | Prevention |
| 10 | Resolve `assay_definitions` schema divergence | Data integrity |

---

## Open Questions from the Schema Spec (Pre-Existing)

These were flagged as unresolved in the original `COMPLETE-SCHEMA-SPECIFICATION.md` and remain open:

1. **SpectroReading count per test** — if fewer than 500, embed in `test_results`; if more than 1000, keep as separate collection. Determines whether `spectroreadings` is a ghost or a legitimate collection.
2. **Work instruction step image sizes** — determines if `work_instructions` will hit the 16MB document limit.
3. **Equipment event log retention** — full history separate collection vs. recent only embedded.
4. **Labor entries** — confirm if `laborentries` is still needed for costing or can be dropped.
5. **Assay + Firmware Assay merge** — the core question behind the `assay_definitions` vs `assaydefinitions` split.
6. **User deactivation pattern** — `deactivatedAt` vs `finalizedAt`/`voidedAt`.

---

*This report was generated from static analysis of the MongoDB Atlas schema export and migration reference documents. All findings should be verified against live codebase before any destructive database operations are performed.*
