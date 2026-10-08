# OT-2 simulator — test the Robots page without a robot

**Temporary test rig. Remove `scripts/ot2-sim/` and run `seed.ts --teardown` before the
final ship.** Nothing in `src/` knows this exists: the simulator talks to BIMS exactly the
way a real OT-2 plus its bridge daemon do.

## What it is

- `seed.ts` writes three fake robots (`SIM Robot S01..S03`) and everything a fill needs:
  a deck, a wax lot, a reagent set lot with an open fill lot, a default scanner position
  set per robot, and 72 cartridges in `backing` (`SIM-W-0001…`, for wax) plus 72 in
  `wax_filled` (`SIM-R-0001…`, for reagent). All ids start with `sim-` / `SIM-`.
- `daemon.ts` impersonates those robots. It answers the robot HTTP API in memory
  (`fake-ot2.ts`), polls the BIMS command queue as their bridge daemons, posts heartbeats so
  the board shows Ready / Running, answers deck scans with `SIM-DECK-001` and cartridge
  sweeps with the seeded barcodes, and "runs" a protocol over `--run-seconds` while emitting
  the comment lines BIMS's finish step parses (`Dispensed … into well X2`, `TIP TRACKER …`).

It works against a Vercel preview (the queue is pull-based, so the daemon can run on any
laptop) and against local `npm run dev` (where the server calls `127.0.0.1:3195N` directly).

## Use

```
# 1. fixtures (safe to re-run; upserts)
MONGODB_URI=… npx tsx scripts/ot2-sim/seed.ts

# 2. the robots — leave this running
BIMS_BASE_URL=https://<preview>.vercel.app AGENT_API_KEY=… MONGODB_URI=… \
  npx tsx scripts/ot2-sim/daemon.ts --run-seconds 60

# 3. open /manufacturing/cart-mfg/robots and drive the three SIM panels:
#    wax prep → pick lot SIM-WAX-0001 → scan deck (robot answers SIM-DECK-001) →
#    cartridge sweep (robot answers SIM-W-…) → Start → run finishes in --run-seconds →
#    Finish. Reagent: fill lot FL-SIM-001, sweep answers SIM-R-….

# between cycles: put the sim carts back
MONGODB_URI=… npx tsx scripts/ot2-sim/seed.ts --reset-carts

# when done
MONGODB_URI=… npx tsx scripts/ot2-sim/seed.ts --teardown
```

`AGENT_API_KEY` is the deployment's agent key (Vercel env). `MONGODB_URI` is the same
database that deployment uses — the sim robots appear on the Robots page for everyone
logged into it, so tear down when finished.

`npx tsx scripts/ot2-sim/daemon.ts --selftest` exercises the fake robot alone (no BIMS, no
database): create → play → finish, the well mapping, and a multipart upload.

## What is NOT simulated

- Motion, the scanner, the tip calibrator: deck scans, sweeps and tip calibration return
  instantly with canned results. Restart server just clears the fake run list.
- The tailnet (direct browser) line: sim robots are queue-mode. Keep them that way.
- Protocol analysis: the "analysis" echoes the labware definitions in Mongo (or the ones in
  a re-upload bundle), which is what the run-start freshness gate checks.

## Removal

```
MONGODB_URI=… npx tsx scripts/ot2-sim/seed.ts --teardown
git rm -r scripts/ot2-sim
```
