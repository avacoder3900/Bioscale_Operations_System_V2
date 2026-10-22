# OT2-TAILNET-6 — Run integrity 2: the code-side fixes from the 2026-10-07 connection audit

**Author:** Alejandro (via Claude Code)  **Date:** 2026-10-07  **Status:** Building (S1–S5 on `feat/ot2-run-integrity-2`)
**Parent:** `docs/OT2-TAILNET-CONNECTION-AUDIT-2026-10-07.md` (findings A1–A5, B1–B9). **Depends on:** TAILNET-4/5 on master.
**Independent of:** the Ethernet change (audit §6 step 1), which is hardware and fixes a different layer.

---

## 1. Problem

Five days after Tailscale became the default line for all three OT-2s, R04 "hung" during a reagent start
(2026-10-07, 16:26–16:42 UTC). The audit traced it to BIMS code, not the tunnel:

1. `POST /runs` takes 15–30 s on a Pi 3 and the browser aborted at 30 s. Half of all creates in 14 days ran
   within 5 s of that limit; five lost the answer. A lost create is `NO_RETRY`, so the page fell back to the queue
   and the robot kept an unconfirmed run.
2. The start sequence ran twice (no `submitting` guard on the fill pages' auto-start; the server only refused a
   second prepare once a run id existed). Two concurrent `POST /runs` → `RunConflictError` 500 → "Failed to
   fetch" in the browser → a second failover.
3. After the failover the page could not recover for 30 minutes: `tryRecover` refused while a stale "busy"
   entry (a `/bridge` gantry job the tab never saw finish) was set; those expire at `BRIDGE_BUSY_MAX_AGE_MS`.
4. A tab open since 10-04 polled a wax run that finished on 10-05, through the queue, ~10,000 times in 36 h,
   on the daemon's single worker. Queue commands carried no `requestedBy`, so the machine could not be found.

## 2. Goals

- A start never issues a second `POST /runs` while one is in flight, on either line.
- A create whose answer is lost adopts the run the robot made instead of failing the start.
- The page leaves the direct line only when the robot is unreachable, and it comes back on its own.
- A finished run stops costing robot requests; every queue command names who asked for it.

## 3. Non-goals

Per-line timeouts on the run controller (audit B2), the daemon's read-only lane and `trigger_loop` retirement
(B1, B6), moving the run lifecycle into the daemon (audit §5). Those are the next PRD.

## 4. Stories

| ID | Story | Where | AC |
|---|---|---|---|
| **S1** | `run.create` posts with a 90 s timeout (`CREATE_RUN_TIMEOUT_MS`); a lost answer carries `noAnswer: true`. `startRunSequence` then calls `findCreatedRun`: for up to 60 s, poll `run.list`; adopt the **current** run only if it is `idle`, on our protocol, and its `runTimeParameters` match what we sent (`rtpMatches`). Otherwise the start stays `uncertain` for the load reconcile, as before. | `ot2-protocol.ts` | Unit: timeout on the POST; `noAnswer` on a thrown POST; adoption happens once, never a second `run.create`; a stale idle run (other RTP), a running run, or another protocol is not adopted. |
| **S2** | Re-entry guard: `startRunWithCapturedParams` returns while `submitting` (wax + reagent). Server: `startPrepare` refuses (409) a prior intent younger than `START_INTENT_IN_FLIGHT_MS` (3 min) that has no run id and is not uncertain, naming who requested it. | fill pages, `run-lifecycle-records.ts` | A second `onComplete` during a start is a no-op; a second prepare from another tab within 3 min is refused with the requester's name. |
| **S3** | `RobotSession`: `tryRecover` ignores `busy` (busy gates motion verbs only). Before falling back on a thrown fetch, probe `/health` (1.5 s). If the robot answers: a retry-safe verb is repeated once directly; a `NO_RETRY` verb (and any raw mutation) answers 502 `{noAnswer: true}` without leaving the line. Only a failed probe falls back. | `direct-client.ts` | Unit: retry-safe verb retried once, session stays direct; `run.create` → 502 `noAnswer`, one POST, stays direct; recovery works with a busy job present; a dead line still falls back as before. |
| **S4** | `EmbeddedRunController` polls three more times after a terminal status, then stops. | `EmbeddedRunController.svelte` | A finished run's tab makes no further robot requests after ~3 ticks. |
| **S5** | `requestedBy` on every queue command: `withRequester()` (AsyncLocalStorage) in `proxy.ts`; set by `verbResponse`, the relay, the `run.get` / `run.action` routes and the load reconcile. | `proxy.ts`, `transport.ts`, `relay.ts`, routes, RLR | `ot2_bridge_commands.requestedBy` is the signed-in user (or `<user> (reconcile)`). |
| S6 (next) | Per-line, per-verb timeouts and messages in the run controller; `/opentrons/connectivity` shows per-robot queue load and the top requesters. | | |

## 5. Risks

- **Adoption picks a stale run.** Guarded by `idle` + protocol + full RTP match; identical params on a lingering
  idle run would be adopted, which is the equivalent run anyway (and `clearStaleProtocolRun` removes such runs
  on the next maintenance open).
- **The 3-minute in-flight refusal blocks a legitimate retry** after a start died between prepare and create
  without posting a `failed` confirm. The sequence always posts one (`failStart`), and the page-load reconcile
  clears intents older than 8 minutes; worst case the operator waits 3 minutes or reloads.
- **The `/health` probe adds up to 1.5 s** to a genuinely dead line before the fallback. Acceptable: it replaces
  a 30-minute wrong-line episode.

## 6. Validation

1. `npm run test:unit`: 557 pass; the one failure (`sonic.test.ts`) is a missing `@audio/decode-wav` package in
   the local environment, unrelated.
2. `npm run check`: 16 errors = master's baseline; none in touched files.
3. Hardware (next session): on R04 over the tailnet, start a reagent run and confirm one `POST /runs` in
   `ot2_direct_calls`; pull the robot's Ethernet mid-poll to confirm fallback and the 30 s recovery; leave a
   finished run's tab open and confirm the queue goes quiet.
