# SPU-INV-05 — SPU Detail: Last Vitals Panel + Working Ping/Rename

**Status:** Draft
**Branch:** `feat/spu-tweaks`
**Companion:** [SPU-INV-04](SPU-INV-04-live-connectivity-columns.md) (fleet status on the list)

## Problem

The Particle console's per-device "Last vitals" panel (cellular signal strength/quality,
operator, access technology, round-trip time, RAM, disconnect events, rate-limited publishes)
is the go-to view for diagnosing a flaky unit. BIMS has nothing equivalent — and the SPU detail
page's Particle panel has **ping and rename buttons that post to `?/pingDevice` and
`?/renameDevice`, neither of which exists** in `+page.server.ts` (the helpers sit unwired in
`src/lib/server/particle.ts:64,70`). Both buttons fail today.

## Design

1. **`getLastVitals(deviceId)` helper** in `src/lib/server/particle.ts` — GET
   `/v1/diagnostics/:deviceId/last` (Particle "last known vitals"). Map defensively with
   optional chaining; device-OS versions vary the payload shape.
2. **New endpoint `GET /api/particle/vitals/[deviceId]`** (session-auth, `spu:read`): returns
   `{ updatedAt, signalStrength, signalQuality, operator, accessTechnology, cellGlobalIdentity,
   roundTripMs, ramUsed, ramTotal, disconnects, rateLimitedPublishes }` — any field may be null.
   502 on Particle failure.
3. **"Last Vitals" section inside the Particle IoT Device card** on `/spu/[spuId]`,
   client-fetched after mount when a `particleLink.particleDeviceId` exists. Mirrors the
   console panel: timestamp, signal strength/quality, operator + access tech + cell identity,
   round-trip time, RAM used of total, cloud disconnects, rate-limited publishes. Fields the
   payload doesn't carry are omitted, not shown as empty. A small refresh icon re-fetches.
   Fetch failure shows one muted line ("Vitals unavailable"), never breaks the card.
4. **Wire the dead buttons** — add to `[spuId]/+page.server.ts`:
   - `pingDevice` (`spu:write`): calls `pingDevice()` helper, returns `{ message }` with the
     online/offline result. No audit entry (no state mutated).
   - `renameDevice` (`spu:write`): validates non-empty name, calls `renameDevice()` helper,
     audit-logs old → new name. Note: device names are what `linkDevicesToSpus` matches/renames
     UDIs from, so renaming is deliberately left to the same rules the sync already handles.

## Non-goals

- No vitals history/graphing (console's "Download history" link covers it).
- No vitals on the `/spu` list (a per-device API call doesn't fit a 70-row table).

## Acceptance

- A linked, online SPU's detail page shows vitals matching its Particle console panel.
- Ping button reports reachability; rename works and is audited.
- Unlinked SPUs and Particle outages leave the page fully usable.
- `npm run check` at or below the 11-error baseline.
