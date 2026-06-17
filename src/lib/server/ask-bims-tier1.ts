/**
 * TIER 1 BIMS DATA REFERENCE — inlined into Ask BIMS' system prompt with its
 * own ephemeral cache breakpoint.
 *
 * Built from docs/DATA-REFERENCE.md + docs/MANUFACTURING-FLOW-AUDIT.md, plus
 * the 11 research-only collections shared with brevitest-research-v2 via the
 * same MongoDB Atlas. Last refresh: 2026-05-07.
 *
 * Cache placement: this constant is the FIRST text block in the system array,
 * before SYSTEM_PROMPT. Prefix-cache theory — more stable content cached first
 * survives volatility in less stable content (we tune system prompt rules more
 * often than we change Mongoose schemas).
 *
 * Refresh discipline: when DATA-REFERENCE.md or MANUFACTURING-FLOW-AUDIT.md
 * change in git, regenerate this constant. Manual sync until that's automated.
 *
 * Citation discipline (per system prompt rule 7): cite §1 (tier rules), §4
 * (integrity gaps), or non-obvious §2 schema relationships when those ground
 * the answer. Do NOT cite §3 (lifecycle) — phase ordering is general
 * operational knowledge.
 */

export const TIER_1_REFERENCE = `=== BIMS DATA REFERENCE — inlined 2026-05-07 ===

The BIMS Mongoose schema. Quote when grounding a policy claim, schema join, or
known integrity gap. 53 BIMS collections + 11 research-only (shared via same
Atlas with brevitest-research-v2). Tier marks indicate mutability rules.

§ 1. TIER RULES (mutability + middleware)

🟡 Sacred — finalizedAt blocks updates+deletes; corrections[] append-only:
  assay_definitions (strict — no postFinalizeWritable allowlist)
  cartridge_records (postFinalizeWritable: ['analysis','corrections'])
  reagent_batch_records, spus, users (delete blocked even when not finalized)

🔴 Immutable — never updated/deleted (append-only):
  audit_log, electronic_signatures, inventory_transactions, device_events,
  manufacturing_material_transactions, ask_bims_cost_logs

🟢 Operational — normal CRUD: everything else.

Sacred caveat: research can delete a non-finalized cartridge (gating on
finalizedAt, not unconditional). FREEZE-02 is pending: Lambda doesn't yet
stamp finalizedAt on completed transition, so the freeze isn't enforced live.

§ 2. COLLECTIONS (one line each)

Manufacturing —
  lot_records 🟢 — batch of carts from one mfg run. status, processConfig→process_configurations, operator, quantityProduced, inputLots(Mixed), stepEntries[], cartridgeIds[]→cartridge_records, cycleTimeSeconds
  process_configurations 🟢 — defines a mfg process. configId (e.g. "WI-01"), processType, inputMaterials/outputMaterial(Mixed), steps[], workInstructionId→work_instructions, downstreamQueue
  manufacturing_materials 🟢 — raw materials. name, unit, currentQuantity, adjustmentHistory[]
  manufacturing_material_transactions 🔴 — every material movement
  manufacturing_settings 🟢 — single doc (_id="default"), global mfg config
  laser_cut_batches 🟢 — laser cut runs. ⚠ ISOLATED (no FK to materials/downstream)
  wax_filling_runs 🟢 — wax fill runs. status, robot, operator, cartridgeIds[], deckId, waxSourceLot(string ⚠), waxTubeId→consumables, runStartTime/runEndTime. On complete writes CartridgeRecord.waxFilling write-once

Cartridge & Reagent —
  cartridge_records 🟡 — sacred mfg+test record. status enum: backing/wax_filled/wax_qc/wax_stored/reagent_filled/inspected/sealed/cured/stored/released/shipped/linked/underway/completed/cancelled/scrapped/voided + legacy(packeted/transferred/refrigerated/received). backing.lotId→lot_records, waxFilling.runId→wax_filling_runs, reagentFilling.runId→reagent_batch_records, qaqcRelease.shippingLotId→shipping_lots, shipping.packageId→shipping_packages, testExecution.spu._id→spus, reagentChain[]→protocol_executions, priorStatus(restore on unlink), corrections[]
  reagent_batch_records 🟡 — sacred reagent fill run. status: setup/running/completed/aborted/voided. assayType→assay_definitions, robot+operator, cartridgesFilled[].cartridgeId→cartridge_records, tubeRecords[].sourceLotId(free string ⚠), inspectionStatus, topSeal{topSealLotId→consumables}, qcRelease, corrections[]
  assay_definitions 🟡 — sacred assay/test types. _id is 8-char A+hex (firmware constraint). name, skuCode(unique sparse), versions[], BCODE(Mixed JS object — Lambda compiles), bcode(Buffer — V2 binary), reagents[].subComponents[], lockedAt, isActive, schema uses minimize:false ✓
  cartridge_groups 🟢 — logical groupings of cartridges
  lab_cartridges 🟢 — R&D cartridges (separate from cartridge_records). cartridgeType: measurement/calibration/reference/test. status: available/in_use/depleted/expired/quarantine/disposed
  consumables 🟢 — type: incubator_tube/top_seal_roll/deck/cooling_tray. currentCartridges[], usageHistory[]
  receiving_lots 🟢 — purchased material lots. lotId(UUID), bagBarcode, lotNumber, quantity, consumedUl, status: accepted/in_progress/.., part(snapshot of PartDefinition). Source of truth for inventory; PartDefinition.inventoryCount may drift
  wax_batches 🟢 — LEGACY in-house wax production records. Use only when user explicitly asks "in-house production"

Device & Firmware —
  spus 🟡 — sacred Sample Processing Unit (reader device). udi(required), parts[].partDefinitionId→part_definitions, validationResults[], particleLink, corrections[]
  particle_devices 🟢 — Particle.io IoT device records. needsAttention, attentionReason
  firmware_devices 🟢 — device firmware tracking
  firmware_cartridges 🟢 — cart firmware data
  device_events 🔴 — every device action: validate/load_assay/upload/reset/error
  test_results 🟢 — raw spectral data. status: uploaded/processing/completed/failed. readings[].channel/value/timestampMs

Assembly & Production —
  assembly_sessions 🟢 — SPU build session. status: in_progress/paused/completed. stepRecords[]
  production_runs 🟢 — N-unit production. status: planning/in_progress/paused/completed. units[].status: pending/in_progress/completed
  work_instructions 🟢 — SOPs. status: draft/active/retired. versions[].steps[].partRequirements/toolRequirements/fieldDefinitions(barcode_scan/manual_entry/date_picker/dropdown)
  part_definitions 🟢 — master part catalog. partNumber, minimumOrderQty, sampleSize/percentAccepted, isActive, inventoryCount(⚠ may drift from receiving_lots)
  validation_sessions 🟢 — QC sessions. type: thermocouple/magnetometer/spectrophotometer. status: pending/in_progress/completed/failed. results[]

Inventory & BOM —
  bom_items 🟢 — Bill of Materials. bomType: spu/cartridge. inventoryCount, minimumStockLevel, isActive, versionHistory[]
  bom_column_mapping 🟢 — Excel→BOM field map
  inventory_transactions 🔴 — every movement. transactionType: deduction/retraction/adjustment/receipt. partDefinitionId→part_definitions

Document Control —
  documents 🟢 — controlled docs. status: draft/in_review/approved/retired. revisions[].trainingRecords[]
  document_repository 🟢 — file storage metadata (Box.com or local)

Shipping & Customers —
  customers 🟢 — customer records. status: active/inactive. notes[]
  shipping_lots 🟢 — shipment groups. status: open/testing/released/shipped/cancelled. testResults[].pass/fail/pending
  shipping_packages 🟢 — individual packages. status: created/packing/packed/shipped/delivered

Users & Auth —
  users 🟡 — user accounts. NEVER deleted (deactivatedAt instead). roles[].permissions(denormalized at assignment), roleHistory[].revokedAt, trainingRecords[], corrections[]
  roles 🟢 — permission groups. permissions[] — flat resource:action strings
  sessions 🟢 — login sessions. _id is SHA-256 hash of cookie token. 30-day expiry, auto-renew within 15 days. TTL index auto-deletes expired
  invite_tokens 🟢 — one-time invitation tokens. status: pending/accepted/expired

Kanban & Project Management —
  kanban_projects 🟢 — project containers
  kanban_tasks 🟢 — board items. status: backlog/ready/wip/waiting/done. priority: high/medium/low. comments[], actionLog[], proposals[](agent-suggested changes: pending/approved/edited/vetoed)

Agent & Integration —
  agent_messages 🟢 — system→user. messageType: info/alert/request/approval/status_update/meeting_summary. status: pending/sent/delivered/read/actioned/failed
  agent_queries 🟢 — predefined DB queries the agent can execute
  approval_requests 🟢 — change approval workflow. status: pending/in_review/approved/rejected/cancelled/expired
  integrations 🟢 — external service connections (Box.com, Particle.io)
  opentrons_robots 🟢 — OT-2 robots. ip/port/robotSide, firmwareVersion, embedded protocols[].parametersSchema, recent health snapshots
  ask_bims_cost_logs 🔴 — Ask BIMS per-question telemetry (NO question/answer text — PII deferred). Indexed: userId+timestamp, model+timestamp
  bims_anomalies 🟢 — daily integrity scan findings. kind: null_wax_source_lot/over_consumed_receiving_lot/stale_temperature_read/stuck_cartridge/orphan_lot_reference/denormalized_counter_drift/other. Unique compound index (kind, targetType, targetId)

Audit & Compliance —
  audit_log 🔴 — every data change. action: INSERT/UPDATE/DELETE/PHASE_ADVANCE. oldData/newData snapshots
  electronic_signatures 🔴 — 21 CFR Part 11 e-signatures, password-verified, SHA-256 hashed
  generated_barcodes 🟢 — barcode sequence counter. prefix: PART/CART. atomic counter

Equipment & Sensors —
  equipment 🟢 — fridges/ovens/decks/robots. equipmentType, currentTemperatureC, lastTemperatureReadAt, temperatureMinC/MaxC, status. Synced from Mocreo
  equipment_locations 🟢 — physical locations with barcodes
  temperature_readings 🟢 — time-series sensor data. equipmentId/sensorId, temperature, humidity, timestamp
  temperature_alerts 🟢 — alertType: high_temp/low_temp/lost_connection. acknowledged
  calibration_records 🟢 — calibration history. nextCalibrationDue, equipmentType, status
  service_tickets 🟢 — equipment service tickets

Other utility —
  routing_patterns 🟢 — AI message routing rules
  system_dependencies 🟢 — inter-system tracking
  schema_metadata 🟢 — table descriptions for agent queries
  files 🟢 — file metadata for uploads/attachments
  batches 🟢 — SPU manufacturing batches

Research-only collections (shared Mongo with brevitest-research-v2 — readable by Ask BIMS, NOT yet exposed by tools as of Phase A):
  experiments 🟢 — research experiment defs. status: draft/underway/completed. program(required), folderId(unique sparse, Box.com link), arms[].cartridges[].barcode→cartridge_records, selected[](export columns), checkpoints
  samples 🟢 — experiment samples. experimentId→experiments, analyteId→analytes, concentration(required), diluent, matrix
  analytes 🟢 — measurement targets. units, dynamicRange{low,high}, lod, loq, referenceRange{low,high}
  analysis_profiles 🟢 — raw-data processing config. scanGroupDetection: bcode/manual. sumColumns(default f1..f8+clear+nir), denominatorColumn(f3), ratioNumerators(f5,f7), outputColumns/Channels(default A/B/C)
  calibrated_analyses 🟢 — calibration overlay on AnalysisProfile. cartridgeIds[], excludedChannels[]{cartridgeId,channel}, beadBarcode, tracerBarcode, baseProfileId→analysis_profiles, correctionExponent, results(Mixed)
  templates 🟢 — export column templates. selected[] (attribute paths)
  reagent_catalog 🟢 — reagent type registry. parentId(self-ref variant tree), type: stock/prepared. variants[].{key,label,parameterValues IMMUTABLE after create}, protocolDefinitionId→protocol_definitions
  reagent_inventory 🟢 — physical reagent items. _id is UUID barcode. catalogId→reagent_catalog, variantKey, status: active/depleted/expired/discarded. preparedFromExecutionId→protocol_executions (recursion anchor for trace_reagent_chain), inspections[]
  protocol_definitions 🟢 — versioned recipes. status: draft/active/archived. parameters[].{key,cellRef,isInput}, materials[].catalogId→reagent_catalog, steps[].reagents[].{materialKey,amountFormula}, cellMap(Mixed Excel formula graph — ⚠ EMPTY on live protocols pending re-extraction), versionHistory[].previousDefinition snapshot
  protocol_executions 🟢 — lab notebook records. definitionId→protocol_definitions, variantKey, status: in_progress/completed/aborted. parameterValues, materialsUsed[].inventoryId→reagent_inventory, stepRecords[], outputs[].{barcode,volume,createdAt} multi-aliquot, experimentId→experiments. Legacy outputInventoryId/outputBarcode/outputVolume mirror outputs[0]
  spus 🟡 — sacred SPU device. shared with BIMS (listed above under Device & Firmware). Research-side schema declares strict:false + opticalCalibration{channels:{A,B,C}.{rawF3,factor}}; rest is dynamic

§ 3. CARTRIDGE LIFECYCLE (the golden thread)

Mfg path (operations app + Lambda):
  raw materials → [WI-02 thermoseal cut] → [WI-01 backing → LotRecord+CartridgeRecord.backing]
  → [Wax Filling → WaxFillingRun + cart.waxFilling]
  → [Wax QC] → [Wax Storage] → [Reagent Filling → ReagentBatchRecord + cart.reagentFilling]
  → [Reagent Inspection] → [Top Seal] → [Oven Cure] → [Cold Storage]
  → [QA/QC Release] → [Shipping] → [Assay Loaded] → [linked]

Test path (research app + Lambda middleware):
  [linked] → [underway] (Lambda validate-cartridge) → [completed]/[cancelled] (Lambda upload-test) or [scrapped]

At any mfg phase: → [voided] (QC rejection)
Each phase is write-once via recordedAt guard. Sacred middleware blocks
post-finalize edits except analysis + corrections (CartridgeRecord allowlist).
Once the Lambda stamps finalizedAt on completed (FREEZE-02 pending), test
data becomes truly frozen.

§ 4. KNOWN INTEGRITY GAPS (surface as dataIntegrityNotes when relevant)

1. currentPhase → status migration incomplete. 12 BIMS files still write
   currentPhase (per project memory 2026-05-07). Cartridges touched by them
   carry the wrong field name. When querying CartridgeRecord by lifecycle
   stage, defensive query: $or:[{status:X},{currentPhase:X}], and if a hit
   comes from currentPhase, emit a warning.

2. cellMap is empty on live protocol_definitions. The parser writes cellMap
   correctly today, but protocols extracted before that shipped have cellMap:{}.
   Result: editing input parameters does NOT cascade through formulas — pages
   fall back to static-extracted amounts. Re-extraction needed per protocol.

3. CartridgeRecord.reagentChain[] schema field exists but no write path yet.
   Per Jacob: deferred until variant + execution flow is exercised end-to-end.
   No backfill of existing cartridges. trace_reagent_chain tool will return
   empty chains for now on most carts.

4. FREEZE-02 pending: Lambda upload-test handler does NOT yet stamp
   finalizedAt = new Date() on the completed transition. Sacred middleware
   on cartridge_records is therefore not actually freezing anything live.
   When asked "is this cart frozen?", check finalizedAt explicitly — most
   completed carts won't have it yet.

5. PartDefinition.inventoryCount may drift from sum of accepted ReceivingLot
   quantities. inventoryCount is a denormalized counter; the operational
   truth is the receiving_lots aggregate. Tools that report stock should
   cross-check. runway tool already surfaces this drift.

§ 5. PERMISSIONS (resource:action strings)

admin: full | users
user, role: read | write
kanban: read | write | admin
spu, manufacturing: read | write | admin
document: read | write | approve | train
inventory, cartridge, cartridgeAdmin: read | write
assay, device, testResult: read | write
waxFilling, reagentFilling, productionRun, shipping, customer, equipment: read | write
workInstruction: read | write | approve
documentRepo: read | write

Research-v2 adds: experiment: read | write | delete-all. user:manage. (Same auth
infrastructure — shared users/sessions/roles collections — but research permission
strings are scoped to the research app's resource groups.)

requirePermission(locals.user, "resource:action") throws error(403).
hasPermission returns boolean. isAdmin checks admin:full or admin:users.
admin:full bypasses every gate.
=== END BIMS DATA REFERENCE ===`;
