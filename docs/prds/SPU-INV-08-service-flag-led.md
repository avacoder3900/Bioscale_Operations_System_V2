# SPU-INV-08 — Service-Flag Yellow LED Sync (BIMS side)

**Status:** Approved (Jacob, 2026-09-02 — "when you release a device the yellow servicing light stops")
**Branch:** `feat/spu-tweaks`
**Spec:** `brevitest-device/firmware/Docs/SERVICE_FLAG_LED_HANDOFF.md` (firmware v88 side DONE,
bench-verified). This PRD implements the BIMS side of that handoff.

## Behavior

Any SPU whose status is not `released` blinks yellow on the device (150 ms pulse / 5 s).
BIMS owns the policy: after every `spu.status` write it pushes the desired `service_flag`
bit (0 when `released`, 1 otherwise) to the device via the existing Particle `callFunction`
plumbing. Post-SPU-INV-07 the released list is exactly `['released']`.

## Implementation (per the handoff spec §3, adapted to the collapsed status flow)

1. **`src/lib/server/service-flag.ts`** — `desiredServiceFlag(status)` and
   `syncServiceFlag(spuId)` exactly as specced: call `set_service`, read back
   `service_flag`, classify the outcome (`synced | unlinked | unsupported | offline | error`
   — `unsupported` = firmware < 88 returning 404), record the outcome on
   `particleLink.serviceFlag*`. Never throws; a device failure never blocks a status write.
2. **Model** — `particleLink` gains `serviceFlag: Number`, `serviceFlagState: String`,
   `serviceFlagSyncedAt: Date`, `serviceFlagError: String`.
3. **Hooks — every status writer calls `syncServiceFlag` after its write + audit:**
   dashboard `updateStatus`; detail-page `transitionStatus`, `updateAssemblyStatus`,
   `openService`, `returnService`; assembly-tab `assembling` write; assembly-complete
   `validating` write; servicing board intake + single close + bulk group close.
   (Particle auto-create is covered by the reconcile below, which runs in the same sync.)
4. **Reconcile (spec §3.3a)** — at the end of `syncDevices()`: for every linked SPU whose
   device is online and whose stored flag ≠ desired (or state is offline/error/missing),
   call `syncServiceFlag`. Closes the "status changed while device was unplugged" gap.
5. **Online webhook (spec §3.3b)** — `/api/particle/webhook` now also handles
   `spark/status` with data `online`: look up the SPU by `particleLink.particleDeviceId`
   and re-sync. (Particle Console must add the `spark/status` webhook with the agent API
   key header — ops step, noted in acceptance.)
6. **UI** — Particle card on `/spu/[spuId]` shows a Service Light row driven by
   `serviceFlagState` (Blinking (not released) / Clear / Pending – device offline /
   Firmware < 88 / No device linked / error text) + a "Resync Light" button
   (`resyncServiceFlag` action).

## Edge cases (from the spec)

- Unlinked SPU → recorded and surfaced as "No device linked", never silently skipped.
- Firmware < 88 (15× v81, 23× v83 as of 2026-09-02) → "Firmware < 88", no retry loop.
- Offline → recorded `offline`; reconcile/webhook resends when it returns.
- `retired` blinks (desired flag 1) — intended: a powered-on retired unit should warn.
- Known state: BT-M01-0000-0243 has flag=1 set manually and is `validating` → stays
  blinking (correct); releasing it is the live acceptance test.

## Acceptance (spec §5)

1. Non-released status → device blinks, SPU shows "Blinking (not released)".
2. Release the SPU → blink stops within one API round-trip; shows "Clear".
3. Power-cycle → LED matches last-sent state (EEPROM, device-side).
4. Status change while unplugged → corrected on next `syncDevices` run or online webhook.
5. v83 device → "Firmware < 88", no exception.
- `npm run check` at or below the 11-error baseline.
