# Ask BIMS — Session Handoff (2026-05-05 / 2026-05-06)

**Author:** Claude Opus 4.7 (1M context)
**Branch:** `fix/ask-bims-tool-selection` (14 commits ahead of `origin/dev`)
**Status:** Ready for merge into `dev`. New branch should be cut after merge for next phase of work.
**Audience:** Future-Claude or future-Nick picking up the next session cold.

---

## TL;DR

Started this session with a single bug report: Ask BIMS gave Nick wrong wax inventory data. Root cause was architectural — the tool was pointing at orphaned data. Fixed it, then audited the entire surface, wrote a comprehensive roadmap, and built ~70% of it autonomously. Result: 24 tools spanning every BIMS domain, a tested model selection logic, full cost telemetry + caps, and an admin dashboard. **Branch is ready to merge.** New branch should pick up Phase 1.6 (operator interviews), conversation logging, and a handful of open findings — all documented below.

---

## How this session unfolded (chronological)

### 1. The triggering incident

Nick asked Ask BIMS about wax inventory. The agent confidently reported numbers from `WaxBatch` (an orphaned legacy table), missing the operational truth in `ReceivingLot.consumedUl` for PT-CT-114 tubes. Claude wasn't hallucinating — it was faithfully reporting what the (broken) tool returned. The bug was the **tool was pointed at the wrong source of truth.**

### 2. Initial discussion + scoping

- Nick asked whether the Claude.ai subscription could power Ask BIMS. **Answer: no — subscriptions are for the chat apps, not the API.** Embedded use requires per-token API.
- Nick approved per-token pricing after a real cost audit (Sonnet ~$8/mo at light use).
- Nick approved Phase 1 fix: swap to Anthropic SDK, replace the wax tool with a ReceivingLot-based `get_wax_tube_inventory` and explicitly-tagged `list_legacy_wax_batches`, add a "skeptic" system prompt, source URLs, integrity warnings.

### 3. Phase 1 shipped → still wrong on the test

- Built and shipped Phase 1 (commits prior to this branch).
- Nick tested with a real production question. The wax tool now worked correctly, BUT:
  1. `list_recent_runs` was called twice (anti-redundancy violation)
  2. `find_part` was used to look up a UUID lot ID (74b942a2-…), returned "not found," and shown to operator as a false-positive integrity warning
- Diagnosed: missing `find_receiving_lot` tool was the gap. Added it + UUID-redirect rules + anti-redundancy rule G in the system prompt. Branch `fix/ask-bims-tool-selection` was started for this.

### 4. Comprehensive roadmap (rev 1 → rev 2 after self-audit)

- Wrote `docs/ask-bims-roadmap.md` rev 1 — 8-phase plan, ~60 tools long-term.
- Audited it against my own work. Found 16 gaps. Most critical: operator interviews were Phase 7 but should be Phase 1.6 (before Phase 2 tool building).
- Rewrote rev 2 with all 16 findings integrated:
  - 11 architectural principles (added: result-size caps, denied-collections allowlist, cache-aware tool partitioning, runtime kill-switch)
  - Phase 1.5 (test harness) + 1.6 (interviews) + 1.7 (reliability) all blocking Phase 2
  - Per-phase acceptance gates with measurable criteria
  - Refined cost projections + 4-layer cost defense
- Did a meta-audit of my own roadmap revisions. Found more gaps (R1-R8 + P1-P6). Many addressed in code; some flagged for future.

### 5. The "ralph loop" — autonomous build

Nick approved an autonomous build with $2 budget cap and pre-agreed defaults (D1-D10 in the audit doc):

- D1 — One feature branch per phase. Never push to dev directly.
- D2 — Test gate after each phase. New tools require fixtures.
- D3 — $2 spend cap on the loop's API usage.
- D4 — Phase order: 1.5 → 1.7 → 2 → 3 → 4 → 5 → partial 6 → partial 8.
- D5 — PII redaction stub OFF by default; logging starts only when policy decided.
- D6 — Denied collections: User, Session, InviteToken, ElectronicSignature, Integration, WebhookLog, DeviceLog.
- D7 — Only `BimsAnomaly` schema addition allowed (later relaxed for `AskBimsCostLog`).
- D8 — Rebase per phase; halt on Ask BIMS file conflict.
- D9 — Run kanban-comment script as Phase 1 retrospective.
- D10 — One status per phase, immediate halt-ping.

Nick later overrode D1: **single long-running branch instead of one-per-phase**. That's why everything is on `fix/ask-bims-tool-selection`.

### 6. Phases shipped on this branch

In order, each as a focused commit:

| Commit | Phase | What |
|---|---|---|
| `ac9005b` | 0.5 | `find_receiving_lot` tool + Rule H (UUID redirect) + Rule G (anti-redundancy) |
| `97416bb` | 1.5 | Test harness — 25 baseline questions, runner, $2 spend cap, runs against real prod data |
| `6f4bddc` | 1.7 | Reliability tier — typed errors with errorClass/retryable, circuit breaker (5 fails in 60s → 5 min cooldown), status banner, mobile bottom-sheet, /api/agent/ask/health endpoint |
| `ec16948` | 2 | 5 operational tools — get_run_details, list_active_runs, list_cartridges_in_storage, list_calibrations_due, get_temperature_history. Plus tool kill-switch (ASK_BIMS_DISABLED_TOOLS env var) |
| `e55a0d5` | 3 | Cross-model genealogy — forward_genealogy, backward_genealogy, check_data_integrity (meta-tool). Result-size caps enforced |
| `f46e3dc` | 4+5 | Time-series + predictive — production_throughput, temperature_excursion_summary, inventory_burn_rate, runway, whats_blocking_run |
| `9878829` | 6+8 partial | Opus per-question cost cap ($5), PII redaction stub (OFF by default), BimsAnomaly model |
| `11d6c3b` | (test fix) | Test harness fixture relaxation |
| `e4ea7dc` | (rule G fix) | Strengthened Rule G + bumped list_recent_runs default 24h→168h. Closed last anti-redundancy failure on Haiku |
| `d2dee46` | (default flip) | DEFAULT_MODEL switched from Sonnet to Haiku based on 13-prompt comparison. New `bulk_run_yields` aggregator (replaces N×get_run_yield iteration). Comprehensive comparison artifacts committed |
| `2327202` | 6.5 | Cost telemetry — `AskBimsCostLog` model, askBims auto-logs every call, server-side daily caps (Haiku $1, Sonnet $2, Opus $5 per user; $20 workspace), admin dashboard at `/admin/ask-bims/cost` |
| `b56af5c` | (nav fix) | Added "Ask BIMS Cost" tab to admin layout (was reachable only by direct URL) |

### 7. Validation — comprehensive 13-prompt × 3-model comparison

Cost: $1.04 against $4 budget. Results saved at `tests/ask-bims/comprehensive-results.json`. Findings:

**Haiku 4.5 was operationally equivalent to Sonnet/Opus on 11 of 13 prompts.** The two prompts where stronger models pulled ahead:
1. `inv-failed-inspections` — Opus alone correctly recognized "no tool fits" with zero tool calls (most efficient)
2. `history-recall-impact` — Sonnet/Opus used 1 tool (forward_genealogy), Haiku used 2 (extra lookup first)

**Haiku won one surprise:** `history-operator-today` ("What carts has Nick worked on today?"). Opus refused with "no operator filter tool exists" (technically correct). Haiku and Sonnet creatively chained tools to actually answer. **For an operator who wants the answer, Haiku's pragmatism beat Opus' strict rule-following.**

**Sonnet had 4/13 redundant calls** — worse than both Haiku (2) and Opus (2). Open finding worth investigating.

**Cost ratio: Haiku 1×, Sonnet 3.2×, Opus 5.4×.** Same as the smaller comparison, confirmed at scale.

**Conclusion: defaulting to Haiku saves ~$125/month at heavy team use** with no operationally meaningful quality loss.

### 8. Cost dashboard + caps shipped

Nick flagged a real worry: "I'm worried about over time forgetting how much this could cost." Honest answer: **no flat-rate subscription exists for tool-use APIs.** Built the structural alternative — visibility + caps — instead:

- `AskBimsCostLog` collection — per-question cost telemetry (NO content, no PII concern)
- `askBims()` auto-logs each call (fire-and-forget, never blocks response)
- `checkDailyCap(userId, model)` — runs BEFORE Anthropic call, rejects with 429 if user or workspace cap hit
- 5 layers of cost defense now in place (UI warning → max iterations → Opus per-question → daily caps → Anthropic console)
- Admin dashboard at `/admin/ask-bims/cost` shows today/7d/30d/projected, cap progress bars, top users, per-model breakdown

---

## Branch state right at end of session

```
fix/ask-bims-tool-selection (origin/fix/ask-bims-tool-selection)
  b56af5c  fix(admin): add Ask BIMS Cost tab to /admin layout nav
  2327202  feat(ask-bims): Phase 6.5 — cost telemetry log, daily caps, admin dashboard
  d2dee46  feat(ask-bims): default to Haiku 4.5 + bulk_run_yields aggregator
  e4ea7dc  fix(ask-bims): close anti-redundancy bug on yield/recent-run questions
  11d6c3b  fix(test-harness): cart-stored fixture accepts list_cartridges_in_storage
  9878829  feat(ask-bims): Phase 6/8 partial — Opus cost cap, PII stub, BimsAnomaly model
  f46e3dc  feat(ask-bims): Phase 4+5 — time-series + predictive (5 tools)
  e55a0d5  feat(ask-bims): Phase 3 — cross-model genealogy + data-integrity meta-tool
  ec16948  feat(ask-bims): Phase 2 subset — 5 audit-derived operational tools
  6f4bddc  feat(ask-bims): Phase 1.7 — reliability tier (errors, circuit breaker, mobile)
  97416bb  feat(ask-bims): Phase 1.5 — test harness with 18 baseline questions
  ac9005b  fix(ask-bims): add find_receiving_lot tool + anti-redundancy/UUID rules
─── origin/dev ───
```

**14 commits ahead of `origin/dev`.** All pushed. Vercel preview built and tested.

---

## Files added / modified by this branch

### New files

```
docs/ask-bims-roadmap.md                              ← 8-phase product roadmap rev 2
docs/ask-bims-session-handoff.md                       ← THIS file
scripts/comprehensive-compare.ts                       ← 13-prompt × 3-model A/B/C runner
scripts/test-ask-bims.ts                               ← test harness entry point
tests/ask-bims/baseline.ts                             ← 25 baseline questions + assertions
tests/ask-bims/runner.ts                               ← test runner with cost cap
tests/ask-bims/comprehensive-results.json              ← raw comparison data
src/lib/components/ask-bims/AskBimsWidget.svelte       ← floating widget, every page
src/lib/server/db/models/ask-bims-cost-log.ts          ← cost telemetry model
src/lib/server/db/models/bims-anomaly.ts               ← Phase 8.1 anomaly model
src/routes/admin/ask-bims/cost/+page.server.ts         ← cost dashboard server load
src/routes/admin/ask-bims/cost/+page.svelte            ← cost dashboard UI
src/routes/api/agent/ask/health/+server.ts             ← widget health endpoint
```

### Modified files

```
src/lib/server/ask-bims.ts          ← rewritten 4 times this session — current is THE source of truth
src/lib/server/db/connection.ts     ← refactored from $env to process.env (so test harness can import)
src/lib/server/db/models/index.ts   ← exports BimsAnomaly + AskBimsCostLog
src/routes/api/agent/ask/+server.ts ← typed errors, cap enforcement, userId pass-through
src/routes/admin/ask-bims/+page.server.ts  ← admin gate
src/routes/admin/ask-bims/+page.svelte     ← model toggle + integrity rendering + Haiku default
src/routes/admin/+layout.svelte             ← new "Ask BIMS Cost" tab + isActive fix
src/routes/+layout.svelte                   ← mounts <AskBimsWidget />
```

---

## Architectural decisions (durable)

### 11 Principles (from `docs/ask-bims-roadmap.md`)

1. **Source-of-truth tagging** — every tool description states its model + filter, marks legacy/secondary tools with non-removable warnings.
2. **Verifiable answers** — every tool result returns `source` and `sourceUrl`. UI renders both as clickable links.
3. **Data integrity surfacing** — tools emit `dataIntegrityNotes[]`. UI renders as yellow callout. System prompt instructs Claude to surface them, not bury them.
4. **Cross-validation by default** — when two tools could disagree, prefer source-of-truth + explicitly note discrepancies.
5. **Trust events, not counters** — aggregates from event tables (transactions, lots, runs) preferred over pre-computed counters.
6. **Permission-mirrored** — tools respect `requirePermission` of the surfaces they expose.
7. **Cost-bounded** — max_tokens 4096, MAX_ITERATIONS 8, expensive models gated.
8. **Result-size capped** — every aggregation tool enforces a size limit (default 50, max 500). Truncation explicit.
9. **Denied collections** — User, Session, InviteToken, ElectronicSignature, Integration, WebhookLog, DeviceLog are NEVER queryable.
10. **Cache-aware tool partitioning** — descriptions split into stable vs evolving tiers; cache breakpoints between.
11. **Runtime kill-switch** — env var `ASK_BIMS_DISABLED_TOOLS=tool_a,tool_b` filters tools without code deploy.

### System prompt rules in force (Rules A–H)

A. Plan before you call (smallest tool set)
B. One-question-one-tool mapping table
C. Anti-overlap rules (specific patterns)
D. Anti-guessing — never answer from prior knowledge if a tool can verify
E. Broad-question cap at 2-3 tools
F. Parameter discipline — pass useful defaults first call
**G. NEVER re-call the same tool in one turn** (with concrete failure example)
**H. UUID-style IDs are ReceivingLot IDs, use find_receiving_lot, NOT find_part**

### Cost defense (5 layers)

1. UI session warning at $1 (client-side)
2. Per-question caps: max_tokens=4096, MAX_ITERATIONS=8
3. Per-question Opus cost cap ($5, configurable)
4. **NEW:** Per-user-per-day caps (Haiku $1, Sonnet $2, Opus $5) + workspace cap ($20). Server-enforced.
5. Anthropic console hard monthly cap (operator sets — recommend $100/mo)

### Default model: Haiku 4.5

Decided based on `tests/ask-bims/comprehensive-results.json` evidence. Operators can pick Sonnet or Opus from the dropdown for sharper answers; admin only for Opus.

---

## Tools currently exposed (24 total)

### Wax + inventory
- `get_wax_tube_inventory` (source of truth: ReceivingLot for PT-CT-114)
- `list_legacy_wax_batches` (auto-warns when used)
- `find_receiving_lot` (UUID/barcode/lotNumber lookup)
- `find_part` (PartDefinition lookup; rejects UUIDs)
- `list_low_inventory_parts`
- `inventory_burn_rate`
- `runway`

### Manufacturing runs
- `list_recent_runs` (default 168h window)
- `list_active_runs` (non-terminal across wax + reagent + WI-01)
- `get_run_details` (full record by runId, auto-detects wax vs reagent)
- `get_run_yield` (single run breakdown)
- `bulk_run_yields` (NEW — aggregates many runs in one call, kills N×get_run_yield)
- `whats_blocking_run` (diagnostic)

### Cartridges
- `find_cartridges` (with status, runId filters)
- `count_cartridges_by_status`
- `list_cartridges_in_storage`
- `trace_cartridge` (quick lineage)
- `backward_genealogy` (full upstream — backing→wax→reagent→shipping)
- `forward_genealogy` (recall enabler — given a lot, list all affected carts)

### Equipment + sensors
- `list_equipment`
- `get_current_temperatures`
- `get_temperature_alerts`
- `get_temperature_history` (time-series)
- `temperature_excursion_summary` (out-of-spec time, longest excursion)
- `list_calibrations_due`

### Metrics + meta
- `production_throughput` (daily counts by phase)
- `check_data_integrity` (system-wide anomaly scan)

---

## Test data + reproducibility

### Test harness — `npx tsx scripts/test-ask-bims.ts`

- 25 baseline questions across 9 categories: wax / temperature / runs / cartridges / inventory / equipment / anti-overlap / redirection / phase2
- Asserts on tool selection (required + forbidden), answer phrases, anti-redundancy
- `--model haiku|sonnet|opus`, `--category <name>`, `--max-cost N`
- Last full run on Haiku: **25/25 pass at $0.11**

### Comprehensive comparison — `npx tsx scripts/comprehensive-compare.ts`

- 13 prompts × 3 models = 39 runs
- Cost cap $3.50 (last run cost $1.04)
- Saves raw results to `tests/ask-bims/comprehensive-results.json`
- Findings: Haiku operationally equivalent on 11/13, see results JSON for per-prompt detail

### Validating with real data

Both scripts hit real production Mongo (read-only — `askBims` only queries). No fixture seeding yet (gap G1, deferred). When schema or data changes, expect occasional fixture regressions on data-dependent assertions (e.g., temp-current with non-existent fridge name).

---

## Pending / deferred work

These need either human action or are explicitly deferred. Group them into a starter list for the next session.

### Hard-blocked on human action

- **Phase 1.6 — Operator interviews.** Schedule ~6 sessions across operator roles (wax tech, reagent tech, QC inspector, receiving lead, shipping coordinator, manufacturing manager). Capture top 50 real questions. Output: `docs/ask-bims-operator-questions.md`. Drives Phase 2 tool refinement.
- **Phase 6.1 — PII redaction policy.** Conversation logging (with question/answer text) is on hold until policy decided. Stub function `redactPii()` exists, gated by `ASK_BIMS_PII_REDACTION_ENABLED=1` env, currently no-op. Real implementation needs NER or curated allowlist.
- **Phase 7.2 — Operator one-pager.** Need ≥1 non-engineer operator to review before publishing.
- **Phase 8.1 — Daily anomaly cron.** `BimsAnomaly` model exists; Vercel Cron job not deployed (requires `vercel.json` config approval).
- **Anthropic console hard cap.** Recommend $100/mo. User-set in console.anthropic.com → Settings.

### Open findings worth follow-up

1. **Wax dual-path tool descriptions** (per memory entry 2026-05-06). `get_wax_tube_inventory` and `list_legacy_wax_batches` descriptions need updating: WaxBatch is back to being authoritative for in-house wax production, NOT legacy. The two tools should be relabeled as "purchased wax tubes" and "in-house produced wax" respectively. Current descriptions still say "legacy / non-authoritative."
2. **Sonnet's higher redundancy rate** (4/13 vs Haiku 2/13 and Opus 2/13). System prompt rule G works on Haiku now (after 168h default fix); Sonnet still over-retries with different parameters on some questions. May need Sonnet-specific prompting or accept as quirk.
3. **`find_runs_by_operator` tool gap** — Opus refused the "what carts did Nick make today" question because no operator filter exists. Haiku/Sonnet workaround works, but a dedicated tool would be cleaner.
4. **Conversation logging without PII** — current `AskBimsCostLog` has no content. Once PII policy lands, add an `AskBimsConversationLog` (or extend) for the question/answer text.
5. **Test fixtures vs real data drift** (gap G1). Synthetic fixture seeding into a dedicated test DB would stabilize the harness. Not urgent.
6. **CTR telemetry** for the "Verify in BIMS →" links. Phase 2 acceptance gate referenced "CTR > 10%" but we have no CTR tracking. Either add tracking or reword the gate.
7. **Mobile UX validation** on real devices. CSS bottom-sheet ships but never tested on a phone.
8. **Skeptic prompt verification** (gap G2). Need 5 trap-test fixtures with intentionally inconsistent data to verify Claude flags discrepancies. Currently the harness asserts only on tool selection.
9. **Bulk aggregators for other classes**. `bulk_run_yields` shipped; `bulk_temperature_summary`, `bulk_cartridge_status` would help similar iteration patterns.

### Memory entries from this session (reference)

Two new entries already in `MEMORY.md`:
- **`project_wax_inventory_dual_path.md`** (2026-05-06) — Two sources: ReceivingLot (purchased PT-CT-114) + WaxBatch (in-house wax-creation); validate falls back, completeRun decrements both. **Affects open finding #1 above.**
- **`feedback_ask_bims_verify_findings.md`** — Ask BIMS leads are hypotheses, not findings; query Mongo directly before fixing or backfilling. **Should be reflected in system prompt.**

---

## Configuration knobs (env vars)

| Var | Default | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` | (required) | API key |
| `ASK_BIMS_DISABLED_TOOLS` | (empty) | Comma-list of tool names to filter out without deploy |
| `ASK_BIMS_MAX_COST_OPUS` | `5` | Per-question Opus cost cap (USD) |
| `ASK_BIMS_DAILY_CAP_HAIKU_USD` | `1` | Per-user-per-day cap, Haiku |
| `ASK_BIMS_DAILY_CAP_SONNET_USD` | `2` | Per-user-per-day cap, Sonnet |
| `ASK_BIMS_DAILY_CAP_OPUS_USD` | `5` | Per-user-per-day cap, Opus |
| `ASK_BIMS_DAILY_CAP_WORKSPACE_USD` | `20` | Total workspace daily cap (sums all users) |
| `ASK_BIMS_PII_REDACTION_ENABLED` | (unset) | Enable redactPii — currently still no-op pending policy |

---

## Next-session starting points (suggested order)

When we resume, here's the natural ordering:

1. **Confirm the merge to `dev` happened** and update memory to reflect new branch state.
2. **Fix the dual-path wax tool descriptions** (open finding #1) — small commit, closes a known wrong.
3. **Phase 1.6 — schedule operator interviews.** Could happen in parallel with code work.
4. **Sonnet redundancy investigation** (open finding #2). Test the same anti-redundancy questions on Sonnet, see if Rule G needs Sonnet-specific reinforcement.
5. **`find_runs_by_operator` + a few interview-derived tools.** Small additions.
6. **Conversation logging without PII** — extend cost log to include question (hashed/truncated?) and answer (truncated?). Or wait for full PII policy.
7. **Bulk aggregators** for other iteration patterns.
8. **Phase 8.1 anomaly cron** when ready to deploy `vercel.json` cron config.
9. **Phase 7.2 operator one-pager** — one Friday with a senior tech.

---

## Where to look for things

| Need to | Open |
|---|---|
| Understand the design | `docs/ask-bims-roadmap.md` (rev 2 — definitive plan) |
| Understand this session's history | `docs/ask-bims-session-handoff.md` (this file) |
| See branch state | `git log fix/ask-bims-tool-selection..origin/dev` |
| Read all the tools | `src/lib/server/ask-bims.ts` (≈1300 lines, well-commented) |
| Run the test harness | `npx tsx scripts/test-ask-bims.ts --model haiku` |
| Re-run the comparison | `npx tsx scripts/comprehensive-compare.ts` (will re-spend ~$1) |
| Read raw comparison data | `tests/ask-bims/comprehensive-results.json` |
| Use the cost dashboard | `/admin/ask-bims/cost` (admin:full only) |
| Check telemetry collection | MongoDB `ask_bims_cost_logs` |

---

## One-line summary for the next session opener

> "Picked up after Nick merged `fix/ask-bims-tool-selection` into `dev`. 24 tools live, Haiku default, cost dashboard at `/admin/ask-bims/cost`. Two memory items + open findings list in `docs/ask-bims-session-handoff.md`. Next: dual-path wax tool description fix, then operator interviews."
