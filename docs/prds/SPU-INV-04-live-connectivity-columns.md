# SPU-INV-04 — SPU Inventory: Live Particle Connectivity Columns

**Status:** Draft
**Branch:** `feat/spu-tweaks`
**Builds on:** [SPU-INV-01](SPU-INV-01-list-view.md)/[03](SPU-INV-03-column-sorting.md)

## Problem

The floor is used to the Particle console's Devices table: per-device Online/Offline dot,
firmware version, Device OS, and last handshake. The `/spu` inventory shows none of that, so
checking whether a unit is alive means opening the Particle console. The data is one API call
away — `listDevices()` in `src/lib/server/particle.ts` already returns `online`, `last_heard`,
`firmware_version`, `system_firmware_version` for the whole fleet, and the access token is
already stored in the `Integration` collection.

The locally synced `ParticleDevice` collection is NOT a substitute: `syncDevices()` only runs
when someone clicks Sync on `/particle/settings`, so its online/offline status is stale.

## Design

1. **New endpoint `GET /api/particle/status`** (session-auth, `spu:read`): calls `listDevices()`
   and returns `{ devices: { [particleDeviceId]: { online, lastHeard, firmwareVersion,
   systemVersion } }, fetchedAt }`. On Particle API failure returns 502 with an error message —
   never throws HTML.
2. **The `/spu` list fetches it client-side after mount** — the table renders instantly from
   Mongo and the connectivity cells fill in when the call returns. A slow or down Particle API
   must never block or break the inventory.
3. **New columns** (after Status): **Connected** (green dot + "Online" / dim dot + "Offline"),
   **FW** (firmware version), **OS** (Device OS version), **Last Heard** (compact date-time).
   Unlinked SPUs and unknown devices show `—`. While the fetch is in flight, cells show `…`;
   if it fails, a small "Particle unavailable" note appears and cells fall back to `—`.
4. **All four new columns are sortable** via the SPU-INV-03 mechanism (Connected: online first
   ascending; Last Heard chronological; FW/OS string compare; missing values last).

## Non-goals

- No polling/live updates after the initial fetch (refresh the page to re-check).
- No caching layer — one Particle call per page view is well within rate limits.
- No per-device vitals here (that's [SPU-INV-05](SPU-INV-05-device-vitals.md), detail page).

## Acceptance

- `/spu` shows Online/Offline + FW + OS + Last Heard for every linked unit, matching the
  Particle console within one handshake.
- Killing the Particle token (or Particle being down) leaves the inventory fully usable.
- `npm run check` at or below the 11-error baseline.
