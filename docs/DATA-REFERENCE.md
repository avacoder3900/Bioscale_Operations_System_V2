# Bioscale Operations System V2 — Data Reference

> MongoDB document-model architecture for manufacturing, quality, and device tracking.
> **53 collections** organized into 3 tiers based on mutability rules.

---

## How to Read This Guide

Each collection shows:
- 📦 **What it stores** — plain English
- 🔑 **Key fields** — the important ones
- 🔗 **Connects to** — what other collections it references
- 📋 **Status values** — if it has a state machine

---

## Architecture: The 3-Tier System

| Tier | Rule | Why | Collections |
|------|------|-----|-------------|
| 🟡 **Sacred** | Can't edit after finalized | These are legal records (FDA, ISO) | Cartridge Records, SPUs, Assay Definitions, Reagent Batches, Users |
| 🔴 **Immutable** | Can't edit or delete. Ever. | Audit trail integrity | Audit Log, E-Signatures, Inventory Transactions, Device Events, Material Transactions |
| 🟢 **Operational** | Normal CRUD | Day-to-day working data | Everything else |

**Sacred documents** support a `corrections[]` array — you can't edit the field directly, but you can append a correction with who/why/when. This preserves the audit trail while allowing legitimate fixes.

---

## 🏭 Manufacturing Domain

### Lot Records (`lot_records`)
📦 A batch of cartridges produced in one manufacturing run.

| Field | What it is |
|-------|------------|
| `qrCodeRef` | Unique QR code for this lot (scannable) |
| `processConfig` | Which process made this (WI-01, WI-02, etc.) |
| `operator` | Who ran it (embedded `{_id, username}`) |
| `quantityProduced` | How many cartridges came out |
| `status` | Current state |
| `inputLots` | What raw materials went in |
| `stepEntries[]` | Each manufacturing step completed |
| `cycleTimeSeconds` | How long the whole run took |

🔗 Connects to: Process Configurations, Users

---

### Process Configurations (`process_configurations`)
📦 Defines a manufacturing process — its steps, inputs, and outputs.

| Field | What it is |
|-------|------------|
| `configId` | Human-readable ID (e.g., "WI-01") |
| `processName` | Friendly name |
| `processType` | Category of process |
| `inputMaterials` | What goes in |
| `outputMaterial` | What comes out |
| `steps[]` | Ordered list of process steps |

🔗 Connects to: Lot Records (used by), Manufacturing Materials

---

### Manufacturing Materials (`manufacturing_materials`)
📦 Raw materials used in manufacturing (wax, reagents, seals, etc.)

| Field | What it is |
|-------|------------|
| `name` | Material name |
| `unit` | Unit of measure |
| `currentQuantity` | How much is on hand |
| `adjustmentHistory[]` | Log of quantity changes |

🔗 Connects to: Manufacturing Material Transactions

---

### Manufacturing Material Transactions (`manufacturing_material_transactions`) 🔴
📦 Immutable log of every material movement (usage, receipt, adjustment).

🔗 Connects to: Manufacturing Materials, Users

---

### Manufacturing Settings (`manufacturing_settings`)
📦 Global manufacturing configuration. Single document (ID = "default").

---

### Laser Cut Batches (`laser_cut_batches`)
📦 Records of laser cutting runs.

| Field | What it is |
|-------|------------|
| `cuttingProgramLink` | Link to the cutting program used |
| `referencePhotos` | Photos of the cut output |

---

### Wax Filling Runs (`wax_filling_runs`)
📦 Records of wax filling operations on cartridges.

---

## 🔬 Cartridge & Reagent Domain

### Cartridge Records (`cartridge_records`) 🟡
📦 **Sacred document.** The permanent manufacturing record for a cartridge — like a birth certificate.

| Field | What it is |
|-------|------------|
| `corrections[]` | Append-only fix log (sacred pattern) |
| Wax inspection | `status: Accepted/Rejected/Pending` |
| Reagent inspection | `status: Accepted/Rejected/Pending` |

🔗 Connects to: Lot Records, Reagent Batches, Assay Definitions

---

### Reagent Batch Records (`reagent_batch_records`) 🟡
📦 **Sacred document.** A batch of reagent filling — tracks which cartridges got filled, by whom, on what robot.

| Field | What it is |
|-------|------------|
| `status` | `setup → running → completed / aborted / voided` |
| `assayType` | Which assay this batch is for (embedded) |
| `operator` | Who ran it (embedded) |
| `robot` | Which Opentrons robot (embedded) |
| `cartridgesFilled[]` | List of cartridge IDs that got filled |
| `inspectionStatus` | QC result: `Accepted / Rejected / Pending` |
| `corrections[]` | Sacred correction log |

🔗 Connects to: Assay Definitions, Opentrons Robots, Cartridge Records

---

### Assay Definitions (`assay_definitions`) 🟡
📦 **Sacred document.** Defines a test type (Cortisol, Testosterone, etc.) — its protocol, versions, and cost breakdown.

| Field | What it is |
|-------|------------|
| `name` | Assay name (e.g., "Cortisol") |
| `skuCode` | Unique product code |
| `isActive` | Currently in use? |
| `versions[]` | Version history with durations, metadata |
| `corrections[]` | Sacred correction log |

---

### Cartridge Groups (`cartridge_groups`)
📦 Logical groupings of cartridges (by lot, experiment, etc.)

---

### Lab Cartridges (`lab_cartridges`)
📦 Cartridges used in lab/R&D (separate from manufacturing cartridges).

| Field | What it is |
|-------|------------|
| `cartridgeType` | `measurement / calibration / reference / test` |
| `status` | `available → in_use → depleted / expired / quarantine / disposed` |
| `activityLog[]` | Full usage history |

---

### Consumables (`consumables`)
📦 Reusable items: incubator tubes, top seal rolls, decks, cooling trays.

| Field | What it is |
|-------|------------|
| `type` | `incubator_tube / top_seal_roll / deck / cooling_tray` |
| `currentCartridges` | What's loaded on/in it right now |
| `usageHistory[]` | When it was used and by whom |

---

## 🖥️ Device & Firmware Domain

### SPUs (`spus`) 🟡
📦 **Sacred document.** Sample Processing Unit — the reader device. Each one is individually tracked with a UDI.

| Field | What it is |
|-------|------------|
| `udi` | Unique Device Identifier (required) |
| `parts[]` | Components installed (with lot numbers, scanned barcodes) |
| `validationResults[]` | Test results (thermocouple, magnetometer, spectrophotometer) |
| `corrections[]` | Sacred correction log |

🔗 Connects to: Part Definitions, Batches, Particle Devices, Validation Sessions

---

### Particle Devices (`particle_devices`)
📦 IoT devices (Particle.io) linked to SPUs for connectivity.

| Field | What it is |
|-------|------------|
| `needsAttention` | Flag for devices requiring maintenance |
| `attentionReason` | Why it needs attention |

🔗 Connects to: SPUs

---

### Firmware Devices (`firmware_devices`)
📦 Device firmware records — what version is running, when last seen.

---

### Firmware Cartridges (`firmware_cartridges`)
📦 Cartridge-level firmware data — validation errors, test results, metadata.

---

### Device Events (`device_events`) 🔴
📦 **Immutable log.** Every device action: validate, load_assay, upload, reset, error.

| Field | What it is |
|-------|------------|
| `eventType` | `validate / load_assay / upload / reset / error` |
| `eventData` | Raw event payload |

---

### Test Results (`test_results`)
📦 Raw test data from SPU devices — spectral readings across channels.

| Field | What it is |
|-------|------------|
| `status` | `uploaded → processing → completed / failed` |
| `readings[]` | Channel A/B/C readings with timestamps |
| `metadata` | Device info, firmware version, etc. |

---

## 🔧 Assembly & Production Domain

### Assembly Sessions (`assembly_sessions`)
📦 A work session where someone is building/assembling an SPU.

| Field | What it is |
|-------|------------|
| `status` | `in_progress / paused / completed` |
| `stepRecords[]` | Each step completed (with scanned barcodes, timestamps) |

🔗 Connects to: SPUs, Work Instructions, Users

---

### Production Runs (`production_runs`)
📦 A planned production run — build N units following a work instruction.

| Field | What it is |
|-------|------------|
| `status` | `planning → in_progress → paused → completed` |
| `units[]` | Each unit being built (embedded) |
| `units[].status` | `pending → in_progress → completed` |

🔗 Connects to: Work Instructions, Users, SPUs

---

### Work Instructions (`work_instructions`)
📦 Step-by-step manufacturing procedures (like SOPs).

| Field | What it is |
|-------|------------|
| `status` | `draft → active → retired` |
| `versions[]` | Version history, each containing ordered steps |
| `versions[].steps[]` | Individual steps with part requirements, tool requirements, scan prompts, images |
| `versions[].steps[].fieldDefinitions[]` | Custom data capture fields (barcode_scan, manual_entry, date_picker, dropdown) |

🔗 Connects to: Part Definitions, Production Runs

---

### Part Definitions (`part_definitions`)
📦 Master list of all parts/components used in SPU assembly.

| Field | What it is |
|-------|------------|
| `partNumber` | Unique part number |
| `minimumOrderQty` | Reorder threshold |
| `sampleSize` / `percentAccepted` | QC sampling parameters |
| `isActive` | Currently in use? |

🔗 Connects to: SPU parts, BOM Items, Work Instruction steps

---

### Validation Sessions (`validation_sessions`)
📦 QC testing sessions — thermocouple, magnetometer, or spectrophotometer tests on SPUs.

| Field | What it is |
|-------|------------|
| `type` | Test type |
| `status` | `pending → in_progress → completed / failed` |
| `results[]` | Individual test results with raw + processed data |

🔗 Connects to: SPUs

---

## 📦 Inventory & BOM Domain

### BOM Items (`bom_items`)
📦 Bill of Materials — every component needed to build an SPU or cartridge.

| Field | What it is |
|-------|------------|
| `bomType` | `spu` or `cartridge` |
| `inventoryCount` | Current stock level |
| `minimumStockLevel` | Reorder point |
| `isActive` | Currently used in production? |
| `versionHistory[]` | Change log (create/update/delete with before/after values) |

---

### BOM Column Mapping (`bom_column_mapping`)
📦 Maps spreadsheet columns to BOM fields (for importing BOMs from Excel).

---

### Inventory Transactions (`inventory_transactions`) 🔴
📦 **Immutable log.** Every inventory movement — deductions, retractions, adjustments, receipts.

| Field | What it is |
|-------|------------|
| `transactionType` | `deduction / retraction / adjustment / receipt` |

🔗 Connects to: Part Definitions, Assembly Sessions, Users

---

## 📄 Document Control Domain

### Documents (`documents`)
📦 Controlled documents (SOPs, protocols, policies) with revision history and approval workflow.

| Field | What it is |
|-------|------------|
| `status` | `draft → in_review → approved → retired` |
| `revisions[]` | Version history with content and approval status |
| `revisions[].trainingRecords[]` | Who was trained on this revision |

---

### Document Repository (`document_repository`)
📦 File storage metadata for uploaded documents (links to Box.com or local storage).

---

## 🚚 Shipping & Customers Domain

### Customers (`customers`)
📦 Customer records with contacts, addresses, and notes.

| Field | What it is |
|-------|------------|
| `status` | `active / inactive` |
| `notes[]` | Timestamped notes about this customer |

---

### Shipping Lots (`shipping_lots`)
📦 A group of units being prepared for shipment — with QC testing before release.

| Field | What it is |
|-------|------------|
| `status` | `open → testing → released → shipped / cancelled` |
| `testResults[]` | QC checks: `pass / fail / pending` |

---

### Shipping Packages (`shipping_packages`)
📦 Individual packages within a shipment — tracking from creation to delivery.

| Field | What it is |
|-------|------------|
| `status` | `created → packing → packed → shipped → delivered` |

---

## 👥 Users & Auth Domain

### Users (`users`) 🟡
📦 **Sacred document.** User accounts — never deleted, only deactivated.

| Field | What it is |
|-------|------------|
| `username` | Login name (unique) |
| `roles[]` | Current role assignments with full permission lists |
| `roleHistory[]` | Complete history of role grants/revocations |
| `trainingRecords[]` | Document training completion records |
| `communicationPreferences[]` | How they want to receive notifications |
| `corrections[]` | Sacred correction log |

⚠️ Users can't be deleted — use `deactivatedAt` + `deactivationReason` instead.

---

### Roles (`roles`)
📦 Permission groups (Admin, Operator, Viewer, etc.)

| Field | What it is |
|-------|------------|
| `name` | Role name (unique) |
| `permissions[]` | List of permission strings (e.g., `manufacturing:write`) |

---

### Sessions (`sessions`)
📦 Active login sessions. Auto-expire after 30 days, renew within 15 days.

---

### Invite Tokens (`invite_tokens`)
📦 One-time-use tokens for inviting new users.

| Field | What it is |
|-------|------------|
| `status` | `pending → accepted / expired` |

---

## 📋 Kanban & Project Management

### Kanban Projects (`kanban_projects`)
📦 Project containers for organizing tasks.

---

### Kanban Tasks (`kanban_tasks`)
📦 Individual work items on the board.

| Field | What it is |
|-------|------------|
| `status` | `backlog → ready → wip → waiting → done` |
| `priority` | `high / medium / low` |
| `taskLength` | `short / medium / long` |
| `comments[]` | Discussion thread |
| `actionLog[]` | Full activity history |
| `proposals[]` | Agent-suggested changes (`pending / approved / edited / vetoed`) |

---

## 🤖 Agent & Integration Domain

### Agent Messages (`agent_messages`)
📦 Messages between the AI agent and the system.

| Field | What it is |
|-------|------------|
| `messageType` | `info / alert / request / approval / status_update / meeting_summary` |
| `priority` | `low / normal / high / urgent` |
| `status` | `pending → sent → delivered → read → actioned / failed` |

---

### Agent Queries (`agent_queries`)
📦 Pre-defined database queries the agent can execute.

---

### Approval Requests (`approval_requests`)
📦 Change approval workflow — code, config, infrastructure, process, documentation, or database changes.

| Field | What it is |
|-------|------------|
| `status` | `pending → in_review → approved / rejected / cancelled / expired` |
| `priority` | `low / normal / high / urgent / emergency` |

---

### Integrations (`integrations`)
📦 External service connections (Box.com, Particle.io).

---

### Opentrons Robots (`opentrons_robots`)
📦 Lab automation robots — protocols, health checks, calibration data.

---

## 🔒 Audit & Compliance Domain

### Audit Log (`audit_log`) 🔴
📦 **Immutable.** Every data change in the system — who changed what, when, and why.

| Field | What it is |
|-------|------------|
| `action` | `INSERT / UPDATE / DELETE / PHASE_ADVANCE` |
| `oldData` / `newData` | Before and after snapshots |
| `changedBy` | User who made the change |
| `reason` | Why (if provided) |

---

### Electronic Signatures (`electronic_signatures`) 🔴
📦 **Immutable.** 21 CFR Part 11 compliant e-signatures — password-verified, SHA-256 hashed.

---

### Generated Barcodes (`generated_barcodes`)
📦 Barcode sequences — ensures uniqueness across the system.

---

## Utility Collections

| Collection | Purpose |
|------------|---------|
| `routing_patterns` | AI message routing rules |
| `system_dependencies` | Tracks inter-system dependencies |
| `schema_metadata` | Describes tables for agent queries |
| `files` | File metadata (uploads, attachments) |
| `equipment` | Lab equipment (fridges, ovens) |
| `equipment_locations` | Physical locations with barcodes |
| `batches` | SPU manufacturing batches |

---

## Quick Permission Reference

Permissions follow the pattern `{resource}:{action}`:

| Resource | Actions |
|----------|---------|
| `admin` | `full`, `users` |
| `user`, `role` | `read`, `write` |
| `kanban` | `read`, `write`, `admin` |
| `spu` | `read`, `write`, `admin` |
| `document` | `read`, `write`, `approve`, `train` |
| `inventory` | `read`, `write` |
| `cartridge`, `cartridgeAdmin` | `read`, `write` |
| `assay`, `device`, `testResult` | `read`, `write` |
| `manufacturing` | `read`, `write`, `admin` |
| `waxFilling`, `reagentFilling` | `read`, `write` |
| `workInstruction` | `read`, `write`, `approve` |
| `productionRun` | `read`, `write` |
| `shipping`, `customer`, `equipment` | `read`, `write` |

---

## Data Flow: Cartridge Lifecycle

```
Raw Materials (manufacturing_materials)
    ↓ consumed via
Lot Record (lot_records) — WI-01: Cut cartridge backs
    ↓ produces
Cartridge Record (cartridge_records) — 🟡 Sacred, permanent record
    ↓ filled by
Reagent Batch (reagent_batch_records) — 🟡 Sacred, links to Opentrons robot
    ↓ inspected via
QA/QC inspection → Accepted / Rejected
    ↓ if accepted
Shipping Lot (shipping_lots) → testing → released
    ↓
Shipping Package (shipping_packages) → packed → shipped → delivered
    ↓
Customer (customers)
```

## Data Flow: SPU Lifecycle

```
Part Definitions (part_definitions)
    ↓ specified in
Work Instruction (work_instructions) — steps with part/tool requirements
    ↓ executed as
Production Run (production_runs) — N units planned
    ↓ each unit built via
Assembly Session (assembly_sessions) — barcode scanning, step completion
    ↓ creates
SPU (spus) — 🟡 Sacred, with parts[], UDI, particle link
    ↓ validated by
Validation Session (validation_sessions) — thermocouple, magnetometer, spectro
    ↓ signed off with
Electronic Signature (electronic_signatures) — 🔴 Immutable, 21 CFR Part 11
```

---

*Generated by Agent001 — March 2, 2026*
