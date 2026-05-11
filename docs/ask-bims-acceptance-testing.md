# Ask BIMS — Acceptance Testing Script

**Goal:** Walk top-to-bottom and verify every tool the May 7 branch (`feat/ask-bims-markdown-context`) added or touched. Each question is something you actually type into the Ask BIMS widget. Each entry tells you what to expect and what a failure looks like.

**Prereqs**
- Branch pushed and Vercel preview built (see step 1 of the next-step plan).
- You're logged in as an admin user (some tools are admin-gated).
- Two browser tabs: one for the widget, one for `/admin/ask-bims/cost` so you can watch token usage in real time.

**How to grade an answer**
- ✅ Pass if the answer cites the expected source, returns sane data, and surfaces any integrity warnings.
- ⚠️ Investigate if the answer is plausible but missing a citation, integrity note, or source URL.
- ❌ Fail if the answer is wrong, the wrong tool fired, or the agent answered from training data without calling a tool.

---

## Section 0 — Smoke tests before anything else

| # | Question | Pass criteria |
|---|---|---|
| 0.1 | `hello` | One-line greeting, zero tool calls. Confirms the widget is wired and the system prompt is loaded. |
| 0.2 | `what can you do?` | Short list of capabilities. Zero tool calls. |
| 0.3 | `what's the temperature of nothing` | Agent should either ask for an equipment name or say it doesn't know. **Should NOT** hallucinate a number. |

If any of these fail, stop and check the API key + Anthropic console.

---

## Section 1 — Phase A: inline TIER 1 reference + caching

**What to check on the cost dashboard before/after each question:** the *first* question in a fresh session should show `cacheWrite` tokens > 0 (the agent paid to write the cache). The *second and third* should show `cacheRead` tokens > 0 (it read the cache cheap). If you see all-writes-no-reads, caching is broken.

| # | Question | Expected | What to look for |
|---|---|---|---|
| 1.1 | `Why can't I edit a finalized cartridge record?` | No tool calls — answered from TIER 1. | Answer cites "Per DATA-REFERENCE §1" or mentions sacred / postFinalizeWritable: ['analysis','corrections']. |
| 1.2 | `Which collections are immutable?` | No tool calls. | Lists at least audit_log, electronic_signatures, inventory_transactions, manufacturing_material_transactions. |
| 1.3 | `Is the FREEZE-02 enforcement live?` | No tool calls. | Answer says "no — Lambda doesn't yet stamp finalizedAt", cites §4 integrity gap #4. |
| 1.4 | `What's the difference between PartDefinition.inventoryCount and the receiving lots?` | No tool calls (or one verification tool). | Mentions counter drift, points to receiving_lots as source of truth. Cites §4 gap #5. |
| 1.5 | Ask question 1.1 again in the same chat. | No tool calls, identical concept answer. | Watch the cost dashboard — should be all `cacheRead`, near-zero `cacheWrite`. |

**Failure modes to flag**
- If `cacheWrite` is non-zero on questions 1.2–1.5, the cache is invalidating between calls.
- If 1.3 says "FREEZE-02 is live", the TIER 1 file isn't being passed to Claude.

---

## Section 2 — Phase B: `search_documentation`

| # | Question | Expected tool | Pass criteria |
|---|---|---|---|
| 2.1 | `What recent manufacturing fixes did we deploy?` | `search_documentation` | Returns hits from `AUDIT-CHECK-SUMMARY.md` with file:line citations. |
| 2.2 | `How does the magnetometer system work?` | `search_documentation` | Returns hits from `magnetometer-system-overview.md`. |
| 2.3 | `Tell me about wax filling validation` | `search_documentation` | Returns multiple files. Snippets are ≤200 chars. |
| 2.4 | `xy` (intentionally too short) | None | Tool refuses — query under 3 chars. Agent should NOT call it. |
| 2.5 | `What's in our PRD for particle-driven testing?` | None or refusal | **Critical:** allowlist should EXCLUDE `docs/prds/`. If a PRD shows up, the allowlist is broken. |
| 2.6 | `What did the session handoff say last week?` | None or refusal | Same — session/handoff docs are excluded. |

---

## Section 3 — Phase C: `search_work_instructions`

| # | Question | Expected tool | Pass criteria |
|---|---|---|---|
| 3.1 | `What does WI-01 step 2 require?` | `search_work_instructions` | Cites "Per WI-01 (v<N>, effective YYYY-MM-DD) step 2". sourceUrl is `/spu/work-instructions/...`. |
| 3.2 | `Which work instructions use part PT-CT-114?` | `search_work_instructions` with `partNumber: 'PT-CT-114'` | Returns WIs whose steps require that part. |
| 3.3 | `Show me the backing procedure` | `search_work_instructions` | Returns WI-01 (or similarly-named). |
| 3.4 | `Find a step about scanning a barcode` | `search_work_instructions` | Returns matching steps with `requiresScan: true`. |
| 3.5 | `Tell me about the wax filling SOP` | `search_work_instructions` | Returns the right WI. Don't accept generic answers without a doc number. |

---

## Section 4 — Phase D: `lookup_equipment_datasheet`

| # | Question | Expected tool | Pass criteria |
|---|---|---|---|
| 4.1 | `What's the model number of the cartridge oven?` | `lookup_equipment_datasheet` | Returns a CSV row. Cites the source CSV filename. |
| 4.2 | `Find specs for the CLIA freezer` | `lookup_equipment_datasheet` | Either returns a hit or says "no match in BT.csv or Fannin.csv". Should NOT make up specs. |
| 4.3 | `Show me datasheets for the centrifuge` | `lookup_equipment_datasheet` | Returns up to 10 results from either CSV. |
| 4.4 | `What temperature can fridge B-01 hold?` | `lookup_equipment_datasheet` | Returns the row; should explicitly call out which CSV (BT vs Fannin) it came from. |

**Note:** PDFs are out of scope — if the agent tries to read a PDF, that's a regression.

---

## Section 5 — Phase E1: research experiments + cartridges

| # | Question | Expected tool | Pass criteria |
|---|---|---|---|
| 5.1 | `List recent experiments` | `list_experiments` | Returns experiments with arm/cartridge counts. |
| 5.2 | `Find experiment <real-experiment-name>` | `find_experiment` | Returns the experiment with arm summaries. Use a real name from research-v2. |
| 5.3 | `What cartridges are in arm 0 of experiment X?` | `get_experiment_arm_cartridges` | Joins to CartridgeRecord. **Watch for** a `dataIntegrityNotes` warning if any cart still has the legacy `currentPhase` field. |
| 5.4 | `Look up research cartridge <UUID>` | `find_research_cartridge` | Returns research-side projection (rawData, readouts, result, analysis). Surfaces FREEZE-02 warning if status=completed but finalizedAt is null. |
| 5.5 | `Look up cartridge <UUID>` (same UUID) | `trace_cartridge` OR `find_research_cartridge` | Either is fine, but answer should NOT call BOTH for the same cart. |

---

## Section 6 — Phase E2: reagent catalog + inventory

| # | Question | Expected tool | Pass criteria |
|---|---|---|---|
| 6.1 | `What reagent types do we have?` | `list_reagent_catalog` | Returns catalogs with variant counts. ~76 total per current Mongo state. |
| 6.2 | `Show me prepared reagents only` | `list_reagent_catalog` with `type: 'prepared'` | Filters to prepared. ~48 of them. |
| 6.3 | `Find the catalog for <reagent name>` | `find_reagent_catalog` | Returns full variants[] array. Variant `parameterValues` are immutable per DOMAIN-26. |
| 6.4 | `List active reagent inventory` | `list_reagent_inventory` | Returns items with status=active. ~324 total. |
| 6.5 | `Find inventory <UUID barcode>` | `find_reagent_inventory` | Returns the item joined to its catalog variant. |
| 6.6 | `How much do we have of catalog X?` (NO variant) | `list_reagent_inventory` or `count_inventory_by_variant` | **Critical:** if `list_reagent_inventory` is called with catalogId but no variantKey, the result MUST include a `dataIntegrityNotes` warning about pooling variants. |

---

## Section 7 — Phase E3: protocols

| # | Question | Expected tool | Pass criteria |
|---|---|---|---|
| 7.1 | `List active protocols` | `list_protocols` | Returns protocols with cellMapKeyCount per row. **Watch for** integrity note about empty-cellMap protocols. |
| 7.2 | `Find protocol <name>` | `find_protocol` | Returns the protocol. If cellMap is empty, integrity note cites `docs/protocol-extraction-cellmap-bug.md`. |
| 7.3 | `Show recent protocol executions` | `list_protocol_executions` | Returns executions with primaryOutputBarcode. |
| 7.4 | `Get details for execution <id>` | `get_protocol_execution_details` | Returns parameter values, materialsUsed, outputs[]. Multi-aliquot supported. |

---

## Section 8 — Phase E4: `trace_reagent_chain` (the grail)

| # | Question | Expected tool | Pass criteria |
|---|---|---|---|
| 8.1 | `Trace the reagent chain for cartridge <UUID>` | `trace_reagent_chain` | Returns a tree of executions + inventory + stock items. |
| 8.2 | Same question on a cart with no reagentChain[] populated | `trace_reagent_chain` | Returns gracefully with `dataIntegrityNotes` saying the chain is empty (per integrity gap #3). **Should NOT crash.** |
| 8.3 | `Trace cart <UUID> with depth 12` | `trace_reagent_chain` with `maxDepth: 12` | Respects the cap. If hit, `depthCapped: true` on affected leaves. |
| 8.4 | Cycle test (if you have one) | — | If a protocol execution references itself, walker terminates with `repeated: true` rather than looping. Probably no real-data case; skip if no cycle exists. |

---

## Section 9 — Phase E5: samples, analytes, analyses

| # | Question | Expected tool | Pass criteria |
|---|---|---|---|
| 9.1 | `List samples from experiment X` | `list_samples` | Returns samples joined to analytes. |
| 9.2 | `What analytes do we measure?` | `list_analytes` | Returns analytes with units, dynamicRange, lod, loq. |
| 9.3 | `Show analysis profiles` | `list_analysis_profiles` | Returns profiles with sumColumns / denominatorColumn / ratioNumerators. |
| 9.4 | `List calibrated analyses` | `list_calibrated_analyses` | Returns calibrated analyses with cartridge counts. |
| 9.5 | `Find calibrated analysis <id>` | `find_calibrated_analysis` | Returns the analysis with excludedChannels[] + tracer/bead barcodes. |

---

## Section 10 — Pre-existing tool regression (sanity)

The May 7 branch added 23 tools but should not have broken the 24 that were already there. Smoke-check each domain:

| # | Question | Expected tool | Note |
|---|---|---|---|
| 10.1 | `How much wax do we have in stock?` | `get_wax_tube_inventory` | **Critical:** must NOT call `list_legacy_wax_batches`. |
| 10.2 | `Any in-house wax production records?` | `list_legacy_wax_batches` | The ONE case where legacy tool is right. |
| 10.3 | `What's the temperature of the CLIA Freezer?` | `get_current_temperatures` | Not `list_equipment`. |
| 10.4 | `Any temperature alerts today?` | `get_temperature_alerts` | Not `get_current_temperatures`. |
| 10.5 | `Show runs from the last 24 hours` | `list_recent_runs` | Just one call. |
| 10.6 | `What runs aborted today?` | `list_recent_runs` with `status: 'aborted'` | Filter parameter used on first call, not after a "too much data" retry. |
| 10.7 | `How many cartridges did we make today?` | `count_cartridges_by_status` | Not `find_cartridges` + manual count. |
| 10.8 | `Look up part PT-CT-114` | `find_part` | Not `find_receiving_lot`. |
| 10.9 | `Look up lot 74b942a2-16a5-4ae4-aa91-917d3ecc146a` | `find_receiving_lot` | **Critical:** UUID must route here, NOT to `find_part` (Rule H). |
| 10.10 | `What parts are running low?` | `list_low_inventory_parts` | — |
| 10.11 | `Trace cartridge <real barcode>` | `trace_cartridge` | Direct call. No pre-call to `find_cartridges`. |
| 10.12 | `Yield on run <real runId>` | `get_run_yield` | One call. No `find_cartridges` chaser. |
| 10.13 | `What's blocking run <runId>?` | `whats_blocking_run` | — |
| 10.14 | `Forward genealogy for receiving lot <id>` | `forward_genealogy` | Returns up to 50 carts. If truncated, `totalAvailable` is set. |
| 10.15 | `Backward genealogy for cart <barcode>` | `backward_genealogy` | Full lineage tree. |
| 10.16 | `Check data integrity` | `check_data_integrity` | Returns anomaly counts. Meta-tool. |
| 10.17 | `Production throughput last 7 days` | `production_throughput` | — |
| 10.18 | `Inventory burn rate for PT-CT-114` | `inventory_burn_rate` | — |
| 10.19 | `When does PT-CT-114 run out?` | `runway` | Surfaces drift between PartDef.inventoryCount and receiving_lots. |

---

## Section 11 — Tool selection / anti-redundancy (Rules A–H)

These probe failure modes you've actually seen in prod.

| # | Question | Pass criteria |
|---|---|---|
| 11.1 | `Show carts from run <runId>` | Calls `find_cartridges` OR `get_run_yield` — **not both**. |
| 11.2 | `How many carts today, and what runs aborted?` | Calls `count_cartridges_by_status` + `list_recent_runs`. Two tools, no double-calls. |
| 11.3 | `What's going on?` | Picks 2–3 tools max (list_recent_runs + get_temperature_alerts + count_cartridges_by_status). NOT 5+. |
| 11.4 | `Is the cartridge oven on right now?` | Calls `get_current_temperatures`. **Must NOT** answer "ovens are usually on" without checking (Rule D, anti-guessing). |
| 11.5 | Ask `list_recent_runs` for "today" and then "this week" in the same turn | Should NOT call `list_recent_runs` twice. If first call returns nothing for today, agent should pass a wider window on its single call (Rule G). |
| 11.6 | `What's the inventory for that 74b942a2... lot?` | Routes to `find_receiving_lot`, not `find_part` (Rule H). |

---

## Section 12 — Citations + integrity surfacing

For every answer in Sections 5–9, scan for:
- ✅ A `source` line and a clickable `sourceUrl` in the widget.
- ✅ Any `dataIntegrityNotes` from the tool result are shown in the answer text (not buried).
- ✅ Citations follow the documented formats:
  - WI: "Per WI-XX (v<N>, effective YYYY-MM-DD) step <Y>"
  - TIER 1: "Per DATA-REFERENCE §X"
  - Other docs: "Per <filename.md>"

A common failure mode: the tool returns `dataIntegrityNotes` but the agent doesn't mention them. That's a Rule 3 violation.

---

## Section 13 — Cost + caps

| # | Action | Pass criteria |
|---|---|---|
| 13.1 | Open `/admin/ask-bims/cost` after running the test suite | Today's spend totals. Top users. Per-model breakdown. |
| 13.2 | Run a Sonnet question and confirm `cacheRead` > `cacheWrite` after the first | Cache is active. |
| 13.3 | Switch model to Opus and ask 3 questions | Each individually under $5 (per-question cap). Watch dashboard. |
| 13.4 | (Optional, careful) Lower `ASK_BIMS_DAILY_CAP_HAIKU_USD=0.01` via Vercel env, redeploy, ask a question | 429 with cap-denial message. Reset the env afterwards. |

---

## Section 14 — Reliability + error states

| # | Action | Pass criteria |
|---|---|---|
| 14.1 | Refresh the widget on a screen narrower than 600px (or DevTools mobile view) | Widget renders as a bottom-sheet, not a tiny corner pill. |
| 14.2 | Hit `/api/agent/ask/health` directly | Returns `{ ok: true, ... }`. |
| 14.3 | (Optional) Temporarily set `ASK_BIMS_DISABLED_TOOLS=trace_reagent_chain` via Vercel env | Tool is filtered out — agent can't call it. Restore env after. |
| 14.4 | (Risky — skip unless intentional) Rotate the Anthropic key invalid for 30 seconds | Widget shows degraded banner, then recovers when key is restored. |

---

## What "all good" looks like at the end

- Sections 0–4 all green → Phase A/B/C/D shipped clean.
- Sections 5–9 all green (modulo expected empty `reagentChain[]` warnings) → Phase E1–E5 shipped clean.
- Section 10 all green → no regression on the 24 pre-existing tools.
- Section 11 all green → tool-selection heuristics are still holding.
- Section 12 all green → citations + integrity surfacing aren't silently broken.
- Section 13 shows cache reads dominating cache writes after the first question of a session → Phase A's whole point (cheaper warm requests) is real.

If anything in Section 1 (cache) fails, fix that first — the rest of the tests will misread cost numbers until caching works.

If anything in Section 11 (Rules A–H) fails, the system prompt is drifting and we need to either tighten it or add fixtures to `tests/ask-bims/baseline.ts`.

---

## After this script: what to feed back

Three things make the next iteration sharper:

1. **A short list of which questions failed and how.** Doesn't need to be polished — copy-paste of the answer is fine.
2. **Any question the agent answered correctly but in a confusing way** — bad formatting, missing source, wrong tone.
3. **Any question NOT on this list that you tried to ask and it failed on.** Those are the gold — real operator questions are how the next phase's tool list gets built (Phase 1.6 in the roadmap).
