# Ask BIMS — Roadmap to Operator Powerhouse

**Status:** Phase 1 shipped (2026-05-05). Phases 2+ planned, awaiting per-phase go-ahead.
**Scope:** Internal Q&A agent powered by Claude API, surfaced as `/admin/ask-bims` and a floating widget on every page.
**Goal:** A reliable assistant that answers natural-language questions about manufacturing operations grounded in real BIMS data — accurate, auditable, traceable, never confidently wrong.

---

## Why this document exists

Ask BIMS gave a user wrong information about wax inventory on 2026-05-05. The agent wasn't broken; the **tool surface was misaligned with the data model.** `list_wax_batches` queried the legacy `WaxBatch` collection, but operational wax inventory lives in `ReceivingLot.consumedUl` for PT-CT-114 tubes. Claude faithfully reported what the tool returned. The tool was the bug.

That incident is the design north-star for everything in this document:

> **The agent is only as good as its tools, and the tools are only as good as the alignment between schema and operational reality.**

A separate audit (run 2026-05-05) catalogued the full BIMS data landscape — 84 Mongoose models, every operational page, every cross-model link, every legacy/migrating pattern. Findings are summarized below and inform every phase.

---

## Architectural principles (Phase 0 lessons)

These are non-negotiable rules for every future tool addition.

1. **Source-of-truth tagging.** Every tool description says explicitly *what model it queries* and *whether that model is the operational source of truth* for the question domain. If two models exist (e.g., WaxBatch vs ReceivingLot for wax), only one tool answers the operational question; the other is labeled "legacy" with a warning.
2. **Verifiable answers.** Every tool result carries `source` (one-line description of the query) and `sourceUrl` (a route that lets the operator verify in the UI). The chat UI renders that as a "Verify in BIMS →" link on every tool call.
3. **Data integrity surfacing.** Tool results carry an optional `dataIntegrityNotes` array. When the underlying data has known weakness — null FKs, stale denormalized counters, suspicious patterns — the tool emits a note. The UI shows these as a yellow warning callout. The system prompt instructs Claude to surface them in plain language.
4. **Cross-validation by default.** When two tools could disagree, the agent prefers the one with clearest provenance and explicitly notes the discrepancy if both are queried.
5. **Trust events, not counters.** Denormalized counters (`PartDefinition.inventoryCount`, dashboard summaries) drift. Tools that aggregate from event tables (transactions, lots, runs) are preferred over tools that read pre-computed totals.
6. **Permission-mirrored.** Tools respect the same `requirePermission` gates as the surfaces they expose. If a user can't access a page, they can't ask Ask BIMS to dump the same data.
7. **Cost-bounded.** Per-question tokens capped, max iterations capped, model selection gated for expensive tiers, per-session budget warning at $1, Anthropic console hard cap as last resort.

---

## Phase 0 — Currently shipped (2026-05-05)

The base agent + 11 tools + UI surfaces exist on `dev`. Per the audit, the foundation is solid; the wax tool is the only known data-source bug.

| Surface | Location | Status |
|---|---|---|
| Server agent loop | `src/lib/server/ask-bims.ts` | Live |
| API endpoint | `src/routes/api/agent/ask/+server.ts` | Live (Opus admin-gated) |
| Admin chat page | `src/routes/admin/ask-bims/+page.svelte` | Live |
| Floating widget | `src/lib/components/ask-bims/AskBimsWidget.svelte` | Live (z-index 40, hidden on /login, /logout, /invite, /cv) |
| Model toggle | Haiku 4.5 / Sonnet 4.6 / Opus 4.7 | Live |
| Per-message + per-session cost display | Both surfaces | Live |
| $1 spend confirm | Both surfaces | Live |

Tools currently exposed: `list_wax_batches` (deprecated this phase), `get_temperature_alerts`, `get_current_temperatures`, `list_recent_runs`, `list_low_inventory_parts`, `find_part`, `find_cartridges`, `list_equipment`, `get_run_yield`, `trace_cartridge`, `count_cartridges_by_status`.

---

## Phase 1 — Foundation hardening (this commit)

Shipped 2026-05-05.

### 1.1 Wax tool migration

`list_wax_batches` is split into two tools:

- **`get_wax_tube_inventory`** — queries `ReceivingLot` where `part.partNumber = 'PT-CT-114'` and status in (`accepted`, `in_progress`). Computes per-lot remaining volume from `quantity × 12,000 µL − consumedUl`. This is now the source of truth for "how much wax do we have."
- **`list_legacy_wax_batches`** — still queries `WaxBatch` but with a description that explicitly tags the model as legacy / non-authoritative and a `dataIntegrityNotes` warning that triggers whenever the tool returns rows.

### 1.2 Skeptic system prompt

The system prompt has a new "ACCURACY DISCIPLINE" section with six explicit rules:
1. Pick the right tool (read descriptions, prefer source-of-truth).
2. Surface inconsistencies; do not paper over them.
3. Honor `dataIntegrityNotes` from tool results.
4. Cite sources; refer to `sourceUrl` so operators can verify.
5. Calibrate confidence based on optional/often-null fields.
6. Trust events, not counters.

### 1.3 Per-tool annotations

Every one of the 12 tool descriptions now includes:
- Source line: model + filter that's queried
- "Use when:" examples
- "Don't use for:" anti-patterns
- "Caveat:" for known limitations (e.g., null waxSourceLot on many runs, stale temperature reads)

### 1.4 Verify-source UI

Each tool result returns:
- `source` — one-line description of what was queried
- `sourceUrl` — route the operator can visit to verify

The chat UI renders these as "Verify in BIMS →" links on every tool call entry. Both surfaces (admin page + floating widget) render them.

### 1.5 Data integrity surfacing

Tools now emit `dataIntegrityNotes[]` for known data quality issues. Examples currently wired:
- `list_recent_runs` notes runs with null `waxSourceLot`
- `get_run_yield` notes if the specific run has null `waxSourceLot`
- `trace_cartridge` notes when wax provenance can't be traced upstream
- `get_current_temperatures` notes equipment with `lastTemperatureReadAt > 1 hour` old
- `list_legacy_wax_batches` always notes its legacy status when it returns rows
- `list_low_inventory_parts` notes that `inventoryCount` is denormalized

The UI renders these as a yellow callout above the tool details disclosure.

### 1.6 Updated `find_cartridges`

Added `runId` filter so questions like "what cartridges came out of run X" can be answered without going through `get_run_yield`.

---

## Phase 2 — Operational coverage (next, ~1-2 days each subsection)

Goal: cover every domain the audit identified, in priority order. After Phase 2, an operator should be able to ask any question that maps to a BIMS page and get a grounded answer.

### 2.1 Inventory + receiving

Models in scope: `ReceivingLot`, `InventoryTransaction`, `BarcodeInventory`, `PartDefinition`.

New tools:
- `get_part_lot_history(partNumber)` — list ReceivingLots for a part with received date, supplier lot, current consumed/remaining, status. Replaces the unreliable `inventoryCount` for any part.
- `list_receiving_inspections(sinceDays?)` — recent CoC/IP inspections from `InspectionResult`, with pass/fail/manual_review counts.
- `inventory_transactions_for_lot(lotId)` — show every consumption event tied to a specific receiving lot.
- `inventory_consumption_rate(partNumber, days)` — aggregate `InventoryTransaction` over a window, return units/day with stdev.

### 2.2 Manufacturing — full run telemetry

Models in scope: `WaxFillingRun`, `ReagentBatchRecord`, `LotRecord` (WI-01), `LaserCutBatch`, `WorkflowViolation`.

New tools:
- `get_run_details(runId)` — full record for a run including operator, robot, deck, planned vs actual cartridge count, notes, abort reasons, all cartridges produced.
- `list_active_runs()` — runs currently in non-terminal status (`Setup`, `Loading`, `Running`, `Cooling`, `QC`, `Inspection`).
- `list_workflow_violations(sinceDays?)` — SOP deviations recorded against runs/cartridges.
- `list_wi01_runs(sinceHours?)` — backing oven LotRecord entries (currently invisible to Ask BIMS).
- `list_laser_cut_batches(sinceHours?)` — substrate cutting runs (also currently invisible).

### 2.3 Cartridge admin + groups

Models in scope: `CartridgeRecord` (deeper), `CartridgeGroup`, `LabCartridge`.

New tools:
- `list_cartridges_in_storage(fridgeId?)` — cartridges currently in `wax_stored` status, optionally filtered to a fridge.
- `list_voided_cartridges(sinceDays?)` — surface deliberately voided cartridges with reasons.
- `cartridge_throughput(sinceDays)` — count of cartridges by phase transition per day (backing → wax → QC → reagent → ship).

### 2.4 QC + validation

Models in scope: `InspectionResult`, `ValidationSession` (magnetometer/thermocouple/lux/spectrophotometer), `CalibrationRecord`, `ToolConfirmation`, `ApprovalRequest`.

New tools:
- `list_validation_sessions(spuId?, type?, sinceDays?)` — SPU validation runs with pass/fail.
- `list_calibrations_due(equipmentType?)` — equipment with `nextCalibrationDue <= today + 30 days`.
- `list_open_approval_requests()` — pending approvals (e.g., scrap requests, deviations).

### 2.5 Equipment + sensors

Models in scope: `Equipment` (deeper), `TemperatureReading` (time-series), `SensorConfig`, `ServiceTicket`, `EquipmentLocation`.

New tools:
- `get_temperature_history(equipmentName, sinceHours)` — time-series of `TemperatureReading` for a sensor; return min/max/avg + last 100 points.
- `list_open_service_tickets(equipmentType?)` — maintenance backlog.
- `equipment_uptime(equipmentName, sinceDays)` — % time the sensor reported within range.
- `get_sensor_config(equipmentName)` — thresholds + alert configuration.

### 2.6 Documents, training, instructions

Models in scope: `Document`, `WorkInstruction`, `User.trainingRecords[]`.

New tools:
- `find_work_instruction(query)` — locate a WI by document number or name.
- `get_user_training(username)` — show training history (admin-gated).
- `list_recent_document_changes(sinceDays)` — controlled-doc revision activity.

### 2.7 Shipping + customers

Models in scope: `ShippingLot`, `ShippingPackage`, `Customer`, `CartridgeRecord.shipping`.

New tools:
- `list_open_shipping_lots()` — lots in `open`, `testing`, `released` status.
- `find_shipping_package(trackingNumber)` — reverse lookup by carrier tracking.
- `cartridges_per_customer(customerName, sinceDays)` — aggregate shipped cartridges.

### 2.8 Audit + activity

Models in scope: `AuditLog`, `ProcessAnalyticsEvent`, `ScannerEvent`, `DeviceLog`, `DeviceCrash`.

New tools:
- `recent_audit_events(tableName?, recordId?, sinceHours?)` — admin-only.
- `recent_device_crashes(sinceHours?)` — instrument exceptions.
- `recent_scanner_events(sinceMinutes?)` — for debugging "the scanner isn't working."

### Phase 2 acceptance gate

Before declaring Phase 2 done:
- Every domain in the audit has at least one tool exposing its source-of-truth model.
- A manual test plan covers the "top 20 operator questions" (gathered via interviews — see Phase 7).
- All tools have `source`, `sourceUrl`, and at least one `dataIntegrityNote` test case.

---

## Phase 3 — Cross-model intelligence

Once Phase 2 covers the basics, build genealogy and traceability tools that walk the FK chains identified in the audit.

New tools:
- **`forward_genealogy(receivingLotId)`** — given a ReceivingLot, list every cartridge that consumed material from it (via `WaxFillingRun.waxSourceLot`, `ReagentBatchRecord.tubeRecords[].sourceLotId`, `CartridgeRecord.backing.lotId`). This is the "if this lot was bad, what's downstream?" tool — a recall enabler.
- **`backward_genealogy(cartridgeId)`** — full lineage for a cartridge across every input lot, run, robot, operator, QC, storage, reagent, and shipment. Supersedes `trace_cartridge` with deeper joins.
- **`run_yield_trend(robotName, sinceDays)`** — per-run yield over time for a specific robot. Detects drift.
- **`scrap_pareto(sinceDays)`** — group scrapped cartridges by reason, surface top contributors. Uses `WorkflowViolation` + `CartridgeRecord.waxQc.notes`.
- **`assay_lot_cross_reference(assayName, sinceDays)`** — for a given assay, list every reagent batch produced and every shipment that included those carts.

### Cross-model integrity health-check

A dedicated tool `check_data_integrity()` that the agent can call when uncertain:
- Counts runs with null `waxSourceLot`
- Counts cartridges in non-terminal status with no robot lock
- Counts ReceivingLots with `consumedUl > quantity * 12000` (over-consumption — should be impossible)
- Returns a list of detected anomalies

When the agent calls this and finds anomalies, it pre-empts the user: "Before I answer, I noticed N data integrity issues that may affect this answer."

---

## Phase 4 — Time-series & trends

Goal: questions that span time windows. Yield trends, alert rates, throughput.

Models in scope: `TemperatureReading`, `TemperatureAlert`, `AuditLog`, `InventoryTransaction`, `WaxFillingRun.runStartTime/runEndTime`, `ProcessAnalyticsEvent`.

New tools:
- `temperature_excursion_summary(equipmentName, sinceDays)` — minutes out-of-spec, # of alerts, longest excursion.
- `production_throughput(processType, sinceDays, granularity)` — daily/weekly cartridge counts.
- `inventory_burn_rate(partNumber, sinceDays)` — units/day consumed, projected days-to-empty given current stock.
- `alert_frequency_by_equipment(sinceDays)` — which sensors are noisiest.
- `defect_rate_by_robot(sinceDays)` — yield comparison across OT-2 robots.

Existing analytics modules (`src/lib/server/analytics/runs-feed.ts`, `stats.ts`) already encode much of this — most Phase 4 tools should be thin wrappers calling those functions, not new aggregations.

### SPC integration

Models in scope: `SpecLimit`, `SpcSignal`, `FmeaRecord`, `CauseEffectDiagram`.

New tools:
- `list_recent_spc_signals(processType?, sinceDays?)` — Nelson rule violations.
- `get_spec_limits(processType, metric)` — control limits for a process metric.
- `fmea_for_process(processType)` — failure modes ranked by RPN.

---

## Phase 5 — Predictive & workflow-aware

Goal: questions that anticipate operational needs.

New tools:
- **`runway(partNumber)`** — projected days until stockout based on rolling consumption rate. Uses `inventory_burn_rate` + current `ReceivingLot` accepted stock.
- **`calibrations_due(daysAhead)`** — equipment whose `nextCalibrationDue` falls in the window.
- **`whats_blocking_run(runId)`** — diagnostic: is the deck locked? Is the cooling tray locked? Is the wax source consumed? Are we waiting on QC?
- **`next_runs_to_qc()`** — wax runs in `Awaiting Removal` or `QC` status with cartridge counts.
- **`shipment_readiness(customerName?)`** — shipping lots with QA/QC release counts, ready to ship vs blocked.

This is where Ask BIMS starts adding value beyond "look something up" — it starts answering "what should I do next."

---

## Phase 6 — Compliance & governance

Goal: every interaction is auditable; sensitive data respects the same gates as the UI.

### 6.1 Conversation logging

- Persist every Q&A pair to `AgentQuery` (already exists in the model layer): user, question, model, tools called, answer, cost, timestamp.
- Admin page to view conversation history per user.
- Retention: 1 year (matches typical FDA QMS retention windows).

### 6.2 Permission-aware tools

- Every tool checks the calling user's permissions via `hasPermission()`.
- Tools that read regulated documents (work instructions, training records, signed records) are gated to roles that can view them in the UI.
- The agent's system prompt is updated dynamically with the user's permission set so it doesn't propose tools the user can't use.

### 6.3 PII / regulated-data redaction

- For shipping/customer queries, customer PII (contact info) is admin-gated.
- Patient-identifying data, if present, is never returned through Ask BIMS regardless of role.

### 6.4 Output cap on Opus

- Even though Opus is admin-gated, add a hard $5/question cap on Opus calls. Anthropic console spend cap is the bedrock; this is a defense-in-depth.

---

## Phase 7 — Operator training & onboarding

Goal: Ask BIMS becomes a teaching tool. New hires can ask "explain how a wax run works" and get a grounded walkthrough referencing real BIMS pages.

### 7.1 Training mode

- Toggle in widget: "Training mode" (default off).
- When on, the system prompt switches to encourage explanation over query, with references to the actual SOPs in `Document` and `WorkInstruction`.
- Tools available: same Phase 2 set + `find_work_instruction`, `get_document_revisions`.

### 7.2 Operator question audit

- Run interviews with 5-10 operators across roles (wax tech, reagent tech, QC inspector, receiving, shipping).
- Capture the top 50 questions they actually ask.
- Validate Phase 2 tool coverage against this list. Add tools where gaps exist.
- Build a one-pager training guide ("How to use Ask BIMS — examples that work, examples that don't").

### 7.3 In-page contextual help

- Floating widget gets a "What can I ask on this page?" button.
- Server-side, the API knows what page the user is on (via `Referer` or explicit param) and returns 3-5 example questions tailored to that page's data.

---

## Phase 8 — Self-healing & anomaly detection

Goal: Ask BIMS proactively flags drift instead of waiting to be asked.

### 8.1 Background data-health monitor

- Cron job (Vercel Cron) runs `check_data_integrity()` daily and writes anomalies to a `BimsAnomaly` collection (new model).
- Examples flagged: runs with null waxSourceLot, ReceivingLots with negative remaining (consumedUl > total), Equipment with `lastTemperatureReadAt > 4 hours` old, cartridges stuck in non-terminal status > 7 days.
- Admin dashboard surfaces this list.

### 8.2 Conversation feedback loop

- After every answer, the user can tag thumbs-up/thumbs-down with optional comment.
- Tagged answers get reviewed weekly. Patterns of "wrong" answers feed tool refinements.
- Stored in `AgentQuery.feedback`.

### 8.3 Tool deprecation pipeline

- Every tool gets an annotation `version` and `lastValidated` date.
- Quarterly review: any tool not validated in 90 days gets a smoke-test run; failures flag it for fixing.
- Tools with persistent issues are deprecated (description rewritten to "do not use") rather than silently breaking.

---

## Tool inventory by phase

| Phase | Tool count | Cumulative | New surfaces |
|---|---|---|---|
| 0 (shipped before today) | 11 | 11 | Admin chat, floating widget, model toggle |
| 1 (today) | 12 | 12 | Sourcing, integrity notes, verify links |
| 2 | +24 (rough est) | ~36 | Full domain coverage |
| 3 | +6 (genealogy) | ~42 | Multi-hop traceability |
| 4 | +10 (time-series) | ~52 | SPC, trends |
| 5 | +5 (predictive) | ~57 | Workflow-aware |
| 6 | (no new tools, infrastructure) | ~57 | Audit log, perms |
| 7 | +3-5 (training mode) | ~62 | Training tooling |
| 8 | (no new tools, monitoring) | ~62 | Data health dashboard |

Final state: ~60 tools covering every domain the audit identified.

---

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| **Tool description bloat blows the prompt cache budget** | Anthropic minimum cacheable prefix is 2,048 tokens. Currently we're below that anyway. As we add tools, monitor `cache_creation_input_tokens` vs `cache_read_input_tokens` — if cache hit rate drops below 80%, restructure tool docs into a more compact format. |
| **Schema migrations break tools silently** | Phase 8 tool deprecation pipeline. Every tool has a smoke-test query; CI runs them weekly. |
| **Operators trust answers blindly** | Source URLs + integrity notes are non-removable. Phase 7 training emphasizes "Ask BIMS is a starting point, not the final word." |
| **Cost runs away on Opus** | Opus admin-gated, per-session budget warn, Anthropic console hard cap. Phase 6 adds per-question cap. |
| **Permissions drift** | Phase 6 reuses existing `requirePermission` gates — no parallel auth system. |
| **Conversation context window overflow on long chats** | Already capped: 8 iterations × 4096 tokens per turn. Phase 4 adds context compaction if conversations get longer. |
| **Wrong tool picked for a question** | Phase 1 system prompt explicitly tells Claude how to choose. Phase 7 training builds operator intuition for question framing. |

---

## What I want from you (operator / stakeholder)

To execute beyond Phase 1, I need:

1. **Approval to proceed** with Phase 2 (~5-10 days of work depending on tool count).
2. **Operator interviews** (Phase 7.2) — schedule 30-min slots with each role.
3. **Permission decisions** — who can ask Ask BIMS what? Default proposal: anyone with login can ask basic questions; admins can ask audit/governance questions.
4. **Feedback on Phase 1** — does the verify-source link UX feel right? Are integrity notes too noisy or just right?

Time and approval permitting, the entire plan is achievable in ~6-8 weeks of focused work.
