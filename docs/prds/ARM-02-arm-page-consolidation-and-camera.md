# ARM-02: Robot Arm — Page Consolidation + Live Arm Camera

**Author:** Alejandro (via Claude Code)  **Date:** 2026-08-04  **Status:** Draft
**Priority:** P1 — the arm now has a working camera stack on the Pi that BIMS cannot see at all, and the arm UI is split across four sibling nav entries so the operator cannot watch and drive at the same time.
**Target branch:** `feat/robot-arm-page-consolidation` (off `master`)

> Branch note: `master` already carries `jog/` and `calibrate/` (they were on `NEWDEV` when ARM-01 was written; they have since merged). ARM-02 therefore branches off `master`, not `NEWDEV`. ARM-01's connection/task work is a **sibling, not a dependency** — ARM-02 does not require ARM-01 to land first, but §7.3 notes where they touch the same files.

---

## 1. Problem Statement

**1.1 The arm is four pages pretending to be one tool.**
`src/routes/manufacturing/cart-mfg/+layout.svelte:32-35` registers four separate top-level nav entries under Cart Mfg:

```
{ href: '/manufacturing/cart-mfg/robot-arm',           label: 'Robot Arm'  },
{ href: '/manufacturing/cart-mfg/robot-arm/jog',       label: 'Arm Jog'    },
{ href: '/manufacturing/cart-mfg/robot-arm/runs',      label: 'Arm Runs'   },
{ href: '/manufacturing/cart-mfg/robot-arm/calibrate', label: 'Arm Calib'  },
```

They are one machine. The nav says they are four peers of Reagent Filling and Wax Filling. Moving from jogging the arm to checking whether the last run recorded means going back up to the section nav and hunting between unrelated stations.

**1.2 Nothing is shared between them, so state is re-derived four times.**
Each page independently loads connection state and the active session:
`control/+page.server.ts:138-140`, `jog/+page.server.ts:34-36`, `calibrate/+page.server.ts:50-52`. An operator who starts a teleop session on Control and then opens Jog gets a page that re-fetches the same session over the same single-owner serial bus, and any control bar or connection banner they were looking at is destroyed and rebuilt.

**1.3 The arm has a camera and BIMS has no idea.**
`src/server/cameras.py` on the arm-pi is a complete multi-camera capture service — a per-camera decode thread, a latest-frame slot, JPEG-encoded frames fanned out to any number of HTTP subscribers, and staleness/error reporting (`cameras.py:319-337`). `src/server/app.py:857-905` exposes `GET /cameras`, `GET /cameras/{name}/stream.mjpg` and `GET /cameras/{name}/snapshot.jpg`. **`src/lib/server/robot-arm-client.ts` wraps none of them.** A camera was physically attached to the Pi and verified end-to-end this session; from the product it does not exist.

**1.4 You cannot watch the arm and move the arm at once.**
This is the operational failure that matters. Teleop, replay, and jogging are all "watch it while it moves" activities. Today watching means either standing next to the arm, or opening a second window against a Tailscale-only Pi URL — which fails ARM-01's G0 (*"controllable from any device that can reach live BIMS … no Tailscale client, no VPN"*).

**Who's blocked:** anyone running the arm off the lab floor, anyone validating a `cartridge_pick_and_place_relay` run, and anyone doing leader/follower teleop — the case where the follower is by definition not where the operator is.

---

## 2. Goals

1. **One Robot Arm page.** A single Cart Mfg nav entry. Control, Jog, Calibrate and Runs become tabs *inside* it, selected from a tab strip at the top of the arm page.
2. **Tabs are deep-linkable and preserve their own loads.** `/manufacturing/cart-mfg/robot-arm/jog` still works, still bookmarkable, still has its own form actions.
3. **Shared arm chrome persists across tab switches.** Connection/session state renders once, above the tabs, and is not torn down when the operator moves between tabs.
4. **The arm camera is a first-class panel on the arm page**, visible on *every* tab, co-visible with the controls — not a separate page, not a popout.
5. **The camera survives tab switches without reconnecting.** Switching Control → Jog must not drop or restart the video.
6. **Camera works from any device that can load BIMS** — same G0 bar as ARM-01. No Tailscale client on the viewer.
7. **Camera health is legible.** Which camera, is it running, is the frame stale, what error — surfaced from the Pi's own status, not guessed.
8. **Viewer controls exist and are obvious:** camera selector, size, frame rate, pause, snapshot, collapse.

---

## 3. Non-Goals

- **Camera *tuning* (exposure, gain, white balance, brightness).** The Pi API has no endpoint for it — `CameraSpec` is read from `src/config/hardware.yaml` at startup and there is no PATCH. Changing image parameters at runtime is ARM-03. §10 Q4 asks whether you want it sooner.
- **Recording video to R2 / persisting frames in Mongo.** No new collection, no blob writes. This PRD is live view only. The Pi's own recording path (`/record`) is untouched.
- **Replacing the CV capture-station stack.** `/capture` and its stations are a different device class with a different network model (§7.4). Nothing there changes.
- **Multi-camera grid / simultaneous streams.** One camera visible at a time, switchable. The Pi supports N workers; the UI shows one. Grid is a follow-up.
- **Changing arm motion, task, or calibration behaviour.** Zero changes to what any form action does. This is a shell + a viewer.
- **ARM-01's preflight panel and task-run control.** Sibling PRD; §7.3 reserves the seam.
- **Touching `src/lib/stores/`, `src/lib/utils/`, `src/app.html`, `static/`.**

---

## 4. Current State

Every claim below was re-read from the working tree and from the Pi this session.

### 4.1 The four routes as they exist

| Route | Load does | Actions | Size |
|---|---|---|---|
| `robot-arm/+page.server.ts` | nothing but `redirect(303, …/control)` (`:20-22`) | — | 22 lines |
| `robot-arm/control/` | `getActive` + recordings + sessions (`+page.server.ts:138-140`) | `startTeleop`, `startRecord`, `startReplay`, `startTask`, stop (`control/+page.svelte:103,146,200,258`) | 391 / 380 lines |
| `robot-arm/jog/` | `getActive` + calibration (`jog/+page.server.ts:34-36`) | `jog`, `jogJoint`, `torqueOn`, `torqueOff`, `reloadCalibration`, `resetBacklash` (`jog/+page.svelte:161,208,243,252,264,273`) | 281 lines |
| `robot-arm/calibrate/` | `getActive` + `getCalibration({live})` + `getJointMap`, **sequential** (`calibrate/+page.server.ts:50-52`) | `capture`, `capturePose`, `deletePose`, `clearMap`, `clear` (`calibrate/+page.svelte:270,317,432,450,465`) | 470 lines |
| `robot-arm/runs/` | `RobotArmRun.find` paged, `PAGE_SIZE = 50` (`runs/+page.server.ts:10,14-16`) | none | 118 lines |

All four call `requirePermission(event, 'manufacturing:read')` (write actions use `manufacturing:write`). There is **no** `robot-arm/+layout.svelte` and **no** `robot-arm/+layout.server.ts` today — that is the hole this PRD fills.

### 4.2 The 30-second budget is already mostly spent on Calibrate

`src/lib/server/robot-arm-client.ts:363-368`, verbatim:

> the calibrate load awaits getActive (5s), then this, then getJointMap sequentially — the serial bus is single-owner so they cannot be parallelised. 5+10+10=25s has to stay under the adapter's maxDuration of 30

`svelte.config.js:7-11` confirms `adapter({ runtime: 'nodejs22.x', regions: ['pdx1'], maxDuration: 30 })`. **This is the single hardest constraint in the PRD.** SvelteKit runs layout loads and page loads *concurrently*, so a naive shared `+layout.server.ts` that also touches the serial bus would contend with the calibrate load inside a budget that has 5s of headroom. §7.2 is written around this.

### 4.3 The Pi camera service — verified working

`src/server/app.py` camera endpoints (`:857-905`):

| Endpoint | Behaviour |
|---|---|
| `GET /cameras` | `CameraManager.status()` — **deliberately does not start workers**; polling status never powers on a camera (`cameras.py:409-411`) |
| `GET /cameras/{name}/stream.mjpg` | `multipart/x-mixed-replace; boundary=frame`, optional `?fps=` cap (`cameras.py:339-346`) |
| `GET /cameras/{name}/snapshot.jpg` | single JPEG, current latest frame |

Per-camera status fields, read from `cameras.py:322-336`: `name`, `device`, `running`, `requested{width,height,fps,quality}`, `actual_size`, `frames`, `last_frame_age_s`, `stale`, `error`.

Live probe this session against the Pi:

```
{"status":"ok","service":"robot-arm","version":"0.1.0",
 "cameras":[{"name":"external","device":"/dev/video0","running":false,
   "requested":{"width":640,"height":480,"fps":15,"quality":80},
   "actual_size":null,"frames":0,"last_frame_age_s":null,"stale":true,"error":null}]}
```

and a snapshot pulled through to this machine over Tailscale confirmed a real JPEG, non-black, `640x480`.

`src/config/hardware.yaml` declares one active camera, `external`, on `${EXTERNAL_CAM_DEVICE}` / `EXTERNAL_CAM_INDEX=0`; a second `gripper` entry exists but is **commented out**. The UI must therefore enumerate cameras from `GET /cameras` and must not hard-code `external`.

### 4.4 The Pi's camera auth is cookie-based and SameSite=Strict

`app.py:810-854` mints a view token and sets it as a cookie with `samesite="strict"`. That is correct for someone opening the Pi's own page directly, and **fatal for a cross-origin `<img>` from the BIMS origin** — a strict cookie is not sent on a cross-site subresource request. This is the fact that decides §7.4.

### 4.5 The Pi camera code is not committed

On the Pi's checkout, `src/server/cameras.py` and the camera block in `app.py` are **uncommitted work on `feat/multi-pose-calibration`**. `git status --short` shows them dirty/untracked. The running `robot-arm.service` is serving code that exists in no commit. This is a shipping blocker for ARM-02 and is called out as Story S0.

### 4.6 The Funnel path BIMS uses

ARM-01 §4.4 verified, and it still holds: `tailscale funnel status` → `https://arm-pi.tailf65a70.ts.net → / proxy http://127.0.0.1:8000`, with `x-api-key` enforced (401 without). Because the Funnel fronts **:8000**, the camera endpoints are already on the public HTTPS origin that BIMS's server can reach from Vercel. No new networking is required for the server-proxied design.

`.env.example:103-104` documents `ROBOT_ARM_BASE_URL` / `ROBOT_ARM_API_KEY`; ARM-01 §4.5 flagged that local `.env` points at a stray `:8001` uvicorn. ARM-02 inherits that hazard — if BIMS points at `:8001`, the camera endpoints 404, because the hand-started process predates them.

### 4.7 Prior art for the tab shell already exists in-repo

`src/routes/validation/+layout.svelte` is exactly the pattern this PRD wants: a `navItems` array (`:11-32`), an `isActive` prefix match (`:34-37`), a breadcrumb (`:52-70`), and a tab strip (`:73-94`) styled with `var(--color-tron-cyan)` / `var(--color-tron-border)` over `{@render children()}`. `manufacturing/cart-mfg/reagent-filling/+layout.svelte` proves a nested sub-layout is already accepted *inside* Cart Mfg.

---

## 5. Reference / Prior Art

| Source | What to take |
|---|---|
| `src/routes/validation/+layout.svelte` | The tab-strip layout, verbatim in structure. Copy the markup, swap `navItems`. |
| `src/routes/manufacturing/cart-mfg/reagent-filling/+layout.svelte` | Precedent for a sub-layout nested under the Cart Mfg layout. |
| `src/routes/capture/+page.svelte:53-57` | The existing MJPEG-in-`<img>` viewer: `mjpegUrl` derived from a station base URL, `<img>` bound directly to the stream. **Its network model is what we are deliberately *not* copying** (§7.4). |
| `src/routes/api/cv/stations/[id]/token/+server.ts` | The pattern for BIMS minting a short-lived device view token — relevant only if §10 Q1 is answered "direct". |
| `src/lib/server/robot-arm-client.ts` | The `robotArmFetch` wrapper, timeouts, and the `live_error` discipline. New camera methods go here and nowhere else. |
| ARM-01 §7 (G0 doctrine) | *"the browser only ever talks to BIMS over ordinary HTTPS, and BIMS … talks to the Pi over the Funnel origin."* ARM-02 must not break this. |
| Pi `src/server/cameras.py` | Frame fan-out semantics: slow subscribers get the latest frame, not a backlog; `frames(max_fps)` throttles server-side. |

---

## 6. Data Model & Source

**No new collections. No schema changes. No migrations.**

| Surface | Source | Persisted? |
|---|---|---|
| Camera list, running/stale/error, actual size | Pi `GET /cameras` | No — compute on read |
| Live frames | Pi `stream.mjpg` / `snapshot.jpg` | No |
| Connection / preflight | Pi `GET /health/preflight` | No — compute on read |
| Active session | Pi `GET /sessions/active` | No |
| Run history | `RobotArmRun` (existing, unchanged) | Yes, already |
| Viewer preferences (camera, fps, size, collapsed) | `localStorage` in the browser | Client only |

The compute-on-read rule is inherited from ARM-01 §6 and applies for the same reason: a stored copy of *"is the camera running"* is stale the instant the Pi reboots, and the arm has no heartbeat writer.

**AuditLog:** ARM-02 introduces **no new mutations**, so it adds no `AuditLog` entries. Existing arm actions keep whatever logging they already do. Viewing a camera is a read. Stated explicitly so a reviewer does not read the absence as an oversight — §10 Q5 asks whether starting a camera worker should be treated as a mutation.

---

## 7. Design / Architecture

### 7.1 Tabs via a real `+layout.svelte`, not client-side tab state

**Decision: keep the four routes; add `robot-arm/+layout.svelte` with a tab strip; collapse the four Cart Mfg nav entries into one.**

The alternative — one `+page.svelte` holding all four panels behind a `$state` tab index — was rejected on three concrete grounds:

1. **Form actions would collide.** The four pages contribute 15 named actions (`?/jog`, `?/capture`, `?/startTeleop`, …). Merging them puts all 15 in one `actions` object with one `fail()` namespace, so a failed `jog` and a failed `capturePose` become indistinguishable to the UI.
2. **One load would pay every tab's cost on every visit.** Calibrate's load alone burns 25 of the 30s budget (§4.2). Merging means opening Runs pays for a live calibration sync.
3. **Deep links die.** `/…/robot-arm/calibrate` is in operator muscle memory and in ARM-01's prose.

The layout approach gets the same one-page *feel* — one nav entry, tabs across the top, shared chrome — with none of that. And critically: **in SvelteKit client-side navigation the layout component instance persists across child route changes**, so the camera `<img>` mounted in the layout is *not* destroyed when the operator moves Control → Jog. That is Goal 5, satisfied structurally rather than by workaround.

Nav after the change, in `cart-mfg/+layout.svelte`:

```
{ href: '/manufacturing/cart-mfg/robot-arm', label: 'Robot Arm' }   // one entry
```

with `isActive` prefix-matching so all four children keep the parent highlighted.

Tab strip contents: **Control · Jog · Calibrate · Runs**. Order is deliberate — it is the operational order (connect/run → nudge → fix → review), not the current alphabetical accident.

### 7.2 What the shared layout load may and may not do

**Constraint (§4.2): the serial bus is single-owner and calibrate has 5s of headroom.**

Rules for `robot-arm/+layout.server.ts`:

- It may call **`/health/preflight` only** — the HTTP/port-diagnosis path — with a **short timeout (≤3s)** and a `live_error`-style soft failure, never a throw.
- It may call **`GET /cameras`** — `cameras.py:409-411` guarantees status polling does not start a worker and does not touch the serial bus.
- It **may not** call `getActive`, `getCalibration`, `getJointMap`, or anything that opens the servo bus. Those stay in the child loads where their budget is already accounted for.
- Child loads are **not** refactored to read session state from the layout in this PRD. Tempting, and it is the natural follow-up, but doing it here would rewrite three load functions inside the tightest timeout budget in the codebase. Deduplicating `getActive` is deferred and named in §12.

Consequence to accept honestly: the arm header shows connection + camera health, while the per-tab session detail stays per-tab. Slightly redundant, and the redundancy is what keeps calibrate under 30s.

### 7.3 Seam with ARM-01

ARM-01 adds a connection/preflight panel and task-run control to `control/`. ARM-02 creates the layout that such a panel obviously belongs in. To keep the two from fighting:

- ARM-02 creates `robot-arm/+layout.svelte` with a **named slot region for arm chrome** and renders a *minimal* status strip (reachable / version / DRY_RUN badge / camera health).
- ARM-02 does **not** build ARM-01's per-port diagnosis table. If ARM-01 lands first, its panel moves into this region unchanged; if ARM-02 lands first, ARM-01 fills the region it finds.
- Both touch `control/+page.svelte` and `robot-arm-client.ts`. Whichever lands second rebases; the overlap is small and additive.

### 7.4 Camera transport — the central decision

Four options were considered against G0 ("works from any device that can load BIMS") and against Vercel serverless reality.

| Option | G0? | Serverless? | Verdict |
|---|---|---|---|
| **A. Browser → Pi tailnet IP** (`100.117.56.74:8000`) | ✗ needs Tailscale on the viewer | n/a | Rejected — this is the capture-station model ARM-01 §7 explicitly rules out |
| **B. Browser → Funnel origin directly** (`https://arm-pi.tailf65a70.ts.net/cameras/…`) | ✓ public HTTPS | n/a | **Blocked today** by `samesite="strict"` (§4.4); needs a Pi change. Lowest latency. See Q1 |
| **C. BIMS proxies MJPEG** (long-lived multipart through a Vercel function) | ✓ | ✗ — a 30s `maxDuration` cuts the stream every 30s, and every viewer pins a function instance for its whole life | Rejected as the default |
| **D. BIMS proxies snapshots, client polls** | ✓ | ✓ — each request is short and bounded | **Recommended default** |

**Decision: D as the shipped default, with B as an opt-in "low latency" mode gated on Q1.**

Option D concretely:

- New route `src/routes/api/robot-arm/cameras/[name]/snapshot/+server.ts`
  - `requirePermission(event, 'manufacturing:read')`
  - server-side `robotArmFetch` to `/cameras/{name}/snapshot.jpg`, streams the bytes back as `image/jpeg` with `Cache-Control: no-store`
  - the Pi's URL and `ROBOT_ARM_API_KEY` never reach the browser
- Client polls by swapping `img.src` with a cache-busting counter, default **5 fps**, operator-selectable 1 / 5 / 10 fps.
- Bandwidth check against real numbers: measured frame ≈ 22 KB at `640x480` q80, so 5 fps ≈ 110 KB/s. Acceptable.
- Latency is honestly worse than MJPEG — one Vercel round trip per frame, so expect a few hundred ms. **For watching an arm move, 5 fps at ~300ms is adequate; for closed-loop hand-eye teleop it is not.** If teleop turns out to need better, that is exactly what mode B is for, and Q1 is the decision point.

The client must **never** be handed `ROBOT_ARM_BASE_URL` or the API key. In mode D it cannot be; in mode B it would receive a scoped, short-lived, camera-only token — never the arm key.

### 7.5 Camera panel placement

- **Desktop (≥1280px):** a sticky right rail, ~380px, spanning the full arm page so it is co-visible with whatever tab is open. Controls on the left, arm on the right — the natural teleop posture.
- **Tablet/narrow:** the panel moves above the tab content, collapsed by default, expandable. Never a modal — a modal you must dismiss to press a jog button is the exact failure this PRD exists to fix.
- **Collapsed state persists** in `localStorage`, so an operator who does not want video does not fight it every load.
- **Mounted in `+layout.svelte`**, above `{@render children()}` in DOM order but positioned by grid, so it survives tab navigation (§7.1).

### 7.6 Camera panel behaviour

- **Enumerate** cameras from the layout's `GET /cameras`; render a selector only when `cameras.length > 1` (today it is 1 — `gripper` is commented out in `hardware.yaml`).
- **Health strip** driven by real Pi fields: `running`, `stale`, `last_frame_age_s`, `error`, `actual_size` vs `requested`.

| Pi state | Panel shows |
|---|---|
| `running: true, stale: false` | live image, green dot, `640×480 · 5 fps` |
| `running: true, stale: true` | last frame dimmed + amber "no frame for {last_frame_age_s}s" |
| `running: false` | placeholder + **Start camera** button, explaining status polling deliberately does not power the camera on |
| `error` non-null | red callout with the Pi's error string **verbatim** |
| Pi unreachable | red, the configured base URL, and a pointer to `ROBOT_ARM_BASE_URL` — same copy discipline as ARM-01 §8.1 |

- **Viewer controls:** camera selector, fps (1/5/10), size (S/M/L), pause/resume, snapshot download, collapse, fullscreen.
- **Pause on hidden tab:** stop polling on `document.visibilityState === 'hidden'` — a background tab must not keep hammering a Vercel function or the Pi.
- **Auto-recovery:** on N consecutive failed frames, back off to 1 fps and show "reconnecting", rather than silently freezing on a stale image. A frozen image that looks live is the dangerous failure mode for a moving machine.
- **Never rotate/mirror silently.** If flip is offered it is a labelled viewer control, because an operator jogging `-Y` while watching a mirrored feed will crash the arm.

### 7.7 Client additions to `robot-arm-client.ts`

```
listCameras()                    -> GET /cameras            (timeout 5s)
getCameraSnapshot(name)          -> GET /cameras/{name}/snapshot.jpg   (raw bytes, 5s)
startCamera(name) / stopCamera(name)   [only if Q2 says the Pi should get these]
```

Everything else stays. No existing wrapper is modified.

---

## 8. UX Spec

### 8.1 Nav

**Before:** Cart Mfg nav lists `Robot Arm`, `Arm Jog`, `Arm Runs`, `Arm Calib` as four peers.
**After:** one entry, `Robot Arm`, active for any `/manufacturing/cart-mfg/robot-arm*` path.

### 8.2 Arm page frame

```
Cart Mfg / Robot Arm / Jog                     ← breadcrumb (validation pattern)
┌──────────────────────────────────────────────────────────┐
│ ● Reachable · v0.1.0 · DRY RUN     📷 external ● live     │  arm status strip
├──────────────────────────────────────────────────────────┤
│ [ Control ] [ Jog ] [ Calibrate ] [ Runs ]                │  tab strip
├────────────────────────────────┬─────────────────────────┤
│                                │  CAMERA                 │
│   {@render children()}         │  ┌───────────────────┐  │
│   (the selected tab)           │  │   live image      │  │
│                                │  └───────────────────┘  │
│                                │  external ▾  5 fps ▾    │
│                                │  ⏸  ⤓  ⤢  ⌄            │
└────────────────────────────────┴─────────────────────────┘
```

Tab styling copies `validation/+layout.svelte:73-94` exactly: active tab `bg-[var(--color-tron-cyan)] text-[var(--color-tron-bg-primary)]`, inactive `text-[var(--color-tron-text-secondary)]` with cyan hover, strip separated by `border-b border-[var(--color-tron-border)]`.

### 8.3 Acceptance criteria (each independently checkable)

- **AC1** Cart Mfg nav shows exactly one Robot Arm entry; it is highlighted on all four child routes.
- **AC2** All four tabs render, and every existing form action still works unchanged: jog, jogJoint, torqueOn/Off, reloadCalibration, resetBacklash, capture, capturePose, deletePose, clearMap, clear, startTeleop, startRecord, startReplay, startTask, stop.
- **AC3** `/…/robot-arm/calibrate` loads directly (deep link) with the correct tab active.
- **AC4** `/…/robot-arm` still redirects to `/control`.
- **AC5** Navigating Control → Jog → Calibrate → Runs **does not interrupt the camera image** (frame counter keeps advancing; no flash to placeholder).
- **AC6** With the Pi camera running, a live image appears within 2s of page load on the deployed origin, from a device with **no Tailscale client**.
- **AC7** With the camera worker stopped, the panel shows the not-running placeholder — and polling `/cameras` has not started the camera as a side effect.
- **AC8** With the Pi unreachable, the panel shows red with the configured base URL; the tabs and Runs still render.
- **AC9** No `ROBOT_ARM_API_KEY` and no Pi hostname appears anywhere in the page source or in any client-visible network request.
- **AC10** Calibrate tab still loads inside 30s with the camera panel active (the §4.2 budget is not blown by the layout load).
- **AC11** Backgrounding the browser tab stops camera requests within ~1s.

---

## 9. Stories

| ID | Story | Deliverable |
|---|---|---|
| **ARM-02-S0** | Commit and push the Pi camera stack, restart `robot-arm.service` from a tracked commit | `cameras.py` + `app.py` camera endpoints committed on the arm-pi repo; `GET /cameras` served by the systemd unit on **:8000**, not a hand-started uvicorn. **Blocks everything else.** |
| **ARM-02-S1** | Create `robot-arm/+layout.svelte` with breadcrumb + 4-tab strip | Tabs render, active state correct, deep links work (AC1–AC4) |
| **ARM-02-S2** | Collapse the four Cart Mfg nav entries to one | `cart-mfg/+layout.svelte` nav edit + prefix `isActive` (AC1) |
| **ARM-02-S3** | Add `robot-arm/+layout.server.ts` — preflight (≤3s, soft-fail) + `GET /cameras` only | Status strip data; calibrate still under budget (AC10) |
| **ARM-02-S4** | Add camera methods to `robot-arm-client.ts` | `listCameras`, `getCameraSnapshot` with timeouts + `live_error` discipline |
| **ARM-02-S5** | Add BIMS snapshot proxy route | `api/robot-arm/cameras/[name]/snapshot/+server.ts`, permission-checked, key never leaks (AC9) |
| **ARM-02-S6** | Build `RobotArmCameraPanel.svelte` — image, health strip, all five Pi states | AC6, AC7, AC8 |
| **ARM-02-S7** | Viewer controls + persistence + visibility pause | selector, fps, size, pause, snapshot, collapse, `localStorage`, AC11 |
| **ARM-02-S8** | Responsive placement — right rail ≥1280px, stacked collapsed below | §7.5 verified at both widths |
| **ARM-02-S9** | Camera survives tab navigation | AC5 — the one that justifies the layout design |

S1/S2 are shippable alone (consolidation with no camera). S4–S7 are shippable alone against the existing four-page nav. They are sequenced together because the panel's home is the layout.

---

## 10. Open Questions / Risks

**Q1 — Low-latency mode: do we allow the browser to hit the Funnel origin directly?**
Mode D (proxy + poll) is ~5 fps with a few hundred ms of latency and leaks nothing. Mode B is true MJPEG at full frame rate, but requires (a) changing the Pi's view cookie from `samesite="strict"` to `SameSite=None; Secure` or accepting a `?token=`, and (b) the browser learning the Pi's Funnel hostname. Both are survivable — the Funnel is already public and already the only thing between the internet and the arm is a key — but it is a deliberate relaxation of ARM-01's "the Pi's address and key are never exposed to the client". **This needs your call, and it is the one that decides whether teleop-with-video feels good or merely works.** Recommendation: ship D, then measure during real teleop, then decide.

**Q2 — Should BIMS be able to start/stop a camera worker?**
Status polling deliberately never powers a camera on (`cameras.py:409-411`). If the camera is off, BIMS today can only tell you so. Adding a **Start camera** button needs a new Pi endpoint (`POST /cameras/{name}/start`). Worth it, or is "the camera is on because the service started it" good enough?

**Q3 — Which camera is authoritative during leader/follower teleop?**
`hardware.yaml` has `external` active and `gripper` commented out. If the gripper camera comes back, does the panel auto-switch to it during teleop, or does the operator always choose? Auto-switching a video feed on a moving machine is the kind of helpfulness that causes crashes — recommendation is manual, but it is your call.

**Q4 — Exposure/tuning: how soon?**
The `black video on fresh Pi stations` lesson from the CV fleet was that a new camera looks broken when it is only badly exposed. The arm camera has no tuning UI and the Pi has no endpoint. Do we pre-empt that with an ARM-03, or wait until it bites?

**Q5 — Is starting a camera an auditable event?**
ARM-02 as scoped adds no mutations and no `AuditLog` rows. If Q2 says yes to start/stop, that becomes a device state change on a machine that moves. Log it?

**Q6 — `:8001` still wins locally.**
ARM-01 §4.5 found local `.env` pointing at a hand-started uvicorn on `:8001` that the Funnel does not proxy. That process predates the camera code, so **local dev will 404 on `/cameras` while production works** — a genuinely confusing failure. Fix the `.env` first, or S0 will look broken for the wrong reason.

**Risk — one Vercel region, one Pi.** `regions: ['pdx1']` plus a single Pi means every frame crosses the same path; there is no fallback and no caching. Acceptable for one arm and a handful of viewers; it will not scale to a fleet.

**Risk — a frozen frame reads as a live one.** Mitigated by §7.6 (stale dimming, age in seconds, reconnect state), and this is the safety-relevant part of the UI. It deserves review attention out of proportion to its size.

---

## 11. Test / Validation Plan

**Static**
- `npm run check` clean (per `project_bims_local_build_infeasible`, `npm run build` OOMs on this machine — svelte-check locally, **Vercel branch build is the gate**).
- `git status --short` for stray untracked `??` files before every push.

**Pi-side (S0)**
- `curl -s -H "x-api-key: $KEY" https://arm-pi.tailf65a70.ts.net/cameras` returns the camera list **from the systemd service**, verified with `systemctl is-active robot-arm` and `ss -tlnp` showing :8000 owned by it and **no stray :8001**.
- `git log --oneline -1` on the Pi shows the camera commit; `git status --short` clean.

**Real-data parity**
- Snapshot fetched through the BIMS proxy is **byte-comparable** to one fetched directly from the Pi (`cmp` the two JPEGs) — proves the proxy is a pipe, not a re-encoder.
- The four tabs' rendered content matches the current four pages field-for-field before/after consolidation (same run rows, same calibration numbers, same session state).

**Vercel preview — the G0 test**
- On a **phone with Tailscale off, on cellular**: load the deployed preview, log in, open Robot Arm, see live video. This single test is the whole point of §7.4 and cannot be substituted with a localhost run.
- Same device: run each of the 15 form actions in DRY_RUN and confirm unchanged behaviour.

**Failure injection**
- Stop the camera worker → AC7. Stop `robot-arm.service` → AC8. Unplug the camera mid-stream → stale path, age counter, reconnect. Point `ROBOT_ARM_BASE_URL` at `:8001` → the Q6 404, with a legible message rather than a blank panel.

**Budget**
- Time the Calibrate tab load on the preview with the camera panel live, three times, confirm well under 30s (AC10). This is the regression most likely to be missed, because it only fails on the slowest path.

---

## 12. Out of Scope

- Deduplicating `getActive` across the three child loads into the layout (§7.2 defers it; it is the natural ARM-04).
- Camera tuning endpoints (ARM-03, Q4).
- Video recording/persistence, R2, or frame storage.
- Multi-camera grid view.
- ARM-01's preflight table and task-run control.
- Anything under `src/lib/stores/`, `src/lib/utils/`, `src/app.html`, `static/`.
- Changing the CV capture-station architecture.

---

## Appendix A — File Change Map

**Add**

| Path | Purpose |
|---|---|
| `src/routes/manufacturing/cart-mfg/robot-arm/+layout.svelte` | Tab strip, breadcrumb, status strip, camera rail |
| `src/routes/manufacturing/cart-mfg/robot-arm/+layout.server.ts` | Preflight (≤3s) + `GET /cameras`; **no serial-bus calls** |
| `src/routes/api/robot-arm/cameras/[name]/snapshot/+server.ts` | Permission-checked JPEG proxy |
| `src/lib/components/RobotArmCameraPanel.svelte` | The viewer |
| `docs/prds/ARM-02-arm-page-consolidation-and-camera.md` | This file |

**Modify**

| Path | Change |
|---|---|
| `src/routes/manufacturing/cart-mfg/+layout.svelte` | Four arm nav entries → one; prefix `isActive` |
| `src/lib/server/robot-arm-client.ts` | `listCameras`, `getCameraSnapshot` (+ start/stop iff Q2 = yes) |
| `src/routes/manufacturing/cart-mfg/robot-arm/control/+page.svelte` | Drop the page-level `<h1>`, now owned by the layout |
| `…/jog/+page.svelte`, `…/calibrate/+page.svelte`, `…/runs/+page.svelte` | Same `<h1>` de-duplication only — **no logic changes** |

**Remove:** nothing. No route is deleted; no action is deleted.

**Pi repo (`C:\Users\aleja\robot-arm`, S0)**

| Path | Change |
|---|---|
| `src/server/cameras.py` | Commit (currently untracked) |
| `src/server/app.py` | Commit the camera endpoints |
| `src/config/hardware.yaml` | Commit the `external` camera block |
| `.env` on the Pi | Confirm `EXTERNAL_CAM_DEVICE` / `EXTERNAL_CAM_INDEX` resolve |

---

## Appendix B — Reference Pointers

**Files**
- `src/routes/validation/+layout.svelte` — the tab pattern to copy
- `src/routes/manufacturing/cart-mfg/reagent-filling/+layout.svelte` — nested sub-layout precedent
- `src/routes/manufacturing/cart-mfg/+layout.svelte:32-35` — the four nav entries
- `src/routes/manufacturing/cart-mfg/robot-arm/{,control,jog,calibrate,runs}/` — the pages
- `src/lib/server/robot-arm-client.ts:363-368` — the 30s budget comment
- `src/routes/capture/+page.svelte:53-57` — MJPEG viewer prior art (network model rejected)
- `src/routes/api/cv/stations/[id]/token/+server.ts` — token mint, relevant only under Q1 = direct
- `svelte.config.js:7-11` — `maxDuration: 30`
- Pi `src/server/app.py:810-854` (view cookie, `samesite="strict"`), `:857-905` (camera endpoints)
- Pi `src/server/cameras.py:319-337` (status fields), `:339-346` (`frames(max_fps)`), `:408-411` (status never starts a worker)
- Pi `src/config/hardware.yaml` — `external` active, `gripper` commented out

**PRDs**
- `docs/prds/ARM-01-pi-connection-and-task-control.md` — G0, the Funnel path (§4.4), compute-on-read (§6), the anti-capture-station argument (§7)

**Branches**
- BIMS: `feat/robot-arm-page-consolidation` (off `master`) — this work
- BIMS: `feat/arm-pi-connection` (off `NEWDEV`) — ARM-01, sibling
- Pi: `feat/multi-pose-calibration` — holds the **uncommitted** camera stack (S0)
