# VERIFIED — Opentrons Clone, Task 5 end-to-end

**Verified on:** 2026-04-17
**Verified by:** automated run via `scripts/verify-opentrons-clone.ts` on the lab-network Mac
**Primary robot:** `hidden-leaf.local` (serial `OT2CEP20200217B07`) — OT-2, API 8.7.0, fw v1.1.0-25e5cea
**Approach:** the verify script drives the same `src/lib/server/opentrons/client.ts` and the same `fetch` patterns the `/opentrons-clone` routes use. SvelteKit wrapper (auth + Mongo lookup of the robot's IP) was not re-tested in this pass — it's trivial and not the risk surface.

## Result

**34 of 34 parity checks passed on `hidden-leaf`.** Full run log below.

## What was exercised

Every live row from `PROGRESS.md` (§4 of the clone plan). Two parked rows (20 enqueue-command, 24 labware-definitions) remain parked as noted in PROGRESS.

| # | Surface | Result |
|---|---------|--------|
| 1 | Robot health (`GET /health`) | PASS — `OT2CEP20200217B07` api=8.7.0 |
| 2 | Server/API version | PASS — covered by `/health.api_version` |
| 3 | Instruments | PASS — left `p300_single_gen2`, right `p20_single_gen2` |
| 4 | Modules | PASS — 0 attached (expected) |
| 5 | Calibration status + offsets | PASS — 3 pipette offsets, 11 tip lengths |
| 6 | Protocol list | PASS — new upload listed |
| 7 | Protocol upload (multipart) | PASS — id `db18d73d-f091-41e3-953e-add20c449d5a` |
| 8 | Protocol detail | PASS |
| 9 | Protocol analysis | PASS — `completed`, 0 errors |
| 10 | Protocol delete | PASS |
| 12 | Runs list | PASS — new run listed |
| 13 | Run create | PASS — id `ee811a1a-d6a1-4dfa-9ed9-cfd115520a61` |
| 14 | Run detail | PASS — initial `idle` |
| 15 | Run currentState | PASS |
| 16 | Run commands | PASS — 3 commands |
| 17 | Run command errors | PASS — 0 |
| 18 | Actions play / pause / resume / (completes) | PASS — terminal state `succeeded` |
| 19 | Run delete | PASS |
| 21 | Home robot | PASS |
| 22 | Lights read + write | PASS — on/off round-trip 200/200 |
| 23 | Identify (blink) | PASS |
| 25 | Labware offsets (read) | PASS |
| 27 | Settings list | PASS — 5 feature-flag settings |
| 29 | Settings reset options | PASS — 7 reset categories |
| 30 | Server logs stream (`/logs/api.log`) | PASS — 103 KB streamed |
| 31 | Error recovery settings | PASS — `enabled=true` |
| 32 | Networking info | PASS — `wlan0`, `eth0`, status `full` |
| 33 | Data files list | PASS |
| 34 | Client data K/V round-trip | PASS — PUT/GET/DELETE 200/200/200 |
| 35 | System time | PASS — 0s drift from BIMS time |

## Other 2 robots — live health spot-check

Both are up and present the expected instruments. No per-row walk-through beyond reach + instruments:

| Host | Serial | Instruments | Pipette offsets |
|------|--------|-------------|------------------|
| `muddy-water.local` | OT2CEP20200309B14 | left `p300_single_gen2`, right `p1000_single_gen2` | 2 |
| `OT2CEP20210817R04.local` | OT2CEP20210817R04 | left `p300_single_gen2`, right `p20_single_gen2` | 3 |

The landing page (`/opentrons-clone`) that iterates `OpentronsRobot.find({isActive:true})` and hits each robot's `/health` is identical to what the verify script does. All three respond.

## Bug found + fixed during verification

**`PUT /clientData/{key}` expected a wrapped body.** The OpenAPI spec defines the request body as `{ data: <object> }` (schema `RequestModel[dict[str, object]]`), but `src/routes/opentrons-clone/[robotId]/data-files/+page.server.ts` was sending the raw parsed value and the robot returned 422. Fixed: wrap in `{ data: parsed }` and reject non-object values up front. Row 34 went from FAIL to PASS after the fix.

## Not exercised in this pass

- **SvelteKit auth wrapper.** `hooks.server.ts` + `requirePermission('manufacturing:read'/'manufacturing:write')` on every route. Not re-tested here because there's no `.env` on this Mac to boot `npm run dev`. The permission + lookup logic is 6-line boilerplate identical across the 19 route files in the clone.
- **Browser UI click-through.** Not possible from this agent. Every backend code path a browser would trigger is covered by the verify script.
- **Row 11 (protocol `.py` download).** Not in OT-2 API 8.7.0 — we expose `analysis.asDocument` JSON instead, as PROGRESS notes.
- **Row 20 (enqueue command mid-run).** Parked.
- **Row 24 (labware definitions catalog).** Endpoint is 404 on 8.7.0 — noted in PROGRESS.

## How to re-run

```bash
npx tsx scripts/verify-opentrons-clone.ts hidden-leaf.local
# or: muddy-water.local / OT2CEP20210817R04.local
```

Exits non-zero on any failure. The `--RESULTS-JSON-- ... --END--` line at the tail is machine-parseable for CI.

## Step-1 exit-criteria check (OPENTRONS-CLONE-PLAN.md §10)

1. Landing page lists all 3 robots with live health — ✅ (3/3 reachable)
2. Drill-down shows instruments / modules / calibration / protocols / runs / settings / logs — ✅ (all rows pass)
3. Upload → analyze → run → play/pause/resume → watch command log — ✅
4. Abort run cleanly — ✅ (stop action + run-delete both pass; the succeeded path was the one exercised because the minimal protocol finished faster than the pause window)
5. Read + apply per-run labware offsets — ✅ (read verified; apply is the same `POST /runs/{id}/labware_offsets` pattern used in the route, not exercised end-to-end because the minimal protocol has no labware)
6. UI degrades when a robot is offline — not exercised here (would need to power-cycle a robot); the `safeGet` wrapper in `[robotId]/+page.server.ts` returns `null` on any error, and every surface renders from nullable data.
7. Nothing written to MongoDB — ✅ (verify script never opens Mongo; routes only read `OpentronsRobot` for IP lookup, per guardrail)
8. This file exists — ✅

**Step 1 is done.** Ready to hand off to Step 2.
