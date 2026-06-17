# LABWARE-LIBRARY-AUTO-BUNDLE — BIMS-managed custom labware, bundled on every robot upload

**Date:** 2026-06-15 · **Owner:** Jacob · **Status:** Approved (conversation 2026-06-15)
**Depends on:** OT2-BRIDGE-3 (cloud protocol upload)

## Problem

Cloud-uploaded protocols (OT2-BRIDGE-3) ship only the `.py`. The OT-2 resolves a
protocol's *custom* labware from what was **bundled with the upload** (not from any
global store), so a protocol using custom labware fails at run time with
`loadLabware ... Labware "<name>" not found` (e.g. the wax protocol's
`cosmas_and_damian_drybath_tuberack`). Today custom labware lives only on the lab
Mac (`~/Library/Application Support/Opentrons/labware/`); BIMS has no copy.

Goal: manage custom labware in BIMS as a first-class entity (cloud-uploaded, like
Opentrons' custom-labware manager), and **automatically bundle the library with
every protocol upload to a robot** — which is exactly how Opentrons connects a
protocol to its labware for a run.

## Design

### Data: `LabwareDefinition` model (`labware_definitions`)
`{ _id, namespace, loadName, version, displayName, category, definition (full JSON),
fileName, uploadedBy, createdAt, updatedAt }`. Unique index `(namespace, loadName,
version)` — re-uploading the same def upserts.

### Seed (one-time)
Import the 33 existing lab-Mac defs into BIMS (`scripts/seed-labware-from-local.ts`,
run on the lab Mac). After this BIMS holds the full library.

### API `/api/opentrons-lab/labware`
- `GET` — list defs (loadName, namespace, version, displayName, category).
- `POST` (multipart `labwareFile`, .json) — parse + upsert; AuditLog.
- `DELETE ?loadName=&namespace=&version=` — remove a def; AuditLog.
All `requirePermission('manufacturing:write'|'read')`. Works from the cloud.

### Auto-bundle on protocol upload (the core)
`proxy.robotUploadProtocol(robot, fileName, bytes)` loads every `LabwareDefinition`
and includes them with the protocol:
- **bridge:** command `payload.labware = [{ fileName, b64 }]`; daemon
  `execute_upload_protocol` decodes each and adds it to the multipart `files`
  (alongside the `.py`) in its `POST localhost:31950/protocols`.
- **direct:** append each def as a Blob to the FormData.
The robot analyzes/runs with the labware available → resolves. (Bundling the whole
library is what the Opentrons desktop app does; harmless if a def is unused.)

### Daemon
`scripts/ot2-bridge.py` `execute_upload_protocol` gains an optional `labware`
list in the payload; redeploy to B07/R04/B14.

## Out of scope (phase 2)
- Management UI: rework `/opentrons/labware` to read from `labware_definitions` +
  Import modal + delete (currently it aggregates from robot protocols, read-only).

## Acceptance
- Labware can be uploaded/listed/deleted in BIMS from the cloud (API).
- A cloud protocol Import now bundles the library; a protocol using custom labware
  analyzes clean and **runs past `loadLabware`** with no manual robot prep.
- `npm run check` clean vs baseline; build green; daemon `py_compile` clean.
