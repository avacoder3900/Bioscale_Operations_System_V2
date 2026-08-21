# OT2-TAILNET-0 — Plan: direct OT-2 control over Tailscale (queue as fallback)

**Date:** 2026-08-17 · **Owner:** Jacob · **Status:** Approved in conversation 2026-08-17 (this write-up is the record) · **Author:** Claude w/ Jacob & Alejandro

## Why

Every robot verb today — pause, resume, cancel, jog, status, health — goes
`browser → Vercel → Mongo (Ot2BridgeCommand) → robot's long-poll → robot API → Mongo → browser poll`.
It works, but the interactive verbs feel laggy (1–2 s best case, a missed poll
cycle worst case), and the ambiguity of "did the pause land?" has already
cost us three fixes in `EmbeddedRunController.svelte` (auto-resume racing
operator pauses, "bridge slow" banners, held clocks — see progress.txt
2026-08-06).

The CV capture stations already solved this shape: the Pi is on the tailnet,
`tailscale serve` terminates TLS, and the **operator's browser talks to the
device directly** while Vercel stays the system of record. Robots should work
the same way. It still feels 100% like BIMS — same pages, same buttons, same
records — only the browser's request path changes.

## Decisions (Jacob, 2026-08-17)

1. **Keep the OT-2 Pis modified** (bridge daemon stays for the serial gantry
   scanner, sweeps, deck-scan). Add Tailscale to each Pi. No new hardware.
2. **The lab Mac stays as-is** (jump box / Opentrons App). No gateway box for
   now — see `LAB-GATEWAY-1-DEFERRED.md` for the consolidation we're *not*
   doing yet and when it becomes worth it.
3. **Hybrid transport in BIMS:** direct browser→robot over the tailnet when
   reachable; existing `Ot2BridgeCommand` queue otherwise. Non-tailnet
   machines keep working at today's speed.
4. **Durable records still go through BIMS.** Start Run stays on the queue
   (audited, durable). Pause / resume / cancel / status / jog / health go
   direct first.
5. **Auth is the tailnet.** The Opentrons API on :31950 has no auth. Tailnet
   ACLs (`tag:ot2` reachable only from `tag:lab-workstation`) are the control;
   robots stay off the public internet (no Funnel).

## Work breakdown

| PRD | What | Where the work is |
|---|---|---|
| `OT2-TAILNET-1-PI-PROVISIONING.md` | Tailscale on each OT-2 Pi (B07 → R04 → B14), `tailscale serve` for HTTPS, ACLs, persistence across Opentrons updates | lab (SSH), Tailscale admin console, `scripts/` |
| `OT2-TAILNET-2-DIRECT-CONTROL.md` | BIMS: `directUrl` on `OpentronsRobot`, client-side robot client with reachability probe + queue fallback, wire into run controller / jog / health | `src/lib/opentrons/…`, `EmbeddedRunController.svelte`, admin robots page |
| `LAB-GATEWAY-1-DEFERRED.md` | Not now: consolidated gateway + printer job queue for server-initiated work | — |

## Order of operations

1. **TAILNET-1 on B07 only.** Verify from a lab workstation:
   `curl https://<b07>.<tailnet>.ts.net/health` (Opentrons-Version header)
   returns robot health. Bridge daemon untouched and still heartbeating.
2. **TAILNET-2 behind a per-robot flag** (`directUrl` unset = today's behaviour).
   Set it for B07, test pause/resume/cancel/status on a real reagent run from
   a tailnet machine and from a non-tailnet machine (fallback path).
3. Roll TAILNET-1 to R04, B14; set `directUrl` for each.
4. Retire nothing. The queue stays as the fallback and the durable path.

## Non-goals

- Replacing `Ot2BridgeCommand` or the on-robot daemon.
- Exposing robots publicly (Funnel/Cloudflare) — server-initiated robot
  control stays on the queue.
- Moving the gantry scanner off the robot.
- Any change to the `opentrons-clone` operator UI stack (direct-only already;
  it can adopt the same client later).

## Risks

- **Mixed content:** BIMS is https; the robot API is http. Direct calls MUST
  go through `tailscale serve` (https 443 → localhost:31950) or the browser
  blocks them. Same as the CV Pis. (TAILNET-1)
- **CORS:** robot-server is FastAPI with permissive CORS in the versions
  we run, but confirm on B07 before building TAILNET-2 (`OPTIONS` preflight
  with `Opentrons-Version` header). If it isn't permissive, `tailscale serve`
  cannot add headers — fallback is a 20-line reverse proxy on the Pi
  (`python -m http.server`-class) that injects them. Decide during TAILNET-1.
- **Persistence:** Opentrons OS updates can wipe `/data`. Same exposure the
  bridge already has; the runbook's post-update checklist covers both.
- **ACL mistakes:** a too-broad ACL lets any tailnet member move a robot.
  ACL diff is part of the TAILNET-1 acceptance.
- **Two writers:** browser calls robot directly AND must report to BIMS. If the
  BIMS write fails after the robot acted, the run record can drift. TAILNET-2
  keeps the robot as source of truth for live status (poll it), and BIMS only
  records *intent* + terminal state; drift is bounded to what it is today.

## Acceptance (whole plan)

- On a tailnet workstation: pause → robot reports `paused` in ≤ 500 ms and the
  UI reflects it without a "bridge slow" banner. Resume/cancel same.
- On a non-tailnet machine: same buttons work via the queue, UI shows a small
  "direct link unavailable — using queue" note, no functional regression.
- Start Run still creates the same records/audit as today.
- Bridge daemon heartbeats, sweeps and deck-scan unchanged on all three robots.
- No robot reachable from a tailnet node without `tag:lab-workstation`.
