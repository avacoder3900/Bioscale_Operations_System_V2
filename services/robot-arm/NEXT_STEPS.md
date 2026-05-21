# Robot Arm — State + Next Steps

Snapshot as of 2026-05-21, branch `feature/arm-protocols` (off `dev` at `d3cf5af`).
Captures everything queued for the arm work so the next session can pick up
without spelunking through chat history.

> **2026-05-21 backlog sweep — shipped on this branch:**
> #1 driver `_check` (on `dev` as 1f7daa3, not yet on `feature/arm-protocols`);
> #2 fcntl serial port lock; #3 chip-serial port auto-resolve;
> #6 periodic liveness probe (`/health` reflects last probe); #7 webhook
> queue + retry/backoff. **Provenance gateway**: recording sidecar
> (`.meta.json`) + `RobotArmRun.{lotId, manufacturingStep,
> recordedDuringRunId}` + webhook stamping. **Pre-flight**:
> `POST /replay/preflight` + opt-in `enforce_preflight` on `/replay/start`.
> **Wax pilot scaffold**: `WaxFillingRun.armRunId` + `POST
> /api/robot-arm/trigger-replay` that ties an arm replay to a wax (or
> generic) parent and stamps the back-ref. **Lot view**: `GET
> /api/robot-arm/runs-for-lot?lotId=...` returns BIMS runs joined with
> Pi-side recording sidecars. **Still open**: items below.

---

## What works today

End-to-end leader-follower teleop on the Mac:

- **Hardware**: SO-100 / SO-ARM100 leader + follower, both 6× STS3215 servos
  at IDs 1–6, 1 Mbps on a Feetech CH9102 USB serial bridge each.
- **Stack**: `services/robot-arm/` — Python driver (sync read/write),
  FastAPI server on `:8765`, `LeaderFollowerSession` runs in a daemon
  thread polling leader → writing follower at 30 Hz.
- **BIMS integration**: `/manufacturing/robot-arm/control` page (Phase A
  code already on `dev`) talks to the FastAPI server via the existing
  `robot-arm-client.ts`. Webhook events fire to
  `/api/robot-arm/webhook` — `RobotArmRun` documents land in MongoDB.
- **Three modes verified end-to-end**:
  - `teleop` — leader → follower live mirror
  - `record` — same + JSONL frames to `~/.bims-arm/recordings/<name>.jsonl`
  - `replay` — read JSONL + drive follower at captured cadence
- **Multi-turn wrist** (joint 5, regularly reads > 4095) handled with
  `% 4096` — follower mirrors the angular position within the current
  rotation.

## Operational runbook

### Env vars (in `.env` at repo root)

```
LEADER_PORT=/dev/cu.usbmodem5C4C1269591
FOLLOWER_PORT=/dev/cu.usbmodem5C4C1280501
BIMS_WEBHOOK_URL=http://localhost:5177/api/robot-arm/webhook
ROBOT_ARM_BASE_URL=http://127.0.0.1:8765
ROBOT_ARM_API_KEY=local-dev
AGENT_API_KEY=<shared with BIMS>
```

### Starting both servers

```sh
# Terminal 1 — BIMS dev
set -a; source .env; set +a
npm run dev -- --port 5177

# Terminal 2 — arm FastAPI
cd services/robot-arm
set -a; source ../../.env; set +a
.venv/bin/uvicorn server.app:app --app-dir src --host 127.0.0.1 --port 8765
```

### Standalone diagnostics (require FastAPI stopped — they grab the serial bus)

```sh
cd services/robot-arm
.venv/bin/python scripts/ping_servos.py --port /dev/cu.usbmodem...   # scan a bus
.venv/bin/python scripts/teleop_cli.py                                # type-cmd REPL
.venv/bin/python scripts/teleop_keyboard.py                           # realtime keyboard (one arm)
```

---

## Known issues / fragile spots

| # | Issue | Severity |
|---|-------|----------|
| 1 | `ArmDriver._check()` treats non-zero servo status bytes (e.g. OVERLOAD `0x20`) as fatal even on successful writes. Hit during follower recovery on 2026-05-21. Need to split comm errors from informational status. | medium |
| 2 | No exclusive file-lock on `/dev/cu.usbmodem*`. Two processes can open the same port and silently clobber each other's writes. Should use `fcntl` advisory lock. | medium |
| 3 | `LEADER_PORT` / `FOLLOWER_PORT` env vars hardcoded to specific chip serial nums. If a cable reseats, the device may get a different node and the server won't auto-pick it up — requires manual `.env` edit + restart. | low |
| 4 | No calibration offset between leader and follower. If their zero-points aren't physically identical, the follower mirrors with a per-joint constant offset. Workaround: align them physically before each session. | low |
| 5 | Multi-turn wrap on joint 5 creates a follower "snap" of a full rotation when the leader crosses a 4096 boundary. Visually jarring; mechanically OK. | low |
| 6 | FastAPI server holds port handles after a USB unplug — `/servos` 500s but `/health` still reports `connected: true`. Need a periodic liveness probe on each driver. | medium |
| 7 | Webhook emission is sync HTTP from the session thread. A slow BIMS webhook would slow the 30 Hz loop. Should queue + drain async. | low |
| 8 | No driver-level position limits per joint (besides global 0–4095 clamp / modulo). EEPROM min/max angle limits per servo aren't read or respected at startup. | low |
| 9 | Recording JSONL has no provenance — no operator, no lot, no protocol step, no schema version. Future protocol integration will need this. | medium |
| 10 | `scripts/teleop_keyboard.py` mid-session fixes from the 2026-05-18 evening (terminal-width render, Shift+T torque restore, no-latch on errors, piano-row layout, cbreak no-echo, auto-restore torque on boot) **never made it to this branch** — they were uncommitted on `feature/bims-protocol-runner` and were not carried over when we re-checked-out the subtree. Keyboard script here is the early version with all those bugs. | low (CLI rarely used now) |

---

## Next steps — open-ended bucket, prioritize later

### Calibration + polish on the teleop loop

- Read each servo's EEPROM min/max angle limits at startup; expose via `/servos`; clamp goals to safe ranges before writing.
- Per-joint offset map between leader and follower in `~/.bims-arm/calibration.json`. CLI command `arm calibrate` walks both arms to known poses, derives offsets.
- Multi-turn delta tracking: detect when leader crosses 4096 boundary, accumulate as continuous deltas; let follower wrap deliberately (forward vs back) instead of always snapping the same direction.
- Driver status-byte fix (#1 above) — split into comm error vs informational status. Likely just stop raising on non-zero status in `set_torque`, keep raising in reads.
- Recording editor: trim/splice/playback-speed adjust. Probably a `scripts/edit_recording.py` CLI first, BIMS UI later.

### Wire the arm into manufacturing protocols (Track 2 → Track 1)

- Add `recordedDuringRunId`, `lotId`, `operator`, `manufacturingStep` to recording metadata at save time. Today's JSONL has only `{t, positions}` — extend to `{t, positions, meta}` or a separate sidecar JSON.
- New BIMS view: "Arm recordings for lot X" — query `RobotArmRun` by `lotId`, link to the recording on disk.
- Protocol step type "arm replay" — pick a recording, configure loops, fire `/replay/start` with `triggered_by + lotId + stepId` so the resulting `RobotArmRun` is traceable.
- Wax-filling pilot: insert "arm transfer" between OT-2 dispense and scanner sweep. Requires `WaxFillingRun` to track an `armRunId` reference.
- Pre-flight per protocol: confirm both arms reachable + at known starting pose before allowing the step to proceed.

### Operational / production hardening

- Migrate FastAPI to the Pi. Provision OS image, systemd service, lab-LAN IP, `ask-bims` proxy if needed. Mac stays the dev rig.
- `fcntl` advisory lock on serial ports (#2 above) so the keyboard CLI and FastAPI can't accidentally both grab the bus.
- Periodic driver liveness probe (#6 above) — every 5 s, send a no-op read on each port; flip `health.leader_connected` / `follower_connected` to false if it fails.
- Auto-discover ports by chip serial number (#3) — read all `/dev/cu.usbmodem*`, ping the bus on each, pick whichever has 6 servos.
- Webhook queue (#7) — push events onto a `queue.Queue`, drain in a background thread, retry on failure.
- Persist recordings to durable storage (S3 / Mongo GridFS / R2). Currently only on the Mac's home dir.
- Process supervisor for the arm FastAPI server (currently you launch from a terminal; if it dies, no auto-restart).

### BIMS UI improvements (mostly server-side already wired)

- Refresh recordings list automatically after `/record/start` completes
  (currently needs a page reload). **Blocked by frozen-svelte rule** —
  the fix is one `use:enhance` + `invalidateAll()` on the control page
  form. The server-side data refresh is already there; just needs the
  client to ask for it.
- Add lot / step / parent-run-id form inputs on the control page so
  operators can stamp provenance at start time. The server actions
  already accept those formData fields (`lot_id`,
  `manufacturing_step`, `recorded_during_run_id`) — UI just needs to
  surface them.
- Build the "Arm recordings for lot X" view (e.g.
  `/manufacturing/robot-arm/by-lot/[lotId]`) on top of the existing
  `GET /api/robot-arm/runs-for-lot?lotId=...` endpoint.
- Wire the wax pilot's "play arm replay" button: a POST to
  `/api/robot-arm/trigger-replay` with `parent.type='wax'` and the
  active wax `runId`. Stamps `WaxFillingRun.armRunId` automatically.
- Show live position telemetry on the page during a session — a 6-bar status of where each joint is.
- "Stop" button while a session is active is already there; verify it works with the new POST `/sessions/stop` endpoint.
- Run history page (`/manufacturing/robot-arm/runs`) is on `feature/bims-protocol-runner` but not on `dev`. Either cherry-pick or rewrite.
- Visualize a recording — strip chart of all 6 joints over time. Helps with debugging "why did this fail."

### Stretch / research

- Hugging Face LeRobot integration — they have policy training, replay tooling, dataset format. Map our JSONL → LeRobot's HDF5 / parquet so recordings can train models.
- Task-space (Cartesian) control for the keyboard CLI (Phase 3b on the old feature branch — `ikpy` + SO-100 URDF). Probably superseded by leader-follower teleop now, but worth keeping in mind for headless replay editing.
- Force-feedback / load-balanced teleop — read leader load + warn operator when follower struggles.

---

## Architecture decisions worth remembering

- **Single process owns both ports.** The FastAPI server opens leader + follower in its lifespan and is the only place that drives the buses. CLI tools (`teleop_cli.py`, `teleop_keyboard.py`) grab the port directly and can't run while the server is up. Acceptable trade — single owner means no fcntl gymnastics.
- **Sessions run in OS threads, not asyncio.** Driver I/O is blocking. Mixing it with asyncio works but adds a `to_thread` hop per call. The session loop runs at 30 Hz and just sleeps between ticks; no point making it async.
- **`asyncio.Lock` guards both the follower-direct endpoints AND the session-control endpoints.** Means you can't `jog` while a teleop session is running (returns 409). On purpose.
- **Webhook is fire-and-forget from the session thread.** Failures print to stderr but don't kill the session.
- **Recordings are JSONL on disk.** Simple, append-only, human-readable. Not committed to git — they're operator data, not code.
- **`at` field in webhook events MUST be ISO 8601.** BIMS does `new Date(String(at))`, a UNIX float becomes Invalid Date → Mongoose validation 500.

---

## Hardware notes (current setup)

- **Leader chip serial**: `5C4C126959` → device node `/dev/cu.usbmodem5C4C1269591`
- **Follower chip serial**: `5C4C128050` → device node `/dev/cu.usbmodem5C4C1280501`
- Both are WCH CH9102 USB-UART bridges (vendor `0x1A86`, product `0x55D3`).
- Leader has multi-turn enabled on joint 5 (regularly reads 4500–5500).
- Follower has been seen to latch OVERLOAD on joint 5 after long idle holds. Recovery procedure: torque off → wait 300 ms → snap goal to present → torque on. Worked twice now.
- Both arms need their 12 V barrel-jack power adapters plugged in for the servos to respond — USB only powers the chip, not the motors.
- macOS Accessibility permission required for `teleop_keyboard.py` to see keys (pynput). Not needed for the FastAPI server.

---

## What's NOT on this branch but exists elsewhere

- `feature/bims-protocol-runner` has additional work that didn't come to `dev`:
  - **BIMS Direct Control UI** (jog pad, pose manager on the control page). Replaced by leader-follower teleop for now — operator drives the leader by hand instead of jogging via UI.
  - **Keyboard teleop fixes** (terminal-width render, Shift+T, piano-row layout, etc.). Worth cherry-picking if we decide to keep the keyboard script.
  - **FastAPI Direct Control endpoints** with poses (`/poses/*`). These ARE on this branch — they were carried over with the rest of the foundational code.
- See git log on that branch for the four arm commits if you want to graft anything in.
