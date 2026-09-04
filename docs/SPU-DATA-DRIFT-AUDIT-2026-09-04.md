# SPU Data-Architecture Drift Audit — 2026-09-04

Question asked: the Spu doc is meant to be the sacred final record with everything appended;
has it drifted as features were added? (1) What data lives in other documents and never reaches
the Spu? (2) Where does each experiment's validation data live?

Method: exhaustive code sweep + read-only Atlas audit (`scripts/diag-spu-validation-drift.ts`).
Production numbers as of 2026-09-04: 74 SPUs; 658 validation_sessions; 4 validation_runs (all
in_progress, 12 member units); 24 service_records; 2664 device_events; 2343 webhook_logs;
44 device_crashes; 217 audit_logs. 15 of 52 distinct spuIds referenced by validation sessions
belong to hard-deleted SPUs (orphaned experiment data).

---

## Verdict

Yes — the record has drifted, materially. The Spu doc holds thin rollups; the substance of what
happened to a unit lives in satellites, and several of the paths meant to copy data onto the Spu
are broken or were never built. The detail page *looks* complete because it joins satellites at
read time; the doc itself is not a DHR. And two display surfaces are outright broken (audit
trail, assembly signature) — history exists in the DB but never renders.

---

## Broken today (bugs, not philosophy)

1. **The SPU audit trail is ALWAYS empty.** `[spuId]/+page.server.ts:26` queries
   `AuditLog.find({ entityId })` sorted by `createdAt` — but zero audit rows have `entityId`
   (writers use `tableName:'spus', recordId`) and the schema has `changedAt`, not `createdAt`.
   87 SPU audit rows exist in prod and never display. Fix is one line (+ fix `changedBy`
   resolution at `:246`, which maps by user _id while writers store usernames).
2. **The assembly e-signature never appears in the signatures list.** It's created with
   `entityId: sessionId` while the page queries `entityId: spuId`. Also: `dataHash` is written
   as `''` everywhere (never computed), and the detail-page signature path reads a password but
   only checks presence, never verifies it.
3. **Magnetometer failures never reach the Spu** — the rollup write sits inside
   `if (overallPassed)` (`validation/magnetometer/+page.server.ts:111`); a failed unit shows
   `pending` forever. The auto-poll endpoint (the path actually used) writes NO Spu rollup at
   all.
4. **Magnetometer override writes are half-lost**: status `'overridden'` isn't in the enum
   (lands anyway via updateOne) and `overriddenBy/At/overrideReason` aren't in the schema →
   silently stripped. The UI renders "Override by admin" with no reason, always. Truth lives
   only in `validationSession.override`.
5. **Thermocouple run uploads are permanently half-written**: `STANDARD_THERMO_CRITERIA` is
   hardcoded `null`, so run-path uploads write sessionId/rawData/results but never
   status/completedAt/criteriaUsed; the run cell parks at `uploaded` and Evaluate is disabled.
   The legacy JSON path writes nothing to the Spu. The thermocouple API's audit rows use a
   foreign field shape → persist as null-keyed rows with no payload.
6. **Optics "View Session" links 404**: `validation.spectrophotometer.sessionId` holds a
   cartridge barcode (no session exists for optics); the UI builds
   `/validation/spectrophotometer/<barcode>`, a route that doesn't exist.
7. **`spu.validation.status` (overall rollup) has zero writers** — read in six places, always
   `'pending'`. The detail-page header badge lies.
8. Dead schema branches on the Spu: `lux` (no instrument integration exists), `location` (zero
   writers — real location lives on ServiceRecord.locationHistory), `corrections[]` (the
   documented corrections doctrine is implemented nowhere), `voidedAt` read by the agent API but
   no longer on the schema.

## Where each experiment's validation data lives

| Modality | Run record (satellite) | What reaches spu.validation | What never reaches the Spu |
|---|---|---|---|
| Magnetometer | validation_sessions (type mag/magnetometer; 474 failed + 139 completed in prod) | pass-only, manual-read path only | failures, every auto-poll session, raw device strings, per-well values, override attribution, retries |
| Thermocouple | validation_sessions (thermo) + one-off inline spu.attachments CSVs | partial (no criteria configured): sessionId/rawData/results, no status | full readings, 4-channel stats, raw XLSX blob, SVG charts, criteria snapshot, interpretation |
| Spectrophotometer / optics | cartridge_records (+ optical_test_cartridges, cartridge_groups) — NO validation session | rollup incl. failures, but only via cron/agent sync; sessionId = cartridge barcode | all-but-latest runs (one unit has 15), actual thresholds used (only profileName recorded — re-sync re-judges history), group/cohort analysis; cartridges carry no spuId (matched by device.name == UDI string) |
| Lux | — | never (dead branch) | — |
| Validation runs | validation_runs (membership, per-step cells, evaluations, retries, notes) | only status+completedAt for mag/thermo cells | run membership/runId, optical_confirmation outcomes entirely, evaluations, notes, skips, retry chains, completeRun/abortRun/removeSpu leave no trace on any member |

## Data about a unit that never reaches its Spu doc

(a)=embedded, (b)=referenced by id, (c)=disconnected (findable only by querying the satellite)

- **ServiceRecord/ServiceGroup (the servicing board): (c) — the largest drift.** The board
  writes only status/transitions, parts[] replacement flags, and the LED flag onto the Spu.
  Never reaching it: findings[], notes, location + locationHistory, serviceType/priority/
  assignee, firmwareChanges[] (firmware history exists NOWHERE on the Spu), otherChanges[],
  group context, resolution, closedBy/At — not even the record's _id. The inline
  spu.serviceRecords[] (detail-page quick flow) and the board are two parallel systems that
  can't see each other: board jobs are invisible on the Full Document tab, and
  validationPhase() mis-buckets validations on board-serviced units.
- **ValidationRun: (c)** — no runId/membership on the Spu; only ValidationSession.runId (thermo
  only) gives a two-hop path.
- **AssemblySession: (b) + lossy (a)** — the completion snapshot silently drops
  workInstructionStepId, signatureId, notes, stepFieldDefinitionId, **bomItemId (the BOM
  traceability link)**, and all scan timestamps (strict-mode stripping). Prod: 0 of 74 SPUs
  have an assembly snapshot (only 2 assembly sessions exist yet). Dead code renders an
  always-empty scanned-parts list on the completion page.
- **Device telemetry (DeviceEvent/Log/Crash/WebhookLog): (c)** — keyed by particleDeviceId,
  and three of four collections TTL-delete after 30 days; nothing (crash counts, firmware,
  last-heard) is ever summarized onto the Spu. `unlinkParticle` $unsets the whole particleLink,
  destroying the fields designed to preserve unlink history. ParticleDevice.linkedSpuId reverse
  pointer exists but is never maintained.
- **CartridgeRecord.testExecution.spu: one-directional** — external cloud embeds a mini-DHR of
  the SPU into each cartridge run, but the Spu has no testsRun[]/cartridge list/count; and the
  optics sync matches by device.name==UDI while the index serves testExecution.spu._id.
- **InventoryTransaction: (c)+** — has an spuId field (29 rows use it) but the assembly-scan
  writer never sets it; the SPU id rides in a free-text reason string.
- **ProductionRun / BomItem / OpticalTestCartridge: (c)** — OpticalTestCartridge.usageLog has
  spuId/validationSessionId fields with no writers.
- **On-doc and healthy:** journal[] (all 74 units), statusTransitions[] (two writers skip the
  push: dashboard updateStatus, updateAssemblyStatus), particleLink.serviceFlag*, signature
  embed (8 units).

## The sacred-philosophy core tension

`finalizedAt` is never set anywhere — so the entire sacred guarantee today is "deletes blocked
at the model layer," and even that is bypassed: the detail page has a Delete SPU button using
`Spu.collection.deleteOne` (which is how 15 SPUs' validation sessions got orphaned), and the
service flows use raw collection writes to get past the middleware. Crucially, the middleware
has no notion of "finalized but still appendable" — freezing a doc would also freeze journal,
service history, and corrections, which is exactly why every escape hatch bypasses sacredness
entirely. Any fix plan has to resolve appendability-under-finalization first.

## Recommended fix order

1. **A — audit-trail query fix** (one line + changedBy resolution): restores 87 existing rows.
2. **B — signature keying** + compute dataHash + verify password.
3. **D/E — magnetometer failures + poll rollup + override schema fields.**
4. **G — decide thermo criteria** (configure or remove the gate).
5. **F — optics key honesty** (cartridgeId field or real session; snapshot actual thresholds).
6. **C — service-close appends a snapshot onto the Spu** and unify the two servicing systems.
7. **B(runs) — completeRun snapshots per-member results onto the Spu** (only place optical
   outcomes can land); stamp runId at membership.
8. **H — compute validation.status; I — snapshot firmware at milestones; J/K — make location
   and corrections real or delete them; L — widen the assembly snapshot schema.**
9. **M — set finalizedAt at release**, after defining an append-whitelist in the sacred
   middleware (journal, serviceRecords, validationRuns, corrections, statusTransitions stay
   appendable post-finalization; everything else freezes).

Full file:line detail for every claim lives in the 2026-09-04 census (session record); the
diag script is re-runnable read-only.
