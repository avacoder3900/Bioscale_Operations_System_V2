# PRODUCTION-READY — Opentrons Clone (Step 1.5)

**Domain:** DOMAIN-12 — Opentrons Clone Production Readiness
**Branch:** `feature/opentrons-clone-ui`
**Verified against:** `hidden-leaf.local` (OT2CEP20200217B07, API 8.7.0, firmware v1.1.0-25e5cea)
**Last run:** 2026-04-20

The BIMS `/opentrons-clone` section is a drop-in replacement for the Opentrons
desktop App during run setup. An operator can complete a full real-protocol run
(custom runtime parameters, verified labware placement, verified pipettes,
calibrated labware offsets) without leaving BIMS.

---

## Verify-script results (38/38)

Run:
```
npx tsx scripts/verify-opentrons-clone.ts hidden-leaf.local
```

| Row | Check | Result |
|-----|-------|--------|
| 1–5 | Health, server version, instruments, modules, calibration | ✅ |
| 6–10 | Protocols list / upload / detail / analysis / delete | ✅ |
| 12–19 | Runs list / create / detail / currentState / actions (play/pause/resume) / commands / commandErrors / delete | ✅ |
| 21 | Home robot | ✅ |
| 22 | Lights (read + write) | ✅ |
| 23 | Identify (blink) | ✅ |
| 25 | Labware offsets (read) | ✅ |
| 27, 29 | Settings list + reset options | ✅ |
| 30 | Server logs download | ✅ |
| 31 | Error recovery settings | ✅ |
| 32 | Networking | ✅ |
| 33, 34 | Data files + client data K/V | ✅ |
| 35 | System time | ✅ |
| **36** | **Maintenance run lifecycle — POST/GET/DELETE round-trip** | ✅ |
| **37** | **Maintenance command — `home` enqueue with `waitUntilComplete`** | ✅ |
| **38** | **Offsets atomic — malformed `labwareOffsets` → 4xx, no orphan run** | ✅ |
| **39** | **Offsets happy path — valid offset attached on run create, cleaned up** | ✅ |

Rows 36–39 were added in OT-D4 as the HTTP-level production-readiness smoke
test for the LPC infrastructure (OT-D1 → OT-D3).

---

## Production-readiness stories (Step 1.5)

| Story | Feature | Commit |
|-------|---------|--------|
| OT-A | Runtime parameters form (number / bool / enum / CSV) wired to `runTimeParameterValues` + `runTimeParameterFiles` | `81c36e2` |
| OT-B | Deck / labware setup checklist — Create Run gated per slot | `f83b938` |
| OT-C | Pipette attach confirmation vs `/instruments` | `7d8b7c3` |
| OT-D1 | Typed maintenance-run wrapper + command-allowlist endpoints | `fe40eb7` |
| OT-D2 | LPC wizard — jog pad, step-size, per-labware savePosition | `e77c362` |
| OT-D3 | LPC offsets persisted and atomically applied on `POST /runs` | `6451487` |
| OT-D4 | Verify-script rows 36–39 + this document | `d4dd4bc` |

---

## Manual walkthrough (operator, ~10 lines)

Before each production run on a BIMS-managed OT-2:

1. Navigate to `/opentrons-clone` and pick the robot (health must be green).
2. Click "Protocols" → upload the `.py` protocol → wait for analysis to read `completed`.
3. Open the protocol. Fill in runtime parameters (cartridge count, CSV file, etc.).
4. Tick each labware slot on the Deck Setup checklist as you place the labware.
5. Confirm the Pipettes card is green (both required mounts show "have" == "needs").
6. Click **Run Labware Position Check** → pick a tip rack → Attach tip → jog to well A1 of each labware at 1 mm steps, Save, repeat.
7. On the Review screen, click **Apply and Create Run** — the offsets land in `sessionStorage` and you return to the protocol page with a banner.
8. Create Run (button becomes active once deck/pipettes/params are green). The offsets POST atomically with the run.
9. Observe `/opentrons-clone/:robot/runs/:id` — live command list, pause/resume/stop, command errors, final status.
10. After a run finishes, delete it from the Danger Zone if it's no longer needed.

---

## Known limitations (still requires Opentrons App)

- **Pipette offset / tip length / deck calibration** — the clone reads calibration
  status but does not run the calibration wizards. These are maintenance flows,
  not per-run, and are out of scope per §1.4 of `DOMAIN-12-OPENTRONS-CLONE-PROD-READY.md`.
- **Modules** — no module setup UI. None of the three robots (hidden-leaf,
  muddy-water, OT2CEP20210817R04) currently have modules attached. If/when one
  is, a module-setup surface should be added.
- **Protocol `.py` source download** — OT-2 API 8.7.0 does not expose raw
  `.py` source. The `asDocument` analysis JSON is exposed via
  `/api/opentrons-clone/robots/:r/protocols/:p/analysis/:a/document` instead.
- **Enqueue arbitrary commands on a run** (`POST /runs/{id}/commands`) — parked;
  the LPC infra uses maintenance-runs for ad-hoc motion, which covers the need.
- **Protocol API version** — protocols on these robots are API 2.19. Newer
  protocols have not been exercised.

---

## How to reproduce

Required env:
```
# .env — populated manually; never committed
AGENT_API_KEY=<shared key>
MONGODB_URI=<Atlas URI>
SESSION_COOKIE=<any bcrypt-hashed secret>
```

Commands:
```bash
# Install + run dev server
npm install
npm run dev

# Live robot verify (38 HTTP-level checks)
npx tsx scripts/verify-opentrons-clone.ts hidden-leaf.local

# Type check (pre-existing errors outside opentrons-clone are known; the
# opentrons-clone surface should be clean)
npm run check
```

Operator-admin gate: the first time you hit `/opentrons-clone`, the gate
prompts for the `opadmin` password (see `src/hooks.server.ts` and the
`opadmin` cookie in `src/routes/opentrons-clone/+layout.server.ts`). The
cookie is valid for 8 hours.

---

## Guardrails that stayed intact

- **No new Mongoose models.** Everything is stateless HTTP pass-through.
- **No `AuditLog` entries for robot actions.** Robot state is ephemeral mechanical state, not business state.
- **No DB caching of robot state.** The only Mongoose touch is reading `OpentronsRobot` for the IP/port lookup.
- **No changes to `src/routes/manufacturing/wax-filling/`, `reagent-filling/`, `opentron-control/`, or `src/routes/opentrons/`.** The clone lives entirely under `/opentrons-clone/*`.

---

## Next steps (out of scope for this domain)

- Wire `/opentrons-clone` into the existing `/manufacturing/opentron-control`,
  `/manufacturing/wax-filling`, and `/manufacturing/reagent-filling` flows. That
  was deliberately deferred to Step 2.
- Add a module setup surface once modules are attached to any of the three OT-2s.
- Revisit pipette-offset and deck-calibration wizards if the Opentrons App
  becomes unavailable.
