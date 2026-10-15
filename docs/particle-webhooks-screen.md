# Particle Console webhooks — screen pipeline (firmware v102, BIMS feat/screen-pipeline)

**Date:** 2026-10-13. Companion to `brevitest-device/firmware/Docs/DEVICE_SCREEN_PIPELINE_PLAN.md`
and `V96_BLANK_SONIC_LASER_HANDOFF.md` (the `blank-test` webhook these copy).

All five webhooks post to the same BIMS endpoint and use the same header as `blank-test`. One
webhook per event name (Particle matches by prefix, so **do not** create one for `bioscale/` alone —
it would also catch `bioscale/blank-test` and any future event).

| Setting | Value |
|---|---|
| URL | `https://bioscale-operations-system-mongodb.vercel.app/api/particle/webhook` |
| Request type | POST |
| Request format | JSON (default fields: `event`, `data`, `coreid`, `published_at`) |
| Custom headers | `x-agent-api-key: <AGENT_API_KEY>` (the BIMS env value) |
| Device | Any (product) |
| Response template | leave default — the device only needs the hook-response to arrive; BIMS replies JSON |

## Events

| Event name (exact) | Firmware publishes | BIMS does | Notes |
|---|---|---|---|
| `bioscale/screen` | one JSON string per level part + a lvl-9 summary (`run_screen`) | assembles one `validation_sessions` doc type `screen` per (device, run); on the summary judges it against `screen_criteria` and writes `spu.validation.screen` | idempotent on (device, run, lvl, part); events may arrive out of order |
| `bioscale/ping` | `{"nonce":n,"fw":102}` (SCREEN level 3, ×reps) | replies `200 {"ok":true,"nonce":n,"at":"<ISO>"}`, stores nothing | the device times `publish → hook-response`; **Response template** can stay default (the body is the JSON) |
| `bioscale/screen_record` | BINARY chunks `<id>\|<seq>\|<total>\|<base64 lines>` of the 11,628-byte test record of each level-2 run; id = run×10 + runIndex | stores chunks (`device_chunks`), assembles when all seqs present, base64-decodes, parses the record + v2 stage tail, attaches it to the screen session as `rawData.records[runIndex]` | Particle delivers BINARY as `data:application/octet-stream;base64,…`; BIMS decodes the outer base64 first |
| `bioscale/mag_sweep_chunk` | BINARY chunks of the `/sweep` file (`run_sweep`), `spu-mag-sweep-means/v1`, header gains `seg=`/`pitch=` on v102 | stores chunks, assembles, parses, analyses (peak, gradBzdz, forceIndex per well/lane), creates a `validation_sessions` doc type `mag_sweep`; writes `spu.validation.magnetometer` only when `mag_criteria` carries `minGradient` / `minForceIndex` | seq is 0-based; a job with holes stays `receiving` and is listed on the pages |
| `bioscale/sweep_progress` | `{"id":<sweep id>,"i":<points done>,"of":<points>}` every ~10 positions | updates `device_chunk_jobs.progress` for that sweep id | not logged as a DeviceEvent |

`spark/status` (online → service-flag re-push) and `blank-test` stay as they were.

## Integration docs (criteria) — create in Mongo or through the pages

| `integrations.type` | Written by | Shape |
|---|---|---|
| `screen_criteria` | `/validation/screen` → Criteria | `{ criteria: { "<test id>": { min?, max?, warnOnly?, ignore? } } }` — keyed by exact id (`homerep2`), bare id (`homerep`) or run suffix (`run_err`) |
| `assay_run_criteria` | `/validation/assay-run` → Criteria | `{ criteria: { minRuns, beadIndexMin, beadIndexMax, beadIndexCvMax, resultCvMax, stageErrorMaxUm, stageHitsMax, laneCToleranceFrac, beadIndexNum, beadIndexDen, resultExpression, sampleLanes } }` |
| `mag_criteria` | `/validation/magnetometer/run` (existing `minZ`/`maxZ`) | add `minGradient` and/or `minForceIndex` to make cloud sweeps judge the magnetometer gate |

Until a criteria doc exists: screens use the device's own P/F/W per row; assay-run groups use the
defaults in `src/lib/server/assay-run/evaluate.ts` (3 runs, no bead-index window, 0 hits allowed);
sweeps are stored as information only.

## Ops checklist

1. Create the five webhooks above in the Particle Console (product scope), header included.
2. Flash v102; press **Screen** on `/validation/screen` for a unit with an empty slot.
3. Watch `/validation/screen`: level events appear within seconds of each level finishing; the
   summary closes the session (~75 min for all four levels, ~5 min for `013`).
4. Check `/api/particle/webhook` logs (Vercel) for 400s — a 400 names the event and the reason.
5. For sweeps: `run_sweep` from the Console or the magnetometer page; the session appears when the
   last chunk lands (~2 min for a full sweep, ~15 s for a peaks sweep). A job stuck at
   `received < total` means chunks were lost: run the upload again from the device.

## Device → BIMS contract (what the firmware must emit)

- `bioscale/screen` level event: `{"v":1,"fw":102,"run":<seq>,"lvl":0|1|2|3,"part":n,"of":m,"t":[[id,status,value,limit,ms,note?],…]}`;
  status ∈ `P F W S I`; value number or short string; limit number or null; ms uint; note string.
  Level 2: one event per run, `part` = run index, `of` = reps.
- `bioscale/screen` summary: `{"v":1,"fw":102,"run":<seq>,"lvl":9,"pass","fail","warn","skip","info","ms","levels":"0123","reps":3,"assay":"AE9DE09B","aborted":""}`.
  An abort appends row `["abort","F",…,reason]` to the running level and sets `aborted`.
- Test ids (bare, rep digit appended for repeated tests): level 0 `fw reset uptime eeprom fs fs_val
  fs_assay fs_sweep assay assay_son mem detect limit0 therm specA specB specC pd0A pd0B pd0C radio
  scanner ble`; level 1 `wake home homerep travel lsrA lsrA_c lsrA_f1 lsrA_f7 drkA bgA bgA_f7 (B, C)
  spec_sat hits hits_first travel_um heat_cold heat_start heat_over heat_hold heat_duty heat_off buzz
  led`; level 2 `run{N}_heat run{N}_assay run{N}_err run{N}_hits run{N}_first run{N}_home_ms
  run{N}_travel run{N}_dur_s run{N}_hitms run{N}_temp run{N}_reads run{N}_done`; level 3 `cloud sub
  pending ping repo logup`.
- `run_screen` cloud function: argument `"levels,reps,assay"` (BIMS sends `"0123,3,"`); returns
  1 queued, −1 busy, −2 cartridge inserted, −3 assay file missing, −4 bad args, −5 upload in flight.
- Record tail v2 (offset 11,604): `uint32 travel_um`, `uint32 home_ms`, `uint32 hit_ms[4]` →
  11,628-byte record; BIMS `parseStageTail()` reads v1 and v2.
