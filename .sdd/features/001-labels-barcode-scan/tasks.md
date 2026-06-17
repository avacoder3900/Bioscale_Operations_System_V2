---
feature_id: 001
status: complete  # not-started | in-progress | complete
---

# Tasks: Labels tab barcode scan

## Legend

- `[ ]` not started
- `[~]` in progress
- `[x]` complete
- `[!]` blocked

## Tasks

### Implementation

- [x] **T001** — Add scan state + helpers in Labels tab `<script>` block
  - Covers: REQ-004, REQ-007, REQ-009, REQ-010, REQ-011
  - Files: `src/routes/cv/projects/[id]/+page.svelte`
  - Adds: `scanValue`, `scanError`, `scannedIds: Set<string>`, `matchOrder: string[]`, `scanInputEl`, derived `sortedImages`, helper `captureNumFromFilename(name)`, function `applyScan()`.
  - Verification: `npm run check` passes.

- [x] **T002** — Render scan input + pinned match styling in Labels tab markup
  - Covers: REQ-001, REQ-002, REQ-005, REQ-008, REQ-009, REQ-010
  - Files: `src/routes/cv/projects/[id]/+page.svelte`
  - Replaces `{#each data.images as image}` inside the Labels tab with `{#each sortedImages as image}`. Adds `<input>` element above the grid, "No images found" message, SCANNED + TOP/BOTTOM badges, pulsing-cyan ring when `scannedIds.has(image._id)`.
  - Verification: `npm run check` passes; visual check in browser.

- [x] **T003** — Auto-focus scan input on Labels tab activation + scroll-to-match after scan
  - Covers: REQ-003, REQ-006
  - Files: `src/routes/cv/projects/[id]/+page.svelte`
  - `$effect` that calls `scanInputEl?.focus()` when `activeTab === 'labels'`. Inside `applyScan()`, after updating state, `await tick()` then `scrollIntoView({behavior:'smooth', block:'start'})` on first matched tile via a bindable ref.
  - Verification: manual — clicking Labels tab focuses the input; scanning scrolls page to first match.

### Validation

- [x] **T004** — Run `npm run check` and fix any TS errors introduced (zero new errors in `cv/projects/[id]/+page.svelte`; 264 pre-existing project-wide errors unchanged)
  - Files: entire project
  - Verification: `npm run check` exits 0.

- [~] **T005** — Manual acceptance walkthrough against spec REQ-001 … REQ-011
  - Verification: each acceptance bullet in spec ticks.
  - Status: pending user browser verification (agent cannot run a browser).

### Closeout

- [x] **T006** — Mark spec status `implemented`, tasks status `complete`
- [x] **T007** — Commit on current branch with message referencing feature 001
