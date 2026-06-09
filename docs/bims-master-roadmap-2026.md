# BIMS Master Roadmap — 2026 Operational Push

**Status:** DRAFT skeleton 2026-05-07. Will be updated as parallel research streams return their deliverables. The user has set this up as a "training-for-the-Olympics" push — final operational maturity for BIMS before it goes fully live.

**Audience:** Future-Claude sessions, the engineering team, and Bioscale stakeholders making strategic prioritization decisions.

---

## TL;DR

We're moving BIMS from "production-capable manufacturing system" to a **fully integrated operational platform** spanning manufacturing, quality, finance, document control, automation, and analytics. Seven workstreams running in parallel, with clear sequencing and explicit dependencies. The robot-arm wax-filling future is the north star; nothing here forecloses it.

---

## What this document is

A single integrated plan tying together:

1. **Ask BIMS enhancement** — markdown-aware agent (smarter without operator interviews)
2. **Opentrons integration** — tight coupling into manufacturing flows
3. **Barcode scanner automation** — minimize keyboard time on the floor
4. **ERP / financial layer** — full COA → GL → SLE → Invoicing per existing 12-doc deep-dive
5. **Process engineering & analytics** — SPC, CpK, trend dashboards, FMEA editor
6. **QMS expansion** — CAPA, NC, document red-line, training enforcement
7. **UI cleanup** — design system consistency, mobile, navigation hygiene
8. **Robot-arm long-term vision** — informs today's architectural decisions

Each workstream has its own detailed doc (linked below). This file is the **integration layer** — sequencing, dependencies, contention, and the unified phased plan.

---

## Source documents (per workstream)

Filled in as the research streams complete. Status as of 2026-05-07:

| Workstream | Detailed plan doc | Status |
|---|---|---|
| ERP integration | `docs/erp-integration-master-plan.md` | ✅ written 2026-05-07 — synthesizes 13 deep-dive chapters into a 10-phase buildout |
| Ask BIMS markdown context | `docs/ask-bims-markdown-context.md` | ✅ written 2026-05-07 |
| Scanner automation | `docs/scanner-automation-plan.md` | ✅ written 2026-05-07 |
| Opentrons integration | `docs/opentrons-integration-plan.md` | ✅ written 2026-05-07 |
| QMS expansion | `docs/qms-expansion-plan.md` | ✅ written 2026-05-07 |
| Process analytics | `docs/process-analytics-enhancement-plan.md` | ✅ written 2026-05-07 |
| UI cleanup | `docs/ui-cleanup-plan.md` | ✅ written 2026-05-07 |
| Robot-arm vision | `docs/robot-arm-wax-filling-vision.md` | ✅ written 2026-05-07 |
| Existing ERPNext deep-dive | `docs/erpnext-deep-dive/*` (13 files) | ✅ exists, being incorporated |
| Existing Ask BIMS roadmap | `docs/ask-bims-roadmap.md` | ✅ rev 2 |
| Existing Ask BIMS handoff | `docs/ask-bims-session-handoff.md` | ✅ as of last session |

---

## Sequencing rationale (the "why this order")

The 7 active workstreams aren't independent. They have hard dependencies and natural coupling. Sequencing principles:

1. **Foundation first.** Markdown-aware Ask BIMS unlocks operator self-service across every other workstream. Should ship early.
2. **Touch high-value flows next.** Scanner automation + Opentrons integration directly compress floor time and unlock data quality. Big payoff per unit of work.
3. **Compliance and quality before scale.** QMS expansion (CAPA, NC) closes audit gaps that are necessary BEFORE scaling production with the robot arm or expanding to new assays.
4. **ERP last among the active workstreams.** It's the largest scope by far. Built on the documentation, schema, and audit infrastructure the earlier workstreams produce. Needs the most stakeholder time.
5. **UI cleanup interleaved.** Don't gate any workstream on UI cleanup; address inconsistencies as new pages are added in each workstream's deliverables.

---

## Dependencies & contention

```
                   ┌─────────────────────────────┐
                   │ Markdown-aware Ask BIMS     │  (foundation)
                   └──────────────┬──────────────┘
                                  │
          ┌───────────────────────┼───────────────────────┐
          ▼                       ▼                       ▼
  ┌────────────────┐    ┌────────────────┐    ┌────────────────┐
  │ Scanner        │    │ Opentrons      │    │ QMS expansion  │
  │ automation     │    │ integration    │    │ (CAPA / NC)    │
  └────────┬───────┘    └────────┬───────┘    └────────┬───────┘
           │                     │                     │
           └──────────┬──────────┴─────────────────────┘
                      ▼
           ┌──────────────────────┐
           │ Process analytics    │  (consumes data from above 3)
           └──────────┬───────────┘
                      │
                      ▼
           ┌──────────────────────┐
           │ ERP / financial      │  (largest, needs prior data quality)
           └──────────┬───────────┘
                      │
                      ▼
           ┌──────────────────────┐
           │ Robot-arm wax fill   │  (long-term, informed by all above)
           └──────────────────────┘
```

UI cleanup is parallel to all of these — addresses domain-by-domain as we touch each.

---

## Phased master plan

*Filled in once all workstream docs return. Will integrate each workstream's phases into a unified ~12-month sequence with quarterly checkpoints.*

### Phase 1 — Foundation (Weeks 1–2)

Goal: low-risk, high-leverage prep. Each piece ships independently.

- **Markdown-aware Ask BIMS** (per `ask-bims-markdown-context.md` Phase A–B): TIER 1 docs inlined in system prompt + `search_documentation` tool. Unlocks "why" questions across all later workstreams. **Cost: $0.01/q increase, paid back in operator time-savings within 2 weeks.**
- **Scanner Phase 0** (per `scanner-automation-plan.md`): barcode parser + `ScannerRule` model + `/admin/scanner-triggers` admin UI. Foundational; nothing automated yet.
- **Opentrons Phase 0** (per `opentrons-integration-plan.md`): state machine service + `OpentronsProtocol` model + admin UI. No live runs yet.
- **Analytics Phase 1** (per `process-analytics-enhancement-plan.md`): spec-limit configuration UI, FMEA editor, rejection-code taxonomy migration.
- **Design system Phase 1** (per `ui-cleanup-plan.md`): hardcoded colors → CSS vars, create `FormField` / `LoadingState` / `ErrorBoundary` shared components.

### Phase 2 — Floor automation (Weeks 3–6)

Goal: meaningful floor-time reduction. Operators feel it daily.

- **Scanner Phases 1–2**: auto-induct on cartridge scan, contextual sticker scans (QC-PASS, storage location) auto-transition.
- **Opentrons Phases 1–2**: protocol selection + robot reservation + run start API, status polling every 5s.
- **Ask BIMS work-instruction tool** + **equipment datasheet tool** (markdown context Phase C–D).
- **NC Phase 1** (per `qms-expansion-plan.md`): NonConformance model + auto-triggers (QC failures, equipment out-of-spec, operator scrap) + traceability links.

### Phase 3 — Compliance maturity (Weeks 7–10)

Goal: close ISO 13485 / 21 CFR 820 gaps that block production scale.

- **CAPA Phase 2** (qms-expansion-plan): CAPA system on top of NC, state machine, signoff gates, notifications.
- **Document red-line Phase 3**: text/markdown diff viewer + WorkInstruction step-level diff + e-signature integration.
- **Training enforcement Phase 3**: auto-create TrainingRequirement on document revision; operator inbox; admin compliance dashboard.
- **Analytics Phase 2** (monitoring): daily operator dashboard, capability-trend dashboard, yield deep-dive, SPC alert investigation log.
- **UI Phase 2** (high-impact rewrites): `/manufacturing/analysis`, `/wax-filling`, `/reagent-filling` refactored.

### Phase 4 — Operational depth + ERP entry (Weeks 11–18)

Goal: deeper insights + start the financial layer.

- **Opentrons Phases 3–4**: result capture + auto-transition, error detection + CAPA integration.
- **Scanner Phases 3–4**: inventory auto-decrement, operator feedback (LED + beep + toast).
- **Analytics Phase 3** (insights): fishbone editor, FMEA risk heatmap, operator scorecards, manager monthly dashboard.
- **ERP Phase 1** (foundation per existing erpnext-deep-dive plan + the dedicated ERP plan when it lands): Account, GL Entry, Stock Ledger Entry shells. Read-only; no posting yet.
- **QMS Phase 4–5**: Management Review + Internal Audit shells, QMS dashboard, Ask BIMS QMS tools.

### Phase 5 — Workflow + ERP buildout (Months 5–7)

Goal: ERP starts posting; workflows automate further.

- **ERP Phases 2–4**: Chart of Accounts, Items, SLE/GL linkage. Shadow-doc pattern preserves existing BIMS flows.
- **Scanner Phases 5–6**: offline buffering + replay, batch multi-cartridge transitions.
- **Opentrons Phases 5–6**: dual-identity consolidation (OpentronsRobot + Equipment → Robot), safety interlocks.
- **Analytics Phase 4** (optimization): material-lot traceability, 10 Ask BIMS analytics tools, DOE planner.
- **UI Phase 3–4**: form unification, accessibility (411 a11y → 0).

### Phase 6 — Full ERP + advanced analytics (Months 7–12)

Goal: ERP feature-complete; analytics predictive.

- **ERP Phases 5–10**: Buying, Selling, BOM/WorkOrder, QI, Projects, Production Plan.
- **Analytics Phase 5** (automation): WebSocket SPC alerts, predictive yield model, automated corrective-action suggestions.
- **UI Phase 5**: navigation polish, performance, lazy-loading.

### Phase 7 — Robot-arm prep (Year 1+)

Per `robot-arm-wax-filling-vision.md`: event-sourced state primitives, real-time channel infra, robot-agnostic API at `/api/robots/[id]/*`. Validation/IQ/OQ/PQ formal infra.

---

## Open business questions (need stakeholder input)

These come from the various workstream docs. The user wants to discuss with the team starting tomorrow.

### From ERP workstream (13 questions, per memory `project_erpnext_design_decisions`)
*To be enumerated from agent output.*

### From QMS workstream
*Pending.*

### From scanner / Opentrons
*Pending.*

### From this session
- **What is the "research system"?** User mentioned a separate research system that's "integral to our company usage." From a code search, I found:
  - `ReagentBatchRecord.isResearch` flag (research-mode reagent runs)
  - `LabCartridge` model (research/development cartridges, not production)
  - Particle device telemetry (Mocreo sensors, Particle Boron/Argon devices per `ParticleDevice` model)
  - CV / computer vision pipeline for cartridge inspection
  
  None of these read as a separate "research system." Most likely interpretations: (a) the BIMS research-mode features (isResearch flag), (b) an external R&D database I haven't seen, (c) the Brevitest test results infrastructure. **Need clarification before tools/integrations can be designed against it.**

---

## Risk register (top items)

*Will be expanded as workstream docs surface specifics.*

| Risk | Workstream | Mitigation |
|---|---|---|
| ERP migration breaks production manufacturing during cutover | ERP | Shadow-doc pattern (per existing memory rules); forward-only backfill; phased rollout |
| Markdown ingestion makes Ask BIMS confidently wrong about stale docs | Ask BIMS | Doc freshness scoring; PRD vs SOP tagging; explicit "this doc was last updated YYYY-MM-DD" surfaces |
| Robot-arm decisions made today silently foreclose future architecture | Robot arm | Robot-agnostic API naming; event-sourced state; abstraction layer at API boundary |
| QMS workflows add friction operators route around | QMS | Operator-input design; auto-population from existing data; minimum-viable forms |
| ERP financial integration creates audit-trail gaps with existing Mongo records | ERP | Sacred-doc + docstatus pattern preserved; audit log middleware extended uniformly |
| Multiple parallel workstreams compete for same files / refactors | All | This master roadmap; explicit ordering; one workstream's output becomes another's input |

---

## Success metrics

*To be refined per workstream. Initial framing:*

- **Ask BIMS**: average questions per operator per shift (target: 5+); CTR on Verify-in-BIMS links (target: 10%+)
- **Scanner automation**: reduction in keyboard input events per cartridge processed (target: -50%)
- **Opentrons integration**: number of robot runs initiated from BIMS without external Opentrons app (target: 100%)
- **QMS**: open NCs > 30 days old (target: <5); CAPA closure rate (target: 90% within target date)
- **Process analytics**: % of completed wax runs with CpK calculated and surfaced (target: 100%)
- **ERP**: full SLE+GL coverage of inventory transactions (target: 100% for new transactions; 80% historical backfill)
- **UI**: design system token usage (target: 95%+); pages flagged for redo addressed (target: top 10 by Q4)

---

## What to do tomorrow (when discussion with team starts)

1. **Review this doc + each workstream's detailed doc** with the team
2. **Resolve the "research system" clarification question** above
3. **Walk through the open business questions** from each workstream
4. **Pick a sequencing**: do we follow the suggested order? What pulls forward, what pushes back?
5. **Pick a Phase 1 starting commit**: which workstream first? Markdown-aware Ask BIMS is the cheapest, fastest-impact, lowest-risk start.
6. **Capacity check**: who can be involved? What's the hours-per-week headroom?

---

## Maintenance

This doc is the **integration layer**. It updates when:
- A workstream's detailed plan changes (ripple here)
- A phase is started, paused, or completed (status update)
- A new workstream is added or removed
- A risk is realized or mitigated (move from risk register to lessons learned)

Detailed implementation specifics belong in workstream docs, not here. This file should stay readable in 5 minutes by anyone needing the integrated view.

---

## Appendix — what was deliberately deferred from this push

- Internationalization (English-only for now)
- Multi-tenant / multi-site (single site)
- Mobile app (responsive web only)
- Patient-facing surfaces (medical device, not telehealth)
- Full IQ/OQ/PQ infrastructure (sketched in robot-arm doc, formal build later)
- Customer-facing API / B2B integrations (not this round)
