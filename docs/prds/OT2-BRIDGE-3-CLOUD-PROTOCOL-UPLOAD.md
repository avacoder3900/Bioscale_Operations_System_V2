# OT2-BRIDGE-3 — Upload protocols to the OT-2 from the cloud (bridged)

**Date:** 2026-06-15 · **Owner:** Jacob · **Status:** Approved (conversation 2026-06-15)
**Depends on:** OT2-BRIDGE-1 (command bridge), OT2-BRIDGE-2 (on-robot routines)

## Problem

Importing a protocol from the deployed (cloud) app fails with "fetch failed". The
Import endpoint `POST /api/opentrons-lab/robots/[id]/protocols` talks **directly**
to the robot (`robotBaseUrl` → `http://<robot>.local:31950`), which Vercel cannot
reach — unlike sweep/deck-scan/run control, protocol **upload was never bridged**.
Two further gaps surfaced: (a) the bridge command relay (`kind:'http'`) carries
**JSON only**, so it can't move a multipart file; (b) even a successful upload
never wrote `robot.protocols[]` (the array the wax/reagent Start Run panels read),
so an uploaded protocol never appeared on the manufacturing page.

## Design

### New bridge command `kind:'upload_protocol'`
- `Ot2BridgeCommand.kind` enum gains `'upload_protocol'`. `payload = { fileName,
  fileB64 }` (the .py base64-encoded — ~38 KB → ~50 KB, well under Mongo's 16 MB).
- Daemon (`scripts/ot2-bridge.py`) `execute_upload_protocol`: base64-decode →
  multipart `POST localhost:31950/protocols` → get the robot's protocol id → poll
  `/protocols/<id>/analyses` locally (the daemon is on-robot, so this is fast) up
  to 60 s → return `{ opentronsProtocolId, analysisStatus, parametersSchema,
  labwareDefinitions, pipettesRequired }` in the command result body.

### Transport-agnostic upload helper
- `proxy.ts` `robotUploadProtocol(robot, fileName, bytes)`:
  - **bridge:** enqueue `upload_protocol` (ttl 110 s), wait, normalize the result.
  - **direct:** multipart `POST {robotBaseUrl}/protocols` + inline analysis poll
    (same shape) — preserves local-dev behaviour.

### Endpoint writes `robot.protocols[]`
- `POST /api/opentrons-lab/robots/[id]/protocols` calls `robotUploadProtocol`,
  derives `protocolType` from the filename (`wax*`→`wax-filling`,
  `reagent*`→`reagent-filling`, else `other`), upserts the entry into
  `robot.protocols[]` (pull-by-opentronsProtocolId then push), writes an AuditLog,
  and returns `{ opentronsProtocolId, protocolType, analysisStatus }`. So a cloud
  Import now lands the protocol AND makes it appear on the manufacturing page —
  no scripts, no lab Mac.
- `export const config = { maxDuration: 120 }` — the bridged round-trip
  (upload + on-robot analysis) can exceed the 30 s default.

## Out of scope / known limits

- **Custom labware bundling.** This uploads the `.py` only. If a protocol uses
  custom labware not already in the robot's labware store, on-robot analysis may
  be `failed`/`pending` and the param form won't populate. The robots already
  hold the GEN7 custom labware from prior script uploads; if a new labware set is
  needed, push it once via `scripts/upload-local-protocols-to-all-robots.ts` (it
  bundles labware) or the robot's labware store. Bundling labware over the bridge
  is a future extension.
- **Deploy daemon required.** The robots must run the updated `ot2-bridge.py`
  (adds `upload_protocol`). Redeploy + restart the daemon on B07/R04/B14.

## Acceptance

- From the **deployed** app: `/opentrons` → Import → pick robot + a wax `.py` →
  Import succeeds (no "fetch failed"); the protocol appears on the Wax page Start
  Run dropdown tagged `(wax-filling)` with its parameter form populated.
- Direct (local dev) upload still works.
- `npm run check` clean vs baseline; `python3 -m py_compile scripts/ot2-bridge.py`
  clean; 3.7-compatible.
