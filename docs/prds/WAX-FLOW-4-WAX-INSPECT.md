# WAX-FLOW-4 — Wax Inspect: first inline CV deployment

**Date:** 2026-06-11 · **Owner:** Jacob · **Status:** Approved (conversation 2026-06-11)
> **Shortcut 2026-08-17 by WAX-SIMPLIFY-2:** the inline-CV verdict path is parked (page stays
> reachable at `/wax-inspect` but is out of the menu; nothing is deployed at `wax_filled`).
> Wax QC is visual-only for now — rejects go through the new Wax Reject page. Bring this back
> when a model is ready.

## Intent (Jacob)

"We've been building all this CV stuff — we want to deploy our first model in line for every
single cartridge after they come off wax filling." New side-menu page
`/manufacturing/cart-mfg/wax-inspect` where each wax-filled cartridge is photographed and the
deployed model's verdict is shown to the operator immediately.

## What already exists (reuse, don't rebuild)

- Phase `wax_filled` is canonical (`capture/+page.server.ts:15-23`).
- `POST /api/cv/capture` fires `runPhaseInference()` fire-and-forget for every CvProject with
  `deployAtPhases` containing the phase and a non-null `activeModelVersion`
  (`run-inference.ts`, `api/cv/capture/+server.ts:132-138`). Shadow model A/B included.
- Verdicts land as CvInspection docs (`result: 'pass'|'fail'`, `confidenceScore`, `defects[]`)
  queryable via `GET /api/cv/inspections?imageId=...`.
- Capture sources: Pi WebRTC stations (CaptureStation model, JWT mint, station lock) and USB
  camera, both proven on `/capture`. Hardware-scanner sticky-context pattern proven there too.

## Page spec

`/manufacturing/cart-mfg/wax-inspect` (permission `manufacturing:read` to view,
`manufacturing:write` to capture):

1. **Sticky scan context** — autofocused hidden input receives barcode wedge; scanning a
   cartridge locks context. Cartridge must exist with status in
   `['wax_filling','wax_filled','wax_stored']` (coming off wax fill); otherwise show a reject
   banner.
2. **Video pane** — station dropdown (Pi WebRTC, reuse `/capture` station select + token/lock
   flow) with USB-camera fallback.
3. **Capture** — Space/button snapshots the frame, POSTs `/api/cv/capture` with
   `phase: 'wax_filled'`. Response returns imageId; page polls
   `/api/cv/inspections?imageId=` until the inspection completes (or 30 s timeout →
   "inference pending" state).
4. **Verdict banner** — PASS (green) / FAIL (red) + confidence + model version; FAIL lists
   defects. Shadow-model results shown subtly (small caption), never as the operator verdict.
5. **Session feed** — table of this station's recent wax_filled inspections (thumbnail,
   cartridge id, verdict, confidence, operator, time), latest first, server-loaded last 50 +
   prepended live as captures happen.

## Out of scope (this PRD)

- Auto-advancing cartridge status or blocking QC on a FAIL verdict — the model is advisory in
  v1; wax QC accept/reject stays human. Revisit once the model has a track record.
- Training/labeling UX (exists under /cv).

## Config prerequisite (not code)

A CvProject must have `deployAtPhases: ['wax_filled']` and a promoted `activeModelVersion`,
else captures save but no inference fires. Page shows a yellow "no model deployed at
wax_filled" notice when no such project exists (server load checks).

## Acceptance

- Scan → capture → verdict round-trip works on a deployed model; feed updates live.
- No model deployed → captures still save, notice shown, no errors.
- Menu entry present (per WAX-FLOW-1). `npm run check` clean of new errors.
