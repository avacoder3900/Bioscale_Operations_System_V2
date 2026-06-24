# PRD List: OT-2 Embedded Run-Control Reliability (Pause / Resume / Stop)

Operators report the **Pause / Resume / Stop** buttons on the wax & reagent fill
run screens are "spotty" — clicks don't register, throw errors, or the buttons
grey out. Runs are driven from the **deployed app (Vercel)**, so every status
poll AND every control action goes through the **OT-2 bridge** (the daemon
executes one command at a time per robot).

All controls live in one shared component:
`src/lib/components/manufacturing/EmbeddedRunController.svelte` (used by both
wax-filling and reagent-filling), calling
`POST /api/opentrons-lab/robots/[id]/runs/[rid]/actions`.

## Root causes (from investigation 2026-06-24)
1. **Stale-status gating.** `canPlay/canPause/canStop` derive from the last poll
   (≥2s stale, more over the bridge). The protocol pauses/resumes itself mid-run,
   so the UI's state lags the robot → a click lands while the OT-2 is in a
   different state → robot 4xx → shown as a 502 "error" → looks broken.
2. **Poll/action queue contention.** Status polls (every 2s) and control actions
   share the single serialized bridge queue; an action can sit behind an in-flight
   poll or expire (30s TTL) → silent no-op.
3. **Optimistic-UI revert/flicker.** A poll already in flight overwrites the
   optimistic status set on click → button flickers back → looks ignored.
4. **Unhandled statuses disable everything.** `finishing`,
   `blocked-by-open-door`, `awaiting-recovery`, `stop-requested` aren't handled →
   all buttons (incl. Stop) grey out when they shouldn't.
5. **No fetch timeouts.** A slow/hung bridge call leaves `actionInFlight` set,
   disabling all buttons (up to 30s); the poll cadence also stretches because the
   next tick is scheduled only after the awaited fetch resolves.

---

## PRD 1 — Stop always works; relax action gating
- **Stop** is enabled in ANY non-terminal state (the operator must always be able
  to abort). Only disabled once the run is `succeeded/failed/stopped`.
- **Pause** enabled when `running`; **Play/Resume** enabled in any live
  non-`running` state (idle/paused/blocked-by-open-door/awaiting-recovery).
- Stop is confirm-gated (keep the existing confirm).
- Acceptance: in `finishing`/`blocked-by-open-door`/`awaiting-recovery`, Stop is
  clickable; no live state greys out all three.

## PRD 2 — Treat state-conflict rejections as benign, reconcile by re-poll
- The OT-2 rejects an action invalid for its current state (e.g. Pause when
  already paused). On any non-OK action response, immediately **re-poll** to sync
  the UI to the robot's true state instead of surfacing a red error.
- Distinguish a genuine failure (offline/bridge timeout) from a state conflict:
  pass the robot's HTTP status from the endpoint; only show an error banner for
  real failures, otherwise a soft "robot was {status} — synced" note that clears
  on the next poll.
- Endpoint tweak (`runs/[rid]/actions/+server.ts`): include the robot's HTTP
  status code + detail in the response body so the client can classify.

## PRD 3 — Kill the optimistic-flicker (sticky requested state)
- While an action is in flight (and briefly after), polls must NOT overwrite the
  optimistic status with an older reading. Apply poll results to `runStatus` only
  when no action is pending; after an action resolves, do one immediate
  reconcile poll and resume normal polling.

## PRD 4 — Decouple polling from control (reduce bridge contention)
- **Pause status-polling while an action is in flight** so the action isn't stuck
  behind a poll in the serialized bridge queue; poll immediately once it returns.
- Schedule polling on a **fixed cadence** that doesn't stretch when a fetch is
  slow. Consider a slightly longer `pollMs` during a run to lighten the queue.

## PRD 5 — Timeouts + full status handling
- Add an **AbortSignal.timeout** to both the poll and action fetches so a hung
  bridge call can't freeze the loop or lock the buttons.
- Add `finishing`, `blocked-by-open-door`, `awaiting-recovery`, `pause-requested`,
  `stop-requested` to `statusColor()` and the `RUNNING`/enable sets.
- Clear `actionInFlight` defensively on timeout so buttons re-enable.

## Out of scope
- Per-command bridge priority (a deeper daemon change). PRD 4 mitigates contention
  client-side without touching the daemon.
- The `currentCommand` display reads the action history, not the live protocol
  command — cosmetic, tracked separately.

## Validation
- `npm run check` stays at the 11-error baseline; build green.
- On the deployed app against a live B07/R04/B14 run: Pause→Resume→Stop each take
  effect within ~1 poll; no red error on a benign state conflict; Stop always
  available mid-run; buttons never lock for >timeout.
