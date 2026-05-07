# BIMS UI Layout & Cleanup Plan

**Date:** 2026-05-07
**Scope:** ~159 page-server routes, shared components, Tron design system

## Executive summary

BIMS today has ~159 page routes across 10+ domains. CLAUDE.md's "DO NOT MODIFY .svelte files" rule is **stale** — recent commits show new pages are being added freely (admin/ask-bims/cost, manufacturing/pipeline, etc.). This plan formalizes the new reality: graduated permissions on the UI layer, consistent Tron design system usage, mobile-responsive patterns, accessibility (411 a11y warnings → 0), and a 5-phase redo prioritized by user impact. The plan also includes a conceptual sketch for the future robot-arm wax-filling UI.

---

## 1. Page inventory by domain

### Manufacturing (~36 pages)
Core workflows (`wi-01`, `wax-filling`, `reagent-filling`, `cut-thermoseal`, `laser-cut`, `assembly`, `analysis` (12-tab dashboard, 1,261 lines), `print-barcodes`, `equipment`, `pipeline`).

**Issues:** Monolithic large files (analysis 1,261 lines, wax-filling 1,371 lines), inline styles, mobile layout assumptions, deep component nesting.

### Admin (~8 pages)
`device-crashes`, `invites`, `roles`, `users`, `agent-activity`, `ask-bims`, `ask-bims/cost` (new). Simple lists + edit forms.

**Issues:** Inconsistent form styling between pages (some `tron-input`, others raw Tailwind).

### Validation (~10 pages)
Magnetometer, spectrophotometer, thermocouple — each with list/detail/new patterns.

**Issues:** Modal overflow on mobile, tables not responsive.

### Documents (~16 pages)
List, detail (3 tabs), new, import, approvals, training, repository, instructions, build-logs, box, upload.

**Issues:** Wide preview + side panel breaks on mobile.

### Equipment (~10 pages)
Equipment list, robots list+detail, decks-trays, temperature-probes/settings.

**Issues:** No breadcrumb nav (hard to back out of nested routes).

### Other domains
Cartridges (4), assays (6), CV (7), kanban (5), inventory (2), test-results (2), shipping (1), BOM (5), opentrons (8), customers (2), batches (2), SPU (2), parts (5), particles (1), receiving (3), login (1), invite (1), cartridge-dashboard (1).

---

## 2. Tron design system audit

### CSS variables (in root layout / app.css)

**Backgrounds:**
- `--color-tron-bg-primary` (#0a0a0f, page background)
- `--color-tron-bg-secondary` (#12121a)
- `--color-tron-bg-tertiary` (#1a1a2e, button/input fill)
- `--color-tron-bg-card` (#16161f)

**Accents:**
- `--color-tron-cyan` (#00d4ff, primary action)
- `--color-tron-blue`, `--color-tron-green`, `--color-tron-yellow`, `--color-tron-orange`, `--color-tron-red`, `--color-tron-purple`

**Text:** `--color-tron-text` (#e0e0e0), `--color-tron-text-secondary` (#a0a0a0)

**Component classes:** `.tron-card`, `.tron-card-interactive`, `.tron-button*`, `.tron-input`, `.tron-select`, `.tron-label`, `.tron-badge-*`, `.tron-table`, `.tron-progress*`, `.tron-grid-bg`, `.tron-scanlines`, `.animate-tron-pulse`.

### Consistency findings

**Consistent:** ~90% buttons use `tron-button` or cyan-tinted Tailwind, ~80% cards use `.tron-card`, ~70% badges use `.tron-badge-*`, ~60% tables use `.tron-table`.

**Inconsistent:**
- Forms — split between `tron-input` and raw Tailwind
- Spacing — no unified gap/padding (gap-4 vs gap-6 vs ad-hoc margins)
- Font sizes — mix of Tailwind text-sm/text-base and inline `style="font-size: 14px"`
- Hardcoded hex colors in some components instead of CSS variables
- Box-shadows ad-hoc on some cards

**High-variance pages:** `manufacturing/analysis/+page.svelte`, `manufacturing/wax-filling/+page.svelte`, `admin/ask-bims/cost/+page.svelte`.

### Reusable component coverage

Domain-specific components exist (`WaxPreparation`, `DeckLoadingGrid`, `CompletionStorage`, `QCInspection`) — used within their domain only. Few cross-domain reusables (no shared FormField, LoadingState, ErrorBoundary). Multiple pages duplicate equipment-selector, QC inspection, confirmation-step patterns.

---

## 3. Layout smells

### 3.1 Inline-style overuse (~50 pages)
Top culprits in manufacturing. Pattern: `style="width: {pct}%; background: {good ? 'green' : 'red'}"`. Should use Tron CSS vars + Tailwind classes.

### 3.2 Mobile layout failure (~30 pages)
Documents detail (preview + panel side-by-side), equipment detail, cartridge detail, opentrons detail. Fix pattern: `flex-col lg:flex-row gap-4` with `min-w-0` to prevent overflow.

### 3.3 Missing loading/error states (~80 pages)
Most list pages render blank during fetch. Need `SkeletonLoader`, `ErrorBanner`, `EmptyState` shared components + a consistent pattern.

### 3.4 Duplicate component code (~15 patterns)
Equipment-selector, QC inspection, confirmation step, run progress bar — duplicated across manufacturing pages. Extract to `src/lib/components/manufacturing/`.

### 3.5 Missing breadcrumbs (~30 pages)
Nested routes (e.g., `/equipment/robots/[id]/edit`) provide no back-navigation hint. Auto-derive breadcrumbs from route structure.

### 3.6 Orphan pages (no nav entry)
`/cartridge-dashboard`, `/opentrons/runs/new`, deep `/documents/instructions/[id]/fields`, several `/admin/*` subpages.

---

## 4. Navigation audit

**Top nav:** hamburger menu + logo + user menu. ~8-10 entries visible. Some pages buried 3+ levels with no clear path.

**Side nav:** per-layout sidebar. Content varies by route — refresh confusion possible.

**In-page nav:** tabs in analysis/documents/validation/kanban; steppers in workflows. Inconsistent active-tab styling (underline vs background vs missing).

---

## 5. Quick wins (bulk, automatable)

| Fix | Scope | Effort | Pattern |
|---|---|---|---|
| Hardcoded colors → CSS vars | ~30 pages | 4h regex replace | `style="color: #00ff88"` → `class="text-[var(--color-tron-green)]"` |
| Missing Tron classes on buttons | ~50 pages | 2 days | `class="rounded border ..."` → `class="tron-btn-primary"` |
| Ad-hoc spacing → Tailwind scale | ~100 pages | 3 days | `style="margin-bottom: 24px"` → `class="mb-6"` |
| Missing form-label associations | ~80 pages | 1 week | `<div>Operator</div><input>` → `<label for="x">Operator</label><input id="x">` |

---

## 6. Pages ranked by redo priority

### Tier 1 — high impact (user volume + broken layouts)

1. **`/manufacturing/analysis`** (1,261 lines, 12 tabs, daily ops use, mobile-broken). 5-7 days. Refactor unblocks Phase 4 of process analytics plan.
2. **`/manufacturing/wax-filling`** (1,371 lines, core production). 5-7 days.
3. **`/manufacturing/reagent-filling`** (~880 lines). 4-5 days.
4. **`/cartridges`, `/cartridges/[id]`, `/cartridges/analysis`** — mobile layout failure, missing breadcrumbs. 2-3 days.

### Tier 2 — medium impact

5. **`/documents/*`** (16 pages, mobile broken on preview/panel). 3-4 days. Compliance-critical.
6. **`/admin/*`** (8 pages, inconsistent forms). 1-2 days.
7. **`/equipment/*`** (10 pages, missing breadcrumbs). 2-3 days.

### Tier 3 — low impact
Validation (modals on mobile), kanban (minor), assays (a11y).

---

## 7. The "frozen UI" rule — proposed update

### Original rule (CLAUDE.md)

> "Any `.svelte` file (UI layer is frozen — copied from old app)"

### Reality (recent commits)

`/admin/ask-bims/cost/+page.svelte`, `/manufacturing/pipeline/+page.svelte`, `/admin/users/+page.svelte` — all newly created. Rule is obsolete as written.

### Proposed graduated permissions

```
DO NOT MODIFY (frozen layer)
  - src/lib/components/*         (shared library)
  - src/lib/stores/*             (Svelte stores)
  - src/lib/utils/*              (client-side utils)
  - src/app.html, src/app.css    (root templates)
  - src/routes/+layout.svelte    (root layout structure)

CAN MODIFY (with review for sweeping changes)
  - src/routes/+page.server.ts   (load + actions, always OK)
  - src/routes/+page.svelte      (page UI, OK if:
       1. Isolated page addition (new route)
       2. Structural fix (missing error state, accessibility)
       3. Bug fix
     NOT OK without review: refactor existing flow
  - src/routes/[domain]/+layout.svelte  (review required)

CAN CREATE NEW
  - src/lib/components/[domain]/  (typed, testable)
  - New routes (per CLAUDE.md patterns)
```

Rationale: developers shouldn't be blocked on isolated fixes or new pages; sweeping refactors of core flows go through review; shared component library stays locked.

---

## 8. 5-phase redo plan (12 weeks)

### Phase 1 — Design system cleanup (Weeks 1-2)

- Audit all hardcoded colors → replace with CSS vars (regex)
- Document Tron class usage in CLAUDE.md
- Create `FormField`, `LoadingState`, `ErrorBoundary`, `Breadcrumb` shared components
- Stand up component-usage docs

### Phase 2 — High-impact rewrites (Weeks 3-6)

- `/manufacturing/analysis` refactor: split 12 tabs into separate components, mobile, error states
- `/manufacturing/wax-filling`, `/manufacturing/reagent-filling`: same treatment
- Extract domain components (EquipmentSelector, QCInspection, ConfirmationStep)

### Phase 3 — Form & admin unification (Weeks 7-8)

- Standardize all inputs via `FormField`
- Unify approval workflows (consistent button placement)
- Add breadcrumbs to all detail/edit pages

### Phase 4 — Accessibility (Weeks 9-10)

- Run axe audit, fix top 50 issues
- ARIA labels on interactive elements
- Color is not sole differentiator
- Screen reader testing (NVDA, JAWS)

### Phase 5 — Navigation polish (Weeks 11-12)

- Auto breadcrumbs from route structure
- Audit orphan pages, add nav entries
- Mobile hamburger improvements
- Lazy-load heavy components
- Performance: Lighthouse > 80 on top 10 pages

---

## 9. Robot-arm wax-filling UI conceptual sketch

Future state where wax filling collapses from 6 manual steps to a single supervised dashboard. See `docs/robot-arm-wax-filling-vision.md` for full architectural context.

### Proposed layout

**Left pane (60%)** — live video feed from camera above the filling station:
- Robot arm position, cartridge on deck, wax tip alignment
- Overlay: confidence boxes, status labels ("Dispensing", "QC", "Done")
- Tap to zoom region

**Right pane (40%)** — live metrics + controls:
- Process stage indicator + progress bar
- Real-time cards: cycle time elapsed, est remaining, status (🟢 In Progress)
- Sensor row: temp, pressure, dispense rate
- Action buttons: Pause, Resume, Abort, Quality Override
- Event log: "12:30 dispense started" → "12:32 QC passed" → "12:33 cooling"

**Mobile:** stack video on top, controls below, scrollable.

**Concept:** operator becomes supervisor, not executor. One-tap pause/override. Mirrors a control-room interface.

---

## 10. Implementation checklist

**Design system:**
- [ ] Hardcoded colors → CSS vars (regex pass)
- [ ] Formalize Tailwind spacing scale
- [ ] Document typography scale

**Components:**
- [ ] Create `FormField`, `LoadingState`, `ErrorBoundary`, `Breadcrumb`
- [ ] Extract `EquipmentSelector`, `QCInspection`, `ConfirmationStep`

**Pages — Phase 2:**
- [ ] `/manufacturing/analysis` — refactor + split
- [ ] `/manufacturing/wax-filling` — same
- [ ] `/manufacturing/reagent-filling` — same

**Accessibility:**
- [ ] axe audit, top 50 fixed
- [ ] ARIA labels on all interactive elements

**Testing:**
- [ ] Mobile responsive (375 / 768 / 1920)
- [ ] axe + screen reader + keyboard nav
- [ ] Lighthouse > 80 on top 10 pages

---

## 11. Conclusion

BIMS UI is **not frozen** — it's actively maintained. The rule was a guardrail against breaking core flows; today, isolated fixes and new pages are encouraged, sweeping refactors require review, shared component library stays locked. Phase 1-5 (12 weeks) shifts BIMS from "works but brittle" to **maintainable, accessible, mobile-first**. Tron design system applied consistently makes BIMS feel like a cohesive product instead of a patchwork.
