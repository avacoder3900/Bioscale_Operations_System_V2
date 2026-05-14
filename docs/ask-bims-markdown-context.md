# Ask BIMS Markdown-Context Capability — Design

**Status:** Design proposal 2026-05-07. Selects a hybrid approach (inline TIER 1 + tool-based retrieval for TIER 2 + work-instruction model + equipment datasheet CSVs). 2-week implementation plan included.

## Executive summary

Ask BIMS currently queries only MongoDB collections (27 tools across 8 domains). The project contains 90+ markdown files in `docs/` representing institutional knowledge — PRDs, audit reports, manufacturing flow documentation, system design decisions, operational handoffs — that could significantly enhance the agent's ability to answer "why" and "what-did-we-decide" questions. This design proposes a phased, hybrid architecture: inline critical operational docs in the system prompt for fast access, retrieve less-critical docs via a `search_documentation` tool, expose `WorkInstruction` content via a dedicated tool, and read equipment datasheets from local CSV files. PRDs and speculative future docs are deliberately deferred until operator interviews (Phase 1.6) clarify what's operationally important.

---

## 1. Inventory of current markdown assets

### 1.1 TIER 1 — operational reference, MUST inline (~15KB)

| File | Purpose | Use cases | Risk of staleness |
|---|---|---|---|
| `docs/DATA-REFERENCE.md` | Sacred database: 53+ collections, tier system, immutability rules, all field mappings | Explains *why* a field is immutable, clarifies "which model is source of truth" questions, grounds data-integrity warnings | Low — core reference, rarely changes |
| `docs/MANUFACTURING-FLOW-AUDIT.md` | Complete cartridge lifecycle, model linkages, part consumption paths, known anomalies | Answers "why does wax filling link to this lot," explains genealogy tool dependencies | Low — captures foundational design |

These are foundational. Every Ask BIMS question implicitly touches the data model; having these inline eliminates a class of misinterpretation.

### 1.2 TIER 2 — design / compliance / recent fixes, retrievable on demand (~40KB)

| File | Purpose | Use case | Status |
|---|---|---|---|
| `docs/AUDIT-CHECK-SUMMARY.md` | Recent manufacturing fixes (LaserCutBatch → downstream, PartDef ↔ ManufacturingMaterial unification) | Explains *when* a recent fix shipped; helps operators understand if they're working with pre- or post-fix data | Current |
| `docs/magnetometer-system-overview.md` | SPU hardware, mag field calibration, firmware versions | "How does the magnetometer work" for test execution questions | Stable |
| `docs/assay-normalization-report.md` | Data shape fixes for assay definitions post-import | Explains why certain assay fields may be null | Historical, useful context |
| `docs/ask-bims-roadmap.md` | Phase 0–8 plan, tool justifications, operator questions | Clarifies which tools are shipping when, why design choices exist | Current — but discusses future work; needs disclaimer in answers |
| `docs/bioscale-db-audit.md` | Full schema walk-through with anomalies | Complements DATA-REFERENCE | Large — consider after operator feedback |

Retrieved via a `search_documentation(query)` tool when the agent decides the question needs design context.

### 1.3 SKIP — transactional / session handoffs

These are ephemeral notes, not institutional knowledge:
- `SESSION-LOG-*.md`, `SESSION-HANDOFF-*.md`, `tomorrow-catchup-*.md`, `audit-handoff-*.md`
- The current `ask-bims-session-handoff.md` (frozen by design — superseded by future handoffs)
- Anything dated and operator-specific

Including these would bloat context with stale operator chatter.

### 1.4 ⚠️ HANDLE WITH CARE — PRDs and future work

`docs/prds/` (25 files) and `docs/migration/prds/` (19 files) describe *intended* work, not necessarily *shipped* work.

**Risk:** if Ask BIMS ingests `VALIDATION-01-particle-driven-testing.md` and the feature hasn't shipped, the agent may confidently describe non-existent capabilities to operators.

**Handling:** **defer to Phase 2+** — after Phase 1.6 operator interviews tell us which "what would happen if" questions matter. When/if ingested:
- Tag each PRD with shipped status (shipped / in-progress / planned)
- Tool result includes a `prdStatus` field surfaced in answers
- System prompt instructed to never describe planned features as live

### 1.5 SKIP — v1-reference and migration docs

- `docs/migration/` — historical v1→v2 transition notes; not relevant to operational questions
- Old Opentrons API routes, legacy components — noise

---

## 2. Architecture options compared

### Option A — Inline in system prompt (TIER 1 only)

**Mechanism:** Append TIER 1 doc text to the system prompt at request time, with `cache_control: ephemeral`.

| Dimension | Verdict |
|---|---|
| Per-question cost | Cache write ~$0.06 once (Sonnet); subsequent reads ~$0.006/question (10% of write cost) |
| Implementation complexity | Trivial — extend the existing `system: [{ ... cache_control }]` block |
| Maintenance burden | Doc updates require deploy. TIER 1 docs change rarely so this is acceptable |
| Hallucination risk | Medium — agent has all TIER 1 text, but no structured ranking. Mitigated by source citation in system prompt rules |
| Cache budget impact | Pushes prefix from ~2.5K to ~5–6K tokens. Stays within Sonnet cache window |

**Verdict:** Use for TIER 1 only.

### Option B — Full RAG (embeddings + vector store)

**Mechanism:** Embed all docs, store in vector DB, retrieve top-K per question, pass as context.

| Dimension | Verdict |
|---|---|
| Per-question cost | +$0.001–0.003 (question embedding) + small chunk-passing cost |
| Implementation complexity | High — embedding pipeline, vector DB selection, chunking strategy, reranking |
| Maintenance burden | Doc updates require reindexing. Embedding model changes require full rebuild |
| Hallucination risk | High — chunks lose surrounding context; agent may synthesize across unrelated chunks |
| Cache budget | N/A — chunks injected per-question, no caching benefit |

**Verdict:** Overkill for current doc volume (~200KB total, ~90 files). Revisit if corpus grows past ~1000 files.

### Option C — Tool-based ripgrep search

**Mechanism:** Add a `search_documentation(query)` tool that ripgreps the docs/ tree and returns matching paragraphs.

| Dimension | Verdict |
|---|---|
| Per-question cost | Zero marginal API cost (ripgrep runs locally on the server). Tool call adds ~100 tokens to conversation |
| Implementation complexity | Medium — ripgrep integration, paragraph chunking, result formatting |
| Maintenance burden | Low — doc updates are immediately searchable, no reindex |
| Hallucination risk | Medium — keyword search may miss semantic matches; agent may misinterpret without surrounding context. Mitigated by returning more surrounding lines per match |

**Verdict:** Excellent for TIER 2.

### Option D — Hybrid (RECOMMENDED)

**Mechanism:** TIER 1 inline (Option A) + TIER 2 via search tool (Option C). TIER 3 deferred.

| Dimension | Verdict |
|---|---|
| Per-question cost | $0.001–0.003 baseline (cache warm), plus tool calls only when needed |
| Implementation complexity | Medium — combines A and C, both manageable |
| Maintenance burden | Low — TIER 1 stable, TIER 2 auto-searchable |
| Hallucination risk | Medium-low — TIER 1 always available, TIER 2 retrieved on demand, PRDs out of scope |

**Verdict:** Selected. Phased rollout below.

---

## 3. WorkInstruction model integration

`WorkInstruction` (in `src/lib/server/db/models/work-instruction.ts`) holds operator SOPs with versioning, steps, field definitions, part requirements. Currently invisible to Ask BIMS.

### Tool: `search_work_instructions`

```typescript
{
  name: 'search_work_instructions',
  description: `Search work instructions by document number, title, or step content.
Source: WorkInstruction model.

Use when: "what does WI-08 step 4 require", "show me the backing procedure", "what parts does this WI need".
Returns up to 5 matching WIs with version history and matched-step highlights.
Don't use for: questions about Document model (use search_documentation if it's a controlled doc) or completed run details (use get_run_details).`,
  input_schema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'WI number (WI-XX), title fragment, or step keyword' },
      partNumber: { type: 'string', description: 'Optional — filter to WIs requiring this part' },
      status: { type: 'string', enum: ['active', 'draft', 'retired', 'all'], description: 'Default: active' },
      limit: { type: 'number', description: 'Max results (default 5)' }
    },
    required: ['query']
  }
}
```

### Result shape

```typescript
{
  workInstructions: [{
    documentNumber: 'WI-01',
    title: 'Cartridge Backing',
    status: 'active',
    currentVersion: 3,
    effectiveDate: '2026-04-15T...',
    matchedSteps: [
      { stepNumber: 2, title: 'Scan barcode label', requiresScan: true, reason: 'matches "barcode"' },
      { stepNumber: 4, title: 'Apply thermoseal', partRequirements: [...], reason: 'requires PT-CT-001' }
    ],
    fullStepCount: 7,
    sourceUrl: '/spu/work-instructions/WI-01'
  }],
  truncated: false,
  totalAvailable: 1,
  source: 'WorkInstruction model — searched documentNumber/title/step content',
  sourceUrl: '/spu/work-instructions',
  dataIntegrityNotes: []
}
```

### Answer-formatting expectations

When the agent calls this tool, format answers with explicit citations:

> Per **WI-01: Cartridge Backing (v3, effective 2026-04-15)** step 2: scan the barcode label. The label is matched against PT-CT-XXX inventory.
>
> See full WI: [/spu/work-instructions/WI-01](/spu/work-instructions/WI-01)

The widget UI should render WI citations as collapsible cards with version + status badges.

---

## 4. Equipment datasheet integration

Per memory `project_equipment_pdfs_folder`, `C:\Users\nicho\Desktop\Equipment Lists & Datasheets\` contains 2 CSVs (BT, Fannin) + 2 PDF folders. Floor / bench encoding: `B-XX` = floor, `E-XX` (BT) or `F-XX` (Fannin) = bench.

### Tool: `lookup_equipment_datasheet`

```typescript
{
  name: 'lookup_equipment_datasheet',
  description: `Look up equipment specifications from local Equipment Lists & Datasheets folder (CSVs only — PDFs not parsed in this phase).
Source: CSV files in C:\\Users\\nicho\\Desktop\\Equipment Lists & Datasheets\\

Use when: "what's the temp range for fridge X", "spec sheet for the cooling tray", "what's the model number of OT-2 deck Y".
Don't use for: live equipment status (use list_equipment or get_current_temperatures) or calibration history (use list_calibrations_due).`,
  input_schema: {
    type: 'object',
    properties: {
      equipmentName: { type: 'string', description: 'Equipment name (case-insensitive partial match)' },
      spec: { type: 'string', description: 'Optional — specific spec to extract (e.g., "temperature range", "capacity")' }
    },
    required: ['equipmentName']
  }
}
```

### Implementation notes

- Parse CSVs lazily (cache parsed contents in-memory with file-mtime invalidation)
- Fuzzy name match (substring + word-boundary)
- Return raw row + flag whether a matching PDF exists in the same folder
- PDF parsing is **explicitly out of scope this phase** — flag for future work

### Acceptance criteria

1. CSV files in target directory are parsed without crashing
2. `equipmentName="Fridge 3"` returns the correct row from the BT or Fannin CSV
3. PDFs are listed but never returned as text (not in scope)
4. Result includes `csvSource` field so operator can verify

---

## 5. Phased rollout — 2-week plan

### Phase A: TIER 1 inline (Days 1–2)

- Extract DATA-REFERENCE + MANUFACTURING-FLOW-AUDIT into a dedented, condensed format
- Embed in `SYSTEM_PROMPT` array with `cache_control: ephemeral`
- Add an explicit instruction in the system prompt: "When grounding answers in inline reference docs, cite the doc title in your response."

**Acceptance:**
- Cache creation verified (`cache_creation_input_tokens > 0` on first call)
- Cache reads confirmed on subsequent calls
- All 27 existing baseline tests still pass on Haiku
- One new fixture: a question that requires DATA-REFERENCE knowledge passes

### Phase B: `search_documentation` tool (Days 3–5)

- Add the tool to `TOOLS` array in `ask-bims.ts`
- Implementation runs ripgrep over `docs/` and returns top-K paragraphs with file:line citations
- Hard cap: 5 results, 200 chars per result
- Integration test: 5 representative queries each return useful results

**Acceptance:**
- Tool latency < 500ms (ripgrep is fast on a 200KB corpus)
- Agent calls the tool only when relevant (manual prompt-engineering review)
- Test fixtures cover: "why does X work this way", "what was the recent fix for Y", "what does WI-XX require"

### Phase C: `search_work_instructions` tool (Days 6–8)

- Add tool to `TOOLS`
- Server implementation queries `WorkInstruction` model with regex search across documentNumber, title, step content
- Surface partNumber filter
- Add UI rendering: WI citations as cards in the widget

**Acceptance:**
- 3 new test fixtures pass (find by number, find by step keyword, find by part requirement)
- Answer format includes "Per WI-XX step Y" pattern
- No regression in existing tools

### Phase D: `lookup_equipment_datasheet` tool + comprehensive testing (Days 9–14)

- Add tool, implement CSV parsing
- Cache parsed CSVs with file-mtime invalidation
- Fuzzy equipment name matching

**Acceptance:**
- All 3 new tools (`search_documentation`, `search_work_instructions`, `lookup_equipment_datasheet`) live
- 5 fixture questions in test harness pass on Haiku
- Per-question cost remains ≤ $0.025 on Sonnet with warm cache
- Manual operator validation: 3 real questions answered with appropriate citations

---

## 6. Five test questions for Phase D acceptance

| # | Question | Expected tools | Citation requirement |
|---|---|---|---|
| 1 | "What does WI-01 step 2 require?" | `search_work_instructions` | WI-01, step 2 cited explicitly |
| 2 | "Why does cartridge backing link to thermoseal strips?" | (none — answered from inline TIER 1) | "Per MANUFACTURING-FLOW-AUDIT" |
| 3 | "What manufacturing fixes did we deploy recently?" | `search_documentation` | AUDIT-CHECK-SUMMARY excerpts with line numbers |
| 4 | "What's the temperature range for the main fridge?" | `lookup_equipment_datasheet` | CSV row + source filename |
| 5 | "How do we track cartridges from backing to shipping?" | (none — answered from inline TIER 1) | "Per the cartridge lifecycle documented in MANUFACTURING-FLOW-AUDIT" |

---

## 7. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Doc rot — TIER 1 docs become stale and Ask BIMS confidently cites outdated info | Explicit `effectiveDate` in TIER 1 docs; cache invalidation on doc commit; quarterly TIER 1 review cadence |
| PRD confusion — agent describes unbuilt features as live | TIER 3 PRDs deferred entirely until Phase 2+ post-interviews; if eventually ingested, every result includes `prdStatus: 'shipped' \| 'in-progress' \| 'planned'` |
| Ripgrep timeout on large corpus | Hard 500ms timeout; graceful fallback returns "search timed out, try a more specific query" |
| Sensitive data leaks (customer info, security details, vendor secrets in docs) | Filename allowlist on Tier 2; PR review gate on new docs/ additions; integrity-note auto-fires if a result mentions known sensitive patterns |
| Search quality — keyword search misses semantic matches | Iterate prompt: "if first search doesn't help, try synonyms"; revisit Option B (RAG) if false-negative rate > 15% in operator feedback |
| Cache invalidation cost spike on TIER 1 doc edit | Acceptable — ~$0.06 once on next cold start; visible in cost dashboard |
| Hallucination from synthesizing across multiple docs | System prompt rule I: "When grounding in docs, quote the relevant passage. Never paraphrase across multiple docs." |

---

## 8. Phase 2+ considerations (post-Phase D)

After Phase 1.6 operator interviews:

1. **PRD ingestion** — review top operator questions; if "how do we plan to do X" is in the top 20, ingest the relevant PRD with shipped-status tagging
2. **Conversation-grounded retrieval** — if cross-doc questions emerge, consider Option B's reranking selectively
3. **Doc change notifications** — when TIER 1 docs change, notify admin + force cache refresh
4. **Operator feedback loop** — thumbs feedback (Phase 1.7) tracks which sources were cited; weekly review for source-quality patterns

---

## 9. Closing checklist

**Before shipping any phase:**
- [ ] Existing 27 tools still pass on Haiku (no regression)
- [ ] New tool has at least one fixture in `tests/ask-bims/baseline.ts`
- [ ] Cost per question on Sonnet remains ≤ $0.025 with warm cache
- [ ] Documentation grounding is verifiable (citations appear in answers)
- [ ] No accidental ingestion of session/handoff/transactional docs

**Before declaring "markdown-aware Ask BIMS" done:**
- [ ] Operator validation pass: 3 real questions answered with citations
- [ ] No hallucination patterns observed in test set
- [ ] System prompt updated with doc-grounding rules
- [ ] `tests/ask-bims/baseline.ts` extended with 5 doc-grounded fixtures

This design balances quick wins (TIER 1 inline) with maintainability (TIER 2 via search tool) and risk mitigation (TIER 3 deferred). 2-week ship target. Iterate based on Phase 1.6 interviews.

---

## 10. Scope expansion notes (post-design)

Phases A–D landed as planned (commits `3100287`, `3a950d9`, `77b307b`, `0f7b682`).

**Phase E** was added mid-build to bundle cross-repo research-side tools into
the same branch — direct shared-Mongo queries against the 11 research-only
collections (Experiment, Sample, Analyte, AnalysisProfile, CalibratedAnalysis,
ReagentCatalog, ReagentInventory, ProtocolDefinition, ProtocolExecution).
Split into 5 vertical-slice commits:

- **E1** (`e9d0cba`) — experiment + research-cart tools (4 tools)
- **E2** (`2f15cc8`) — reagent catalog + inventory tools (5 tools, variant-aware)
- **E3** (`280b147`) — protocol definition + execution tools (4 tools, cellMap-empty warning)
- **E4** (`a676899`) — `trace_reagent_chain` recursive grail tool
- **E5** (`89cf603`) — samples + analytes + analysis profiles + calibrated analyses (5 tools)

Total Phase E: 19 tools / 9 new Mongoose models (all `strict: false` read-only mirrors).

**Phase 1–6.4** followed (separate work on the same branch) — daily integrity scan,
chemical inventory, floor-plan tool, thumbs feedback plumbing + UI, 11 operational
gap-fillers, 4 manufacturing analytics, voice/phrasing polish, AND-of-words
docs search upgrade, Node-fs fallback for the test harness, code-level
anti-redundancy guard. See git log for the full series.

**Final-push fill-in** closes remaining gaps: cache-breakpoint placement fix,
`executedByName` regex on `list_protocol_executions`, 5 missing analytics tools
(`get_capability_trend`, `cpk_vs_target`, `shift_correlation`, `fmea_risk_query`,
`forecast_capability_impact`), bulk aggregators (`bulk_temperature_summary`,
`bulk_cartridge_status`), `find_runs_by_operator`, and conversation logging
(`AskBimsConversationLog` model — PII redaction stays no-op pending policy).
