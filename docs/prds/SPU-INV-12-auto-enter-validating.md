# SPU-INV-12 — Evidence Drives the Evidence State (Auto-Enter Validating)

**Status:** Approved (Jacob, 2026-09-08)
**Branch:** `feat/spu-tweaks`

Recording ANY validation test result (magnetometer read/poll, thermocouple upload — both paths,
optics sync) automatically flips the unit to `validating`. Flips from draft / assembling /
**servicing** (Jacob explicitly: a test during servicing pulls the unit into validation).
`released` is never demoted by a spot-check; `retired`/finalized untouched. Transition entry +
audit row name the instrument ("magnetometer test recorded — auto-entered validation").

No firmware changes required — the flip fires when BIMS ingests the result. Known latencies
inherit from ingestion: mag flips on poll/manual read; optics flips at sync time (daily cron or
on-demand). Instant pageless mag flips would need a firmware publish (optional future, service-
flag pattern).

Remaining manual discipline: scan a unit onto the servicing board when it's opened (intake
auto-sets servicing) and the deliberate release ceremony (validating → released).

Implementation: `src/lib/server/spu-auto-validate.ts` (best-effort, never blocks the test
write) + hooks in the five writers; `draft → validating` added to LEGAL_TRANSITIONS.
