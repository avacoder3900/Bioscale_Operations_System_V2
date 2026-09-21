# SPU-INV-02 — SPU Inventory Moves to `/spu`; `/spu/mfg` Lands on Assembly

**Status:** Draft
**Branch:** `feat/spu-tweaks`
**Companion:** [SPU-INV-01](SPU-INV-01-list-view.md) (the list view that ships at the new route)

## Problem

The SPU inventory is currently the "Overview" tab *inside* SPU Manufacturing (`/spu/mfg`), but it
isn't really a manufacturing screen — it's the fleet inventory. Meanwhile `/spu` itself has **no
page at all** (404s; there is no `src/routes/spu/+page.svelte`). The inventory deserves the root
route, and the manufacturing section should open on actual manufacturing work.

## Goal

- The inventory page (as the SPU-INV-01 list view) lives at **`/spu`**.
- **`/spu/mfg` redirects to `/assembly`** — the "SPU Assembly" tab — so entering SPU Manufacturing
  starts you on assembly. All other mfg tabs (Barcodes, Work Instructions, Validation, Servicing)
  stay exactly where they are.

## Changes

1. **New `src/routes/spu/+page.server.ts` + `+page.svelte`** — the inventory load + list view
   (moved from `src/routes/spu/mfg/+page.*`, per SPU-INV-01). Same `spu:read` gate.
2. **`/spu/mfg` becomes a redirect**: `+page.server.ts` load throws `redirect(302, '/assembly')`;
   its `+page.svelte` is deleted. The `mfg/+layout.svelte` (tab strip) stays — `/spu/mfg/barcodes`
   and `/spu/mfg/servicing` still live under it.
3. **`SpuMfgTabs.svelte`**:
   - Remove the "Overview" tab (its page no longer exists in the mfg section).
   - Breadcrumb root "SPU" now links to `/spu` (the inventory) instead of `/`.
   - Fix the current-label fallback so the breadcrumb doesn't claim "Overview".
4. **Top nav (`src/routes/+layout.svelte`)**: add an **"SPU Inventory"** item → `/spu` in the
   Manufacturing group, above "SPU Mfg". Without this the inventory would be unreachable from the
   UI once the Overview tab is gone. The item must match **exactly** `/spu` — the nav's default
   `startsWith(href + '/')` matching would otherwise light it up on every `/spu/mfg/*`,
   `/spu/cleaning`, and `/spu/[spuId]` page (add an `exact` flag to `NavItem`).
   "SPU Mfg" keeps pointing at `/spu/mfg`, which now lands on `/assembly` (already in its
   `sectionPaths`, so the nav highlight stays correct after the redirect).
5. **SPU delete flow** (`src/routes/spu/[spuId]/+page.svelte:348`): after a hard delete it
   currently sends you to `/spu/mfg`; send to `/spu` (the inventory) instead.

## Side effects (intentional / accepted)

- `tests/contracts/07-spu.test.ts:5-9` expects `GET /spu` → 200 with a `spus` page key — that test
  goes from failing to passing. The other seven tests in that file target routes that predate the
  current tree and remain stale (out of scope here).
- Old bookmarks to `/spu/mfg` land on `/assembly` — acceptable; the inventory is one nav click
  away and the redirect matches the new mental model ("mfg starts at assembly").

## Non-goals

- No changes to `/assembly`, `/validation`, `/documents/instructions`, `/spu/mfg/barcodes`,
  `/spu/mfg/servicing`, `/spu/cleaning`, or `/spu/work-instruction` beyond the shared tab strip.
- No touching the orphaned `/spu/servicing/*` ticket routes.

## Acceptance

- `GET /spu` renders the inventory list (was a 404).
- `GET /spu/mfg` 302-redirects to `/assembly`; barcodes/servicing subroutes unaffected.
- Tab strip no longer shows "Overview"; breadcrumb "SPU" leads to `/spu`.
- Nav shows "SPU Inventory" highlighted only on `/spu`; "SPU Mfg" highlights on
  `/assembly`, `/spu/mfg/*`, `/documents/instructions`, `/validation` as before.
- `npm run check` error count at or below baseline.
