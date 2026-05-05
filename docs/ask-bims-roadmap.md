# Ask BIMS — Roadmap (Revision 2)

**Status:** Phase 1 shipped (2026-05-05). Phases 1.5, 1.6, 1.7 are now blockers for Phase 2 per audit.
**Scope:** Internal Q&A agent powered by Claude API, surfaced as `/admin/ask-bims` and a floating widget on every page.
**Goal:** A reliable assistant that answers natural-language questions about manufacturing operations grounded in real BIMS data — accurate, auditable, traceable, never confidently wrong, and proven to be all of those things.

---

## Why this revision exists

Revision 1 was directionally correct but had 16 gaps caught in self-audit. Most critical:

- Operator interviews were Phase 7 (after 24 tools were built); should be Phase 1.5 to drive Phase 2 design.
- The "skeptic" system prompt was unverified; needs a CI test harness.
- No reliability tier — Anthropic outage kills the widget for operators who'll come to depend on it.
- No measurable success criteria per phase.
- No size caps, denied-collection list, kill switch, or PII handling for logging.

This revision integrates all 16 findings, restructures the phase order, and adds explicit acceptance gates.

---

## North-star principle

> **The agent is only as good as its tools, and the tools are only as good as the alignment between schema, operational reality, and what operators actually ask.**

The 2026-05-05 wax incident — Claude faithfully reporting the wrong inventory because the tool pointed at orphaned `WaxBatch` rather than operational `ReceivingLot` — is the design lesson behind every rule below.

---

## Architectural principles (11 non-negotiable rules)

Every future change must satisfy these. If a proposal violates one, the proposal — not the principle — gets revised.

1. **Source-of-truth tagging.** Every tool description states the model + filter it queries and whether that's the operational source of truth. When two tools could answer the same question, only one is the canonical answer; the other is labeled "legacy" / "secondary" with a non-removable warning that fires when used.
2. **Verifiable answers.** Every tool result returns `source` (one-line query description) and `sourceUrl` (route the operator can click to verify). UI renders both as clickable links.
3. **Data integrity surfacing.** Tools emit `dataIntegrityNotes[]` when the underlying data has known weaknesses (null FKs, stale denormalized counters, suspicious patterns). UI renders these as a yellow warning. The system prompt instructs Claude to surface them in plain language, never bury them.
4. **Cross-validation by default.** When two tools could disagree, the agent prefers the source-of-truth tool and explicitly notes the discrepancy if both are queried.
5. **Trust events, not counters.** Tools that aggregate from event tables (transactions, lots, runs) are preferred over tools reading pre-computed counters that drift.
6. **Permission-mirrored.** Tools respect the same `requirePermission` gates as the surfaces they expose. If a user can't access a page, they can't ask Ask BIMS to dump the same data.
7. **Cost-bounded.** Per-question tokens capped (`max_tokens=4096`), max iterations capped (`MAX_ITERATIONS=8`), expensive models gated, per-session budget warning at $1, Anthropic console hard cap as bedrock.
8. **Result-size capped.** Every aggregation tool enforces a size limit (default 50, max 500 rows). Truncation is explicit in the result (`{ ..., truncated: true, totalAvailable: N }`) so Claude can warn the user. Genealogy tools default to 50 cartridges per lot; if more, the user is asked to narrow.
9. **Denied collections.** A hard allowlist of which models tools may query. `User`, `Session`, `InviteToken`, `ElectronicSignature`, `Integration` (credentials) are **never** queryable through Ask BIMS regardless of tool design. Enforced in `runTool()` via a model-name whitelist.
10. **Cache-aware tool partitioning.** Tool descriptions are split into a stable "core" tier (fundamentals, rarely change) and an "evolving" tier (newer tools, may iterate). Cache breakpoints are placed between tiers so a description change in one tier doesn't invalidate the other's cache.
11. **Runtime kill-switch.** Every tool has a `disabled?` flag readable from env or a config table. The agent loop checks this before each call. Disabling a buggy tool requires no code deploy.

---

## Phase 0 — Foundation (shipped pre-2026-05-05)

Base agent loop, 11 tools, admin chat page, floating widget on every page (z-40, hidden on /login /logout /invite /cv), model toggle (Haiku 4.5 / Sonnet 4.6 / Opus 4.7 — last gated to admin:full), per-message + per-session cost display, $1 spend confirm.

---

## Phase 1 — Accuracy hardening (shipped 2026-05-05, commit `1f2a05e`)

- Wax tool migration: `list_wax_batches` → `get_wax_tube_inventory` (ReceivingLot, the operational truth) + `list_legacy_wax_batches` (auto-warns on use).
- Six-rule "ACCURACY DISCIPLINE" added to system prompt.
- All 12 tool descriptions rewritten with source/use-when/don't-use-for/caveat lines.
- All tool results return `source`, `sourceUrl`, `dataIntegrityNotes`.
- UI renders verify-source links and yellow integrity callouts on every tool call.

**Acceptance gate met:** ✅ — to be re-validated against Phase 1.5 test harness.

---

## Phase 1.5 — Test harness (NEW, blocking Phase 2)

**Why:** Phase 1's "skeptic prompt" is currently aspirational. Without a deliberate verification, every later phase compounds untested assumptions.

### Deliverables

- **Fixture-driven test suite** at `tests/ask-bims/` containing:
  - 25 hand-curated questions covering each domain
  - Expected answer characteristics (must mention X, must call tool Y, must surface integrity warning Z)
  - 5 "trap" questions where data is intentionally inconsistent (e.g., a wax inventory record with no consumption history despite recent production runs) — verifies skeptic prompt fires
  - 5 "ambiguous" questions where two tools could plausibly answer — verifies agent picks the right one per system prompt heuristics
- **Runner** at `scripts/test-ask-bims.ts` that:
  - Seeds a known fixture state in a test DB
  - Runs each question through `askBims()` with each model tier
  - Asserts on tool calls fired, integrity notes emitted, key phrases in answer
  - Reports cost-per-question for budget tracking
- **CI integration** — runs nightly, fails build on regression.

### Acceptance gate

- All 25 baseline questions pass
- All 5 trap questions trigger integrity warnings
- All 5 ambiguous questions select the documented "correct" tool
- Total CI cost per run < $1 (using Haiku for the suite)

---

## Phase 1.6 — Operator interviews (NEW, blocking Phase 2)

**Why:** Building 24 tools in Phase 2 before talking to operators means we ship tools nobody asks for and miss tools everyone wants. Move interviews ahead.

### Deliverables

- **Schedule 30-min sessions** with each operator role: wax tech, reagent tech, QC inspector, receiving lead, shipping coordinator, manufacturing manager. Minimum 6 interviews.
- **Capture top 50 questions** they'd want answered, organized by:
  - Frequency they'd ask it (daily / weekly / rarely)
  - What page they'd otherwise click through to
  - Time saved if Ask BIMS answered it directly
- **Validate Phase 2 tool list** against these questions. Every Phase 2 tool must trace to ≥1 interview question. Any question with no tool gets queued.
- **Output:** `docs/ask-bims-operator-questions.md` checked into repo.

### Acceptance gate

- 6+ interviews completed, 50+ questions captured
- Phase 2 tool plan published in roadmap with 1:1 mapping back to interview questions

---

## Phase 1.7 — Reliability tier (NEW, blocking Phase 2)

**Why:** Once operators come to rely on the widget, an Anthropic outage or rate-limit becomes a tier-2 issue. Today the UI just shows the raw error string. Need graceful degradation.

### Deliverables

- **Typed error handling** in `/api/agent/ask` for all Anthropic exception classes (`RateLimitError`, `AuthenticationError`, `APIConnectionError`, `InternalServerError`).
- **Exponential backoff retry** for 429s and 5xxs. Anthropic SDK has built-in retry (default `max_retries: 2`); explicit configuration to prove intent.
- **Status banner** in widget — when `/api/agent/ask` returns degraded status, show a small yellow banner: "Ask BIMS is temporarily unavailable — please use BIMS pages directly." Detected by 3 consecutive failures in 60 seconds.
- **Circuit breaker** — after 5 consecutive failures, the widget hides itself for 5 minutes rather than spamming Anthropic.
- **Health check endpoint** `/api/agent/health` returning `{ ok, lastTested, errorRate }` for observability.

### Acceptance gate

- Manual test: kill the API key, verify banner shows. Restore key, verify recovery.
- Manual test: rate-limit yourself by spamming, verify retry behavior.
- 5xx response from Anthropic doesn't crash the widget.

---

## Phase 2 — Operational coverage (interview-driven)

**Driven by Phase 1.6 output, not by my speculation.** The list below is a *proposal* derived from the audit; expect substantial revisions after interviews.

Goal: cover every domain identified in the audit so an operator can ask any question that maps to a BIMS page and get a grounded answer.

### Proposed tool additions, by domain

These map to the 84-model audit findings. Each must trace to ≥1 interview question to ship.

#### 2.1 Inventory + receiving
- `get_part_lot_history(partNumber)` — replaces unreliable `inventoryCount` for any part
- `list_receiving_inspections(sinceDays?)` — recent CoC/IP outcomes
- `inventory_transactions_for_lot(lotId)` — every consumption event for a lot
- `inventory_consumption_rate(partNumber, days)` — velocity for runway calc

#### 2.2 Manufacturing — full run telemetry
- `get_run_details(runId)` — full record including operator, robot, deck, planned/actual carts, abort reasons, notes
- `list_active_runs()` — runs in non-terminal status across all process types
- `list_workflow_violations(sinceDays?)` — SOP deviations
- `list_wi01_runs(sinceHours?)` — backing oven LotRecord (currently invisible to Ask BIMS)
- `list_laser_cut_batches(sinceHours?)` — substrate cutting (currently invisible)

#### 2.3 Cartridge admin
- `list_cartridges_in_storage(fridgeId?)` — inventory in `wax_stored` status by fridge
- `list_voided_cartridges(sinceDays?)` — voided records with reasons
- `cartridge_throughput(sinceDays)` — counts by phase per day

#### 2.4 QC + validation
- `list_validation_sessions(spuId?, type?, sinceDays?)` — SPU validation runs
- `list_calibrations_due(equipmentType?)` — proactive calibration list
- `list_open_approval_requests()` — pending scrap/deviation approvals

#### 2.5 Equipment + sensors
- `get_temperature_history(equipmentName, sinceHours)` — time-series for a sensor
- `list_open_service_tickets(equipmentType?)`
- `equipment_uptime(equipmentName, sinceDays)` — % time within range

#### 2.6 Documents + training
- `find_work_instruction(query)` — locate WI by number/name
- `get_user_training(username)` — training history (admin-gated)
- `list_recent_document_changes(sinceDays)` — controlled-doc revision activity

#### 2.7 Shipping + customers
- `list_open_shipping_lots()`
- `find_shipping_package(trackingNumber)`
- `cartridges_per_customer(customerName, sinceDays)` — admin-gated PII

#### 2.8 Audit + activity
- `recent_audit_events(tableName?, recordId?, sinceHours?)` — admin-only
- `recent_device_crashes(sinceHours?)`
- `recent_scanner_events(sinceMinutes?)` — for "scanner isn't working" debugging

### Reuse before building

The audit identified `src/lib/server/analytics/runs-feed.ts` and `src/lib/server/analytics/stats.ts` already encode operationally meaningful aggregations. **Every Phase 2 tool that overlaps with these must wrap the existing function rather than re-aggregate.** Reduces drift and duplicated logic.

### Acceptance gate

- Every Phase 2 tool maps to ≥1 interview question from Phase 1.6
- Every tool has source/sourceUrl/integrity-notes wiring
- Every tool has at least one fixture in the Phase 1.5 test harness
- Median per-question cost on Sonnet 4.6 ≤ $0.025
- "Verify in BIMS" link CTR > 10% in the first 30 days post-launch (telemetry)

---

## Phase 3 — Cross-model intelligence

Genealogy + traceability tools that walk multi-hop FK relationships.

### Tools

- **`forward_genealogy(receivingLotId)`** — given a ReceivingLot, list every cartridge that consumed material from it. Recall enabler. Default cap 50 carts; truncate with `{ truncated: true, totalAvailable }`.
- **`backward_genealogy(cartridgeId)`** — full lineage across every input lot, run, robot, operator, QC, storage, reagent, shipment. Supersedes `trace_cartridge`.
- **`run_yield_trend(robotName, sinceDays)`** — yield over time per robot
- **`scrap_pareto(sinceDays)`** — rank scrap reasons (uses `WorkflowViolation` + `CartridgeRecord.waxQc.notes`)
- **`assay_lot_cross_reference(assayName, sinceDays)`** — assay → reagent batches → shipments

### Health check meta-tool

- **`check_data_integrity()`** — counts known anomalies (null waxSourceLot, over-consumed lots, stuck cartridges, stale equipment reads). When the agent calls this and finds anomalies, it pre-empts the user: "Before I answer, I noticed N data integrity issues that may affect this answer."

### Acceptance gate

- Forward genealogy on a known lot returns expected cart list (verified manually)
- All multi-hop tools enforce result-size caps
- check_data_integrity emits zero false positives on a freshly seeded test DB

---

## Phase 4 — Time-series & trends

Wraps existing analytics modules. Every tool here is a thin wrapper over `runs-feed.ts` or `stats.ts` per principle 5.

- `temperature_excursion_summary(equipmentName, sinceDays)` — minutes out-of-spec, alert count, longest excursion
- `production_throughput(processType, sinceDays, granularity)` — daily/weekly cart counts
- `inventory_burn_rate(partNumber, sinceDays)` — units/day consumed
- `alert_frequency_by_equipment(sinceDays)` — noisy-sensor ranking
- `defect_rate_by_robot(sinceDays)` — yield comparison across OT-2s

### SPC integration

- `list_recent_spc_signals(processType?, sinceDays?)` — Nelson rule violations
- `get_spec_limits(processType, metric)`
- `fmea_for_process(processType)` — failure modes ranked by RPN

### Acceptance gate

- Each tool maps 1:1 to a function in `analytics/runs-feed.ts` or `analytics/stats.ts`
- No new aggregation logic — only thin wrappers + annotation

---

## Phase 5 — Predictive & workflow-aware

- **`runway(partNumber)`** — projected days to stockout based on rolling consumption
- **`calibrations_due(daysAhead)`** — equipment with `nextCalibrationDue` in window
- **`whats_blocking_run(runId)`** — diagnostic across deck/tray/wax-source/QC
- **`next_runs_to_qc()`** — wax runs in `Awaiting Removal` or `QC` with cart counts
- **`shipment_readiness(customerName?)`** — open shipping lots with QA/QC release status

### Acceptance gate

- `runway` projection within ±15% of manual calculation on a test fixture
- `whats_blocking_run` correctly identifies blocker type for 5 known scenarios

---

## Phase 6 — Compliance & governance

### 6.1 Conversation logging

- Persist Q&A pairs to `AgentQuery` (model already exists): user, question, model, tools called, answer, cost, timestamp
- Admin page at `/admin/ask-bims/history` for review
- **Retention: 90 days** (was 1 year; reduced after PII review — see 6.4)
- **PII redaction at log time**: user-typed names, emails, phone numbers regex-stripped before persistence. Redact: `[A-Za-z]+ [A-Za-z]+` (proper-noun pairs), `\S+@\S+`, US phone formats. Keep: lot numbers, run IDs, part numbers.
- Admin can opt to view raw (un-redacted) logs with a confirm dialog and audit-log entry recording who viewed what.

### 6.2 Permission-aware tools

- Every tool checks calling user's permissions via `hasPermission()`
- System prompt is augmented at request time with the user's permission set so the agent doesn't propose tools the user can't use
- Tools that read regulated docs (`Document`, `WorkInstruction`, `User.trainingRecords`) are gated to the same roles that can view them in the UI

### 6.3 Per-tool cost cap (NEW)

- `max_iterations` enforced per question (already 8). On Opus 4.7, additionally cap accumulated cost at $5 per question; if exceeded, abort with a clear message.
- Per-day cap per user: $10/day on Opus, $2/day on Sonnet, no cap on Haiku. Soft cap with override prompt; hard cap at 5× soft cap.

### 6.4 Denied collections (formalization)

Hard allowlist enforced in `runTool()`:
- `User`, `Session`, `InviteToken` — never queryable
- `ElectronicSignature` — never queryable (legal artifact)
- `Integration` — never queryable (contains access tokens)
- `Spu.particleLink` — never returned (device credentials)
- All other models — queryable with permission gate

### Acceptance gate

- AgentQuery records exist for every chat session
- PII redaction unit-tested on 20 sample inputs (proper nouns, emails, phones)
- Attempt to call a denied-collection tool returns a clear error
- Per-day cap manually triggered and verified

---

## Phase 7 — Operator training (scoped down)

Original training-mode plan was too thin. Reduced to two concrete deliverables.

### 7.1 Contextual help

- Floating widget gets a "What can I ask on this page?" affordance
- Server-side, the API knows the current page (via `Referer` or explicit `pageContext` param) and returns 3-5 example questions tailored to that page's data
- E.g., on `/manufacturing/wax-filling`: "How many runs today?", "What's the temp of the cooling tray?", "Trace the carts from the active run"

### 7.2 Operator one-pager

A single markdown doc at `docs/ask-bims-operator-guide.md`:
- 10 example questions that work well, with screenshots
- 5 examples of what NOT to ask (and why — e.g., "Don't ask Ask BIMS to make decisions")
- How to read the cost line and integrity warnings
- Who to escalate to when an answer looks wrong

### Acceptance gate

- Contextual help button visible on 5 representative pages
- Operator guide doc reviewed by ≥1 non-engineer operator before publishing

### What got dropped

- "Training mode" toggle as previously specified — too thin without curated content. Revisit only if interviews surface real demand.

---

## Phase 8 — Self-healing & anomaly detection

### 8.1 Daily integrity health monitor

- Vercel Cron runs `check_data_integrity()` daily, writes anomalies to a new `BimsAnomaly` collection
- Admin dashboard at `/admin/ask-bims/anomalies` surfaces the list
- Examples flagged: null waxSourceLot runs, ReceivingLots with `consumedUl > quantity * 12000`, equipment with `lastTemperatureReadAt > 4 hours` old, cartridges stuck in non-terminal status > 7 days

### 8.2 Conversation feedback loop

- Thumbs-up/thumbs-down per answer (NEW: should ship in Phase 1, not Phase 8 — see correction below)
- Tagged answers stored in `AgentQuery.feedback`
- Weekly review: patterns of "wrong" feedback drive tool refinements

### 8.3 Tool deprecation pipeline

- Every tool has `version` (semver) and `lastValidated` (date)
- Quarterly review: any tool not validated in 90 days runs through smoke test
- Failures flag the tool for fixing or deprecation
- Deprecated tools get a description rewrite to "DO NOT USE — being replaced by X" rather than silent breakage

### Acceptance gate

- Cron job lands rows in `BimsAnomaly` daily
- Thumbs feedback persists and is admin-viewable
- One smoke-test cycle has been run end-to-end

---

## Correction: what should move earlier

After writing this revision, two items belong earlier than originally placed:

- **Thumbs-up/down feedback (was Phase 8.2) → Phase 1.7.** Operators' subjective signal is the cheapest source of "Phase 1 is working" data. Should ship before Phase 2.
- **Mobile UX consideration → Phase 1.7.** Floating widget on a 375px phone screen is unusable as currently sized. Phase 1.7 should add a mobile-specific expansion mode (full bottom-sheet on screens < 600px wide).

These are folded into the Phase 1.7 deliverables list above.

---

## Tool selection logic (NEW SECTION — supports principle #4)

The agent picks tools via the system prompt. Empirical risks:

| Risk | Symptom | Mitigation |
|---|---|---|
| Picks the wrong tool when 2+ could answer | "Show carts from run X" → calls `get_run_yield` instead of `find_cartridges(runId)` | Explicit decision-tree in system prompt; disambiguating examples in tool descriptions |
| Calls 5 tools when 1 would do | "How many carts today?" triggers `find_cartridges` + `count_cartridges_by_status` + `list_recent_runs` | "Use the minimum number of tools needed" instruction; tool descriptions warn against redundant pairings |
| Tries to answer from training data without calling a tool | "Is the cartridge oven on?" → "Yes, ovens are typically on" with no Equipment query | Reinforced "Never guess; always check" in system prompt |
| Calls tool with unhelpful broad parameters | `find_cartridges()` with no filter → returns 500 carts, blowing context | Mandatory parameters + result-size caps |

### System prompt — TOOL SELECTION HEURISTICS section

Added in Phase 1 revision (this commit). Provides:
- Decision tree: "If user asks X, prefer tool Y, not Z"
- Anti-overlap warnings: "If you already called X for this entity, don't also call Y — use Z directly when you need Y's information"
- Minimum-tools rule: "Pick the smallest set of tools that gets a complete answer. Each extra call adds latency, cost, and noise."
- Anti-guessing rule: "Never answer from prior knowledge if a tool could verify. If the user asks about specific BIMS data, use a tool. If no tool can answer, say so."

---

## Cost projections (refined)

### Per-question cost, warm cache

| Phase | Sonnet 4.6 | Haiku 4.5 | Opus 4.7 |
|---|---|---|---|
| 1 (today, sub-cache threshold) | $0.013 | $0.004 | $0.060 |
| 1 (after this revision, ~2.5K prefix, cache active) | ~$0.011 | ~$0.004 | ~$0.055 |
| 2 (~36 tools) | ~$0.014 | ~$0.005 | ~$0.065 |
| 4 (~52 tools) | ~$0.016 | ~$0.005 | ~$0.075 |
| 8 (~62 tools) | ~$0.018 | ~$0.006 | ~$0.085 |

Caching activates at ~2K prefix tokens on Sonnet — this revision crosses that threshold, so per-question cost actually decreases vs. Phase 1 once a session is warm.

### Monthly projections, mixed-tier usage

| Usage | Phase 1 | Phase 2 | Phase 4 | Phase 8 |
|---|---|---|---|---|
| Light (50 q/day, 22 days) | $15 | $20 | $25 | $30 |
| Medium (150 q/day) | $50 | $65 | $80 | $100 |
| Heavy (300 q/day, 10% Opus) | $130 | $170 | $200 | $250 |

### Recommended hard caps

- Anthropic console spend cap: **$100/mo** (covers full buildout at heavy use)
- Per-user per-day cap on Opus: $10
- Per-question cap on Opus: $5
- All caps configurable via env vars

---

## Risks & mitigations (revised)

| Risk | Mitigation |
|---|---|
| Tool description bloat blows the cache budget | Cache-aware partitioning (principle #10), monitor `cache_creation_input_tokens` vs `cache_read_input_tokens`. If cache hit rate drops below 70%, restructure descriptions. |
| Schema migrations break tools silently | Phase 1.5 test harness runs nightly; Phase 8.3 deprecation pipeline runs quarterly. |
| Operators trust answers blindly | Source URLs + integrity notes are always visible. Phase 7.2 operator guide emphasizes "starting point, not final word." Thumbs feedback (1.7) drives correction loop. |
| Cost runs away on Opus | Admin-gated, per-question cap ($5), per-user-per-day cap ($10), Anthropic console hard cap ($100/mo). Four layers of defense. |
| Anthropic outage hides BIMS data | Phase 1.7 reliability tier — retry, banner, circuit breaker, health endpoint. |
| PII leaks into conversation logs | Phase 6.1 redaction at log time; 90-day retention; admin-only raw access with audit. |
| Tool ships with a bug; can't be disabled fast | Principle #11 — runtime kill-switch via env var. No deploy needed. |
| Permissions drift | Reuse existing `requirePermission` gates throughout — no parallel auth system. |
| Long conversations overflow context window | Already capped at 8 iterations × 4096 tokens. Phase 4+ adds explicit conversation-length soft warning at 30K cumulative tokens. |
| Wrong tool picked despite system prompt | Phase 1.5 test harness includes 5 ambiguous-question fixtures specifically to catch this. Iterate on tool descriptions until pass rate ≥ 95%. |
| Operators ask the same question repeatedly | Phase 4+ could add response caching (5-min TTL) for identical question + same data fingerprint. Defer until proven needed. |

---

## Acceptance gates summary

| Phase | Gate | Status |
|---|---|---|
| 0 | Foundation deployed | ✅ shipped |
| 1 | Wax fix + skeptic prompt + verify links + integrity notes | ✅ shipped, awaits 1.5 verification |
| 1.5 | 25 baseline + 5 trap + 5 ambiguous tests pass; CI integrated | ⏳ blocking 2 |
| 1.6 | 6+ interviews, 50+ questions, Phase 2 tool list mapped | ⏳ blocking 2 |
| 1.7 | Reliability tier verified; thumbs feedback live; mobile mode | ⏳ blocking 2 |
| 2 | Every tool maps to interview Q; cost target met; "verify" CTR > 10% | scoped |
| 3 | Forward/backward genealogy verified; size caps enforced | scoped |
| 4 | Each tool wraps existing analytics; no duplicate logic | scoped |
| 5 | Runway accuracy ±15%; whats_blocking correctness ≥80% | scoped |
| 6 | AgentQuery logging + PII redaction + denied-collections enforcement | scoped |
| 7 | Contextual help on 5 pages; operator guide reviewed by 1 operator | scoped |
| 8 | Daily anomaly cron; thumbs review pipeline; quarterly tool smoke test | scoped |

---

## What I need from you to proceed

In strict order — each unblocks the next:

1. **Approve Phase 1.5 / 1.6 / 1.7** as the next work block. Estimate: 4-7 days for me, plus your time on interviews.
2. **Commit to operator interview slots** — minimum 6 sessions. I can prepare the question set.
3. **Confirm the denied-collections list (principle #9)** — anything else you want explicitly off-limits?
4. **Set Anthropic console hard cap** to $100/mo if not already. Bedrock guardrail.
5. **Phase 1 testing feedback** — once you hit it on the deployed widget, tell me what's right/wrong. Drives Phase 1.5 fixture design.

Once 1.5/1.6/1.7 ship, Phase 2 starts with a tool list derived from interviews, not speculation.
