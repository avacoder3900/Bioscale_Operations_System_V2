# Ask BIMS — Additive Tools PRD (Phase 6)

**Goal:** Add every reasonable new way to ask Ask BIMS a question, without changing any existing BIMS functionality outside the agent itself. Three buckets, ~20 new tools, plus a polish pass on the non-high-confidence answers from the last acceptance run.

**Branch:** stay on `feat/ask-bims-markdown-context`. Push after each phase.

**Hard rules:**
- Read-only across the board. No schema migrations. No new collections beyond what already exists.
- Never push to `main` or `master`.
- Don't touch existing form actions, page server loaders, or non-agent code.
- Run `npx tsx scripts/test-ask-bims.ts --model haiku --max-cost 3` after each tool group. Halt on regression.
- Every new tool needs at least one fixture in `tests/ask-bims/baseline.ts`.
- Voice-rules apply to every tool description. Lab-first language. No leaking schema field names to operators.
- Confidence-heuristic discipline: don't emit `dataIntegrityNotes` casually. Only emit when there's a real caveat the operator should know about. Routine "I found N rows" status is not a note.

---

## Phase 6.1 — Operational coverage (Bucket 1, 9 tools)

These map directly to daily-frequency operator questions that currently dead-end.

### 6.1.1 `list_workflow_violations(sinceDays?, severity?, status?)`

**Operator question:** "What runs deviated from the SOP this week?"
- Source: `WorkflowViolation` model.
- Returns: violation list with run reference, severity, who flagged it, status (open/resolved).
- Sort newest first, default sinceDays=7, hard limit 50.

### 6.1.2 `list_validation_sessions(spuId?, type?, status?, sinceDays?)`

**Operator question:** "Has SPU-42 been validated this quarter?" / "Show me failed thermocouple validations."
- Source: `ValidationSession` model.
- Filter by SPU, validation type (thermocouple/magnetometer/spectrophotometer), status, time window.
- Hard limit 50.

### 6.1.3 `list_open_approval_requests(targetType?, requestType?)`

**Operator question:** "What scrap/deviation approvals are pending my review?"
- Source: `ApprovalRequest` model where status in [pending, in_review].
- Newest first, hard limit 50.

### 6.1.4 `equipment_uptime(equipmentName, sinceDays?)`

**Operator question:** "What percent of last 30 days was Fridge 3 in range?"
- Source: `TemperatureReading` model joined with `Equipment` model's thresholds.
- Compute % of readings within [temperatureMinC, temperatureMaxC] over the window.
- Default sinceDays=30. Return uptime%, total readings, in-range count, out-of-range count, gap count (>1h between readings).

### 6.1.5 `list_open_service_tickets(equipmentType?, sinceDays?)`

**Operator question:** "What equipment is currently broken?"
- Source: `ServiceTicket` model where status not in [closed, resolved].
- Newest first, hard limit 50.

### 6.1.6 `recent_device_events(deviceId?, eventType?, sinceHours?)`

**Operator question:** "What did Device X do recently?" / "Show me recent errors."
- Source: `DeviceEvent` model.
- Filter by device, event type (validate/load_assay/upload/reset/error), time window.
- Default sinceHours=24. Hard limit 100.

### 6.1.7 `recent_scanner_events(deviceId?, sinceMinutes?)`

**Operator question:** "Why did the scanner go quiet?"
- Source: `ScannerEvent` model.
- Default sinceMinutes=60. Hard limit 100.

### 6.1.8 `list_open_shipping_lots()`

**Operator question:** "What lots are waiting to ship?"
- Source: `ShippingLot` model where status in [open, testing, released].
- Newest first.

### 6.1.9 `find_shipping_package(query)`

**Operator question:** "Where is package <tracking-id>?" / "Find shipment for cart X."
- Source: `ShippingPackage` model.
- Search by tracking number, package _id, or contained cartridgeId.
- Hard limit 10.

### 6.1.10 `get_user_training(username)` — admin-gated

**Operator question:** "Has Nick been trained on WI-01?"
- Source: `User.trainingRecords[]` subdoc array.
- Requires `admin:full` permission. Return all training records for the named user.
- If caller is not admin, return a clean "this requires admin access" message via the standard tool-error path.

### 6.1.11 `list_recent_document_changes(sinceDays?, status?)`

**Operator question:** "Which controlled docs changed this week?"
- Source: `Document.revisions[]` — surface documents with any revision newer than the window.
- Default sinceDays=7. Hard limit 30.

---

## Phase 6.2 — Chemical & floor-plan extensions (Bucket 3, 3 tools + 1 polish)

Built on the chemical inventory CSVs and the floor-plan module already bundled in Phase 2/3.

### 6.2.1 `chemical_hazard_summary(query)`

**Operator question:** "Is methanol safe to store next to H2O2?" / "What hazards apply to chemical C-091?"
- Source: chemical-inventory CSVs.
- Returns: hazard class breakdown (HTX, FLAM, OX, COR), storage class incompatibilities (oxidizers shouldn't be near flammables, acids away from bases, etc.), and storage notes.
- Compatibility matrix should be hardcoded inside the tool (small, well-known chemistry rules — flammable vs oxidizer, acid vs base, water-reactive isolation, etc.).
- Surface hazard class for any returned chemical. If two or more chemicals are queried (e.g. comma-separated list), check pairwise compatibility.

### 6.2.2 `chemicals_in_protocol(protocolId)`

**Operator question:** "What raw chemicals does the Active Beads v3 protocol consume?"
- Source: `ProtocolDefinition.materials[]` → trace to ReagentCatalog (which references a `chemicalInventoryCode` if present) → join to chemical inventory CSVs.
- Note: if protocols don't currently link to raw chemicals, return the prepared reagents they consume PLUS a note explaining the chain doesn't reach raw chemicals automatically yet.
- Hard limit 50 materials.

### 6.2.3 `chemical_burn_rate(query, sinceDays?)`

**Operator question:** "How fast are we burning through IPA?" / "When will we run out of methanol?"
- Source: chemical inventory + the receiving/usage history we have on file.
- Compute: current quantity, observed consumption rate, days remaining at current rate.
- **Limitation note:** consumption tracking for raw chemicals isn't currently in BIMS (no `chemical_transactions` collection). For chemicals where we don't have usage data, return current quantity + a clear note that runway can't be computed yet.

### 6.2.4 Polish: floor-plan tool should NOT default to degraded confidence

The Phase 3 `find_location` tool emits a `dataIntegrityNotes` entry on most successful answers (likely "this tag isn't in the corpus" or "approximate match"). Confidence then drops to degraded for clean queries like "Where is Fridge 3?"

**Fix:** Tighten the integrity-note logic so it only fires when:
- The query was a tag that genuinely doesn't resolve, OR
- The agent had to guess at a zone (low-confidence fuzzy match), OR
- The tag-to-zone mapping is incomplete for that tag

For clean tag→zone resolutions, return no `dataIntegrityNotes` at all. The acceptance run should show floor-plan answers at "high" confidence after this fix.

---

## Phase 6.3 — Manufacturing analytics (Bucket 2 focused subset, 4 tools)

These are bigger questions for engineering reviews + QA audits. Lower frequency but higher value when asked.

### 6.3.1 `yield_trends_by_robot(robotName?, sinceDays?)`

**Operator question:** "Is Robot 2 yielding worse than Robot 1 over the last month?"
- Source: `WaxFillingRun` + `ReagentBatchRecord` joined with cartridges produced.
- Group by robot, compute per-day yield % over the window.
- Default sinceDays=30. If no robotName, return trend per robot for comparison.
- Hard limit 90 days history.

### 6.3.2 `scrap_pareto(sinceDays?, byField?)`

**Operator question:** "Rank scrap reasons for last 30 days."
- Source: `CartridgeRecord` with status in [scrapped, voided] within window.
- Default byField='reason' (extracted from `qaqcRelease.scrappedReason` or `waxQc.notes`). Optionally byField='robot' or byField='operator' for slicing.
- Return ranked list with counts + percent of total.
- Default sinceDays=30. Hard limit 20 rows.

### 6.3.3 `assay_lot_cross_reference(assayName, sinceDays?)`

**Operator question:** "Which shipments used reagent batches for assay Cortisol?"
- Source: `AssayDefinition` → `ReagentBatchRecord.assayType` → cartridges filled → shipments containing those cartridges.
- Default sinceDays=90. Return assay → reagent batches → shipment list with shipped dates + customer.
- Hard limit 50 batches.

### 6.3.4 `production_cycle_time(processType?, sinceDays?)`

**Operator question:** "How long is wax filling actually taking these days?"
- Source: `LotRecord.cycleTimeSeconds` (already computed on the row).
- Group by processType (wax_filling, reagent_filling, etc.), compute p50 + p90 + max over window.
- Default sinceDays=30. Hard limit 90 days.

---

## Phase 6.4 — Tool description polish + harness fixtures

After all the new tools land, do one polish pass:

1. **Read all the new tool descriptions** end-to-end and tighten any voice violations. Specifically: any description that references a Mongoose collection name should re-phrase ("the workflow violation records" → "the SOP-deviation log we keep on every run"). Keep `Source:` lines as-is — those are internal annotations the agent reads, not operator-facing.

2. **Add 1-2 fixtures per new tool** to `tests/ask-bims/baseline.ts`. Use the operator-question phrasings from the PRD as the fixture text. Target categories:
   - `phase6` for Bucket 1 tools
   - `phase6-chem` for chemical extensions
   - `phase6-analytics` for manufacturing analytics
   - Re-grade if existing categories fit better.

3. **Run the acceptance script one more time** to capture answers from all the new tools: `npx tsx scripts/run-acceptance.ts --model haiku`. Add representative questions for the new tools to `scripts/run-acceptance.ts` before running. The output markdown is the final hand-off artifact.

---

## What we are NOT doing (read this and don't drift into it)

- **No edits to existing BIMS functionality.** No changes to form actions, no schema migrations, no production-side behavior changes. The agent layer is the only thing growing.
- **No new collections.** All tools read from existing models. If a piece of data doesn't exist yet (like raw-chemical consumption tracking), surface that as a clear limitation in the tool's answer.
- **No infrastructure changes.** Tool routing, hybrid retrieval, LLM-as-judge, verifier models — all deferred until evidence warrants.
- **No `.svelte` edits.** The widget and admin pages already shipped what they need for this scope.
- **No QMS / CAPA expansion.** That's a downstream phase if/when those workflows mature.

---

## Sequence + budget

Phase order: **6.1 → 6.2 → 6.3 → 6.4 (polish)**.

Per-phase: implement → run harness → commit → push. Halt on regression.

**Budget cap: $15** total Anthropic API spend across the autonomous run (this is ~3x the previous build because the scope is ~3x). Halt at $14 and report cleanly.

If you run out of budget mid-phase: commit what's clean, push, report what's left undone. **Always leave the suite green.**

---

## Final report shape

When you're done, report back with:
- Every commit hash and a one-line description
- Final harness pass count and cost-per-run
- Per-phase summary of what shipped vs deferred (if anything was deferred)
- Total autonomous spend
- Any limitation notes worth surfacing (e.g. "chemical burn rate returns runway=null for chemicals without consumption tracking, which is most of them")
- One sentence on what's left for a future session

That's it. Run tight, ship clean, talk like a coworker in every commit message and tool description.
