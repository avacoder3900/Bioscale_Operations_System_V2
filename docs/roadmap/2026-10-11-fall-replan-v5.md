# Fall 2026 Roadmap — v5 (October 11 re-plan)

**Anchor:** A4M conference debut, Dec 11–13 (fixed) · **Supersedes:** Fall 2026 Roadmap v4 (Aug 20) · **Workshop:** Jacob + Claude, 2026-10-11
**Sources:** live board (226 items), Jacob's spoken state-of-the-company + phone notes (recency-biased, bottom = freshest), git history of BIMS / brevitest-research-v2 / brevitest-device / bioscale-app / brevitest-model (Aug 25 → Oct 6), the Verification-and-Validation repo (campaign V2, handoff Rev D 2026-09-25), BIMS progress log Sept 22 → Oct 5, experiments 357/358/359/361/363 analyses.

**Key:** ✅ existing, kept · ✏️ existing, updated · 🆕 captured today · ❌ declined/merged today · ❄ icebox · 🎯 milestone

---

## 0. What changed since v4 (the five facts that re-plan everything)

1. **The thermal-seal film cannot ship.** Riley's shipping test showed the seal adhesive is dissolved by nondecane at ~28 °C. The cartridge is pivoting, in the eleventh hour, to **two acrylic halves joined by ultrasonic welding** (new mold; heat welding acrylic-to-acrylic already works as the fallback). Every "final cartridge" assumption in v4 — recipe lock, stability, V&V, kit — now sits behind a mold that is not yet cut.
2. **The device "holy grail" was not found, but something better was.** A month of optical scans, laser/dark bench reads, blank and sonic tests, mag sweeps and thermo on ~30 units found no optical measure that predicts assay results (optical ratio vs assay bead index ρ≈0.10). What *does* predict the curve is **bead delivery** (loaded/baseline F3 — a stable channel property), and bead delivery is predicted by the **magnet field gradient** from the sweep (ρ 0.84), not by the peak field the old mag test reads. Optical QC is therefore dropped from the device gate; the sweep gradient and a real assay run become the gate.
3. **Of ~30 units, ~9 are trusted.** The Sept plan (build 20 new SPUs, release on the 3-test suite) is replaced by: build the standardized **screen pipeline** first, then re-screen the fleet, then build. The pipeline: one-click SCREEN (laser-into-filter blast — this is what caught the distal filter slipping out of its slot — plus 6.1 assay ×3 with no cartridge using the v101 missed-step counter) → quick mag sweep → thermal → real cartridge run.
4. **V&V campaign V1 is void; V2 exists on paper only.** Javier's repo now holds ten CLSI-shaped protocols (1,605 cartridges), a repaired toolchain, `fit_4pl.py`, bench cards — and two blocking findings: the pre-V&V curve **saturates by ~20 µg/dL** (IC50 5.1 µg/dL; 20 vs 30 indistinguishable; bead density must move toward IC50 ≈ 7 µg/dL) and the **calibrator values are unresolved** (9 % scale vs an orthogonal kit, 50 µg/dL point reads 90 — exactly the failure class that voided V1).
5. **Software outran the bench.** Analysis v3, lot calibration workbench, reagent/fill lots, curve sets, stored samples, processed export v2, Leo's joint model + QC filter + lane features ported into the engine (DOMAIN-30…35), firmware v96→v101 (BLANK/SONIC/bench reads, mag sweep, stage check), SPU inventory/servicing/validation hub rework, 5,000 Zebra labels, October cartridge reconciliation (1,078 scrapped, 599 counted at wax-filled). The data layer is ahead of the physical product.

**Consequence:** the v4 critical structure ("everything hangs off a Sep 11 recipe lock") is dead. The new structure has **two physical gates** — the welded cartridge and the trusted-device pipeline — and A4M is re-scoped to a **frozen demo configuration**, not a completed V&V.

---

## 1. Milestone chain (dates are the scheduler's anchors; provisional ones say so)

| # | Milestone | Date | Gated by | Status / note |
|---|---|---|---|---|
| 🎯 TASK-127 | Robot-arm wax filling end-to-end | **Oct 31** (was Sep 30) | heated chute, cart transfer, long-cycle proof, synchronized protocol | solenoid/chute integration done (TASK-182); fixturing + heated chute "almost done" |
| 🎯 TASK-185 🆕 | Sample-collection kit v1 ships | **Nov 6** | diluent tube seals 100 %, finger-stick SOP, 4-cart box prototype, lancets/gauze/stickers | diluent lids leak today; PP boba-lid material on trial |
| 🎯 TASK-111 ✏️ | 20 trusted SPUs through the new screen pipeline | **Nov 6** (was Oct 6, retitled) | filter-slot fix, SCREEN firmware+BIMS, quick sweep, thermal std, assay-as-test-#4, thresholds | replaces "build 20 then validate on 3 tests" |
| 🎯 TASK-184 🆕 | Welded acrylic cartridge proven | **Nov 13 (provisional — set from the mold quote)** | mold cut, welding bring-up, nondecane soak + courier loop, 50 carts run a curve | the biggest schedule risk in the company |
| 🎯 TASK-089 ✏️ | Recipe lock — cortisol v1.0 | **Nov 14** (was Sep 11) | welded cart proven, IC50/bead-amount decision, 200-cart algorithm experiment, lane choice | no longer gated by TASK-004/005 (declined) |
| 🎯 TASK-186 🆕 | A4M demo configuration frozen | **Nov 20** | cartridge gen, recipe, firmware, app build + algorithm, kit contents, IFU v1 | after this: bug fixes only |
| 🎯 TASK-090 | A4M conference debut | **Dec 11** (fixed) | TASK-186, external testing round 1, IFU/video v2, photos, app pass 2, SPU packaging, drop test | **no longer gated by the CLSI studies or the gold-standard study** (see §4 D-1) |
| 🎯 TASK-187 🆕 | V&V campaign V2 master curve locked | **Dec 4 (provisional — realistically post-A4M)** | welded cart, bead density re-target, calibrator root cause, fleet pre-qualified, Excel templates | gates all ten CLSI studies |

Scheduler reality (kanban_roadmap, Oct 11, before this re-plan): velocity 14.6 est-days/week (blend of policy 10 and measured 16.9), every milestone infeasible (recipe lock −23 d, robot arm −18 d, 20 SPUs −9 d, A4M −24 d), 101 open tasks wired into no chain. Most of the "infeasible" was dead links to declined/deleted blockers (cleaned today) and unsized captures; re-run the roadmap after processing the new captures.

---

## 2. Programs

### 2.1 Cartridge pivot — `Cartridge` → 🎯 TASK-184

- 🆕 **Design + cut the two-half acrylic mold for ultrasonic welding.** Get the quote lead time first and set TASK-184's date from it. Include the lane-geometry decision (2.3) in the mold, not after it.
- 🆕 **Ultrasonic welding process bring-up** — horn/anvil fixture, energy-director design, weld parameters, leak test; heat welding (already showed early success) stays as the fallback path. Ultrasonic is expected to be much faster once dialed.
- 🆕 **Nondecane seal-soak acceptance test** — 28 °C/48 h and 37 °C soak + courier loop for welded carts; run the *same* test on thermal-seal carts to set the interim shipping limit. This is the pass/fail for TASK-184.
- 🆕 **SPIKE (5 d): hematocrit by absorbance in the new cartridge** — Leo's idea: can the new cart measure HCT optically and correct the fingerstick-to-serum concentration (`dilution.py` currently *assumes* 45 % HCT)? Answer decides whether the welded mold needs an optical window for it.
- ✏️ TASK-181 (WIP) **thermal-seal process/tool optimization** → now the *bridge* for every cart filled before the welded line exists; phone note folded in: fix the flexible piece and get a solid press with no depressions.
- 🆕 **Interim cold-chain shipping rule for thermal-seal carts** (until welded carts ship) → feeds TASK-018 ship testing and any kit that leaves the building before Nov 13.
- 🆕 **Wax-cart leave-out test read-out** (fridge vs bench since 9/24) and 🆕 **orientation test** (does packaging orientation affect filled-cart stability?). ✏️ TASK-105 evaporation experiment has waited 45 days "on results" — report or decline.
- ✏️ TASK-015 **diluent tube sealing at 100 %** ← ❌ TASK-178 merged in. Lids don't seal; trialing the polypropylene used for boba-cup lids. Blocks TASK-185. 🆕 **Diluent-tube fill/seal station** (phone: "sample diluent tube station").
- ✏️ TASK-157 **tight SOP for user sample loading** (capillary tube + diluent tube) → blocks TASK-185.
- 🆕 **Choose the product lane (A/B/C).** V&V fills 3, product fills 1, the choice is "not yet chosen" (BT-SPEC-002 §2). Bead delivery has a lane gradient (A 10.3 > B 8.0 ≈ C 7.9). Decide before the mold and before the master curve.
- ✏️ TASK-163 (WIP) **~1,000 wax-filled carts for V&V** → reality after the Oct 5 reconciliation: 599 counted at wax-filled (+12 to restore), 48 on the robots. Phone: first priority 350; 2 decks/run = 48; minimum pace 3 runs / 6 decks a day (≈144/day); shift system. 🆕 **Cartridge production shift system** (chore). 🆕 **Cartridge assembly line layout + station ownership** (Poorvi: cartridge line + 1000 µL mixing; Sam: cart system / hole punch (done) / white device).
- ✅ TASK-175 tracer-in-well-1 diagnostic · ✅ Order new wax tubes · ✅ Opentron lot-tracking API (dead blocker removed) · 🆕 **Automatic tip inventory** (software, short).
- ❄ TASK-043 acrylic-back thermal welding → superseded by the pivot (merged into the welding bring-up task).

### 2.2 Device trust pipeline — `SPU` → 🎯 TASK-111

Order of operations: **fix the filter slot → build SCREEN → re-screen the fleet → then build new units.**

- 🆕 **Fix the distal filter slipping out of its slot** (design fix + rework every unit before re-screen). Found by the laser-into-filter blast.
- 🆕 **One-click SCREEN test (firmware + BIMS button)** — laser-into-filter blast (reuse the v96 `laser_read` path) + Cortisol 6.1 ×3 with no cartridge, stage check (v101) recorded each run; result lands on the SPU validation hub as test #1. Phone: "Build screen super scan instant activation button."
- 🆕 **BIMS ingests v101 `stage_check`** (end error, limit hits, first hit) from assay + SONIC runs, flags "actual position f-ups", pass limit set *after* measuring click repeatability on several units (0255 alone reads −50…−100 µm; waking the motor shifts the stage up to 0.8 mm — see V101 handoff). Includes "is the limit switch busted?" and "does travel distance cover oscillation travel?".
- 🆕 **Quick magnetometer sweep** (short form of v97/v98) with **gradient / forceIndex** as the reported metric (peak Z stays informational); sweep 0221/0246/0211; inspect 0247's wrong magnet pitch. 🆕 **Incoming magnet QC** — sort magnets by field/pitch before SPU assembly ("filter out magnets of certain values").
- 🆕 **Thermal test standardization** — thermocouple tool is temperature truth; fix `parse-thermo.ts` per-sensor averaging and re-upload the Sept 8–10 xlsx files (16 of 27 fleet-check devices have no per-sensor data). ✅ TASK-162 time-to-45 °C / green-LED study relates. ✏️ TASK-138 heater-block wrap (Cricut → try laser-cut). 🆕 **Build heat tool #2** (the Oct 6 heater-press setpoint-controller firmware is this).
- ✏️ TASK-179 (ready) **assay run as validation test #4 in BIMS** ← ❌ TASK-019 merged in. ✏️ TASK-172 (ready) **passing thresholds for the fleet** ← ❌ TASK-020 merged in. Both now block TASK-111.
- 🆕 **Fleet re-screen campaign** — blank cart on each device, sonic on each device (start gathering the data), Group 4 triplicate at one concentration (decide whether Group 3 joins first), Group 3 board/stage swap to remove the outlier (✅ TASK-174, ✅ TASK-171 7153c/202), Group 2 degradation test ×2.
- 🆕 **R&D units: inspect timing belts and re-validate** (Timing Belt investigation closed 9/15 on the production units).
- 🆕 **Firmware: heater off if a cartridge sits > 1 min without a test** · 🆕 **Deployed-device assay maintenance** — at plug-in check the published-assay repo and fetch what is missing · 🆕 **Fleet on one firmware** (v101 everywhere; today v95…v101 mixed) · ❄ **Magnetometer board redesign** (magnetometers + mics + temp sensors).
- ✅ TASK-134 (ready) Wi-Fi configure on BIMS + app · ✅ TASK-069 connectivity across networks · ✅ TASK-153 finalize SPU data structure (phone: "SPU record / audit data flow; confirm where validation data lives" — see the 2026-09-04 drift audit) · ✅ TASK-123 error-log ordering · ✅ TASK-024 known-bug burn-down.
- ✅ Build: blocked WI v0 task (owner Alejandro — "SPU work instruction system"), ✅ TASK-121 phases, ✅ TASK-122 build sprint (dead blockers removed; re-gated behind the pipeline), ✅ TASK-124 validate & release, ✅ TASK-021 templatized build (steady state). Phone: "discuss subassembly build process", "finalize SPU build WI", "Mst — SST SPU assembly line".
- ✏️ TASK-159 white SPU enclosures (Sam) ← ❌ TASK-095 merged in.
- 🆕 **Optics R&D backlog (not a gate)** — laser power vs ratio scatter / wavelength drift, QD-in-cartridge brightness stability, lane gradient for optics, well-1 and well-3 baselines, mirror, filter on/off toggles, 5th-well spec readings vs device, "what is the optical ratio CV" (answered: reinsertion 1.5 %, fleet 5.2 %). ✅ Compare macro-fab spec values to laser values.
- ❌ TASK-120 SPU inventory UI, ❌ TASK-126 new SPU UI, ❌ TASK-137 withdraw-kit button — all shipped (SPU-INV-01…12, kit withdrawal 9/08). ❌ "Create an optical test for the SPU" — shipped (confirmation, degradation, blank, dark, laser bench).

### 2.3 Chemistry + algorithm — `Cortisol Assay` → 🎯 TASK-089, 🎯 TASK-187

- 🆕 **Agree the IC50 target + bead amount for both lots** — V&V analysis: IC50 ≈ 7 µg/dL (70 ng/mL) minimizes worst-case concentration CV (11 %) across 2–30; Jacob's note: IC50 95 ng/mL spans 37–257, 77 spans 27–218. Settle one number; it drives bead batch size.
- 🆕 **200-cart algorithm experiment** (phone "Get exp going") — both lots, agreed design, time point 2 to confirm whether the bead-delivery → IC50 relation persists; blocks recipe lock. 🆕 **Recipe candidates to test** feeding it: 0.15 % Tween buffer, more Tween in the sample well, more beads than 50, one big bead batch.
- 🆕 **Stability experiment v2 on the 6.1 scan** (~160 carts) — two lots, bead/tracer component decomposition (make tracer and beads day-of), ✅ TASK-148 room-temp arm, lot variability. The Sept stability lot (A67AC662-41434773772) used different QDs and must never be pooled with 357+ lots. ✏️ "Initial Stability Experiment" (waiting since Sep 22) → write the Day 2/8/15 read-out and close.
- ✏️ TASK-180 (ready) **new calibrator set before V&V** — now carries the V&V findings: gravimetric vs orthogonal kit differ 9 %; 50 µg/dL reads 90; discriminating test = 1:2 dilution of the top calibrator; verify CRM stock mass before spiking (BT-SOP-001 evaporation controls). **Do this before filling 350 curve carts.**
- 🆕 **Spiked CSS vs native serum comparison** ("does spiked CSS compare?") · 🆕 **Buffer-background experiment from normal cartridges** · ✅ NTA particle analysis pt 2 · ✅ TASK-044 QD conjugation stirring · ✅ QD filtering/populations · ✅ spectral overlap 480/630/555.
- ✏️ TASK-059 **finalize calibration curves** — DOMAIN-31/32 shipped (lot calibration workbench, human-approved fits, reagent lots → fill lots → curve sets, per-well/joint curves). ✏️ TASK-060 **finalize result algorithms** — the algorithm's jobs per Jacob: compare spiked CSS, adjust for stability drift, adjust for lot differences, relate a curve to something else, **invalidate carts**. State: baseline 4PL on ΣF7/ΣF3 in production; Leo's joint F7–F3 model, per-lane QC filter (score + pair rules), lane features ported (engine 2.4.0, DOMAIN-35) as comparison columns; transformer not shipped. The zero well (lane C) does **not** correct A/B (r 0.11) but **does** catch fluidics failures — so "invalidates carts" is achievable now, "corrects for device" is not. ✏️ TASK-061 **run-validity framework** — build on the QC rule kinds + excluded-device list.
- ✅ TASK-007 publish recipe v1.0 → now lists cartridge gen, bead lot/amount, tracer, release buffer, Tween, bcode 6.1, lane.

### 2.4 Human testing + V&V — `Human Testing`, `Validation` → 🎯 TASK-187

Jacob's four-experiment program (phone) sits *before* Javier's ten CLSI studies and is not the same thing:

| Jacob's program | carts | board |
|---|---|---|
| 1. Release chemistry with finger stick, Arbor kit, ≥10 people | ~60 | 🆕 captured (+ 🆕 buy another Arbor kit) |
| 2. Initial stability with different lots, bead decomposition, algorithmic adjustment, serum-validated samples, more curve points, NTA | ~160 | 🆕 stability v2 (2.3) |
| 3. Intended use / map diurnal curve | ~144 | ✅ TASK-008 protocol, ✅ TASK-009 round 1, 🆕 2-day × 3-person Fri/Sat pilot, ✏️ TASK-086 devices = trusted-pipeline output, ✅ TASK-087 chemicals/carts/curves |
| 4. Clinical agreement v1 | — | ✅ TASK-052 mass-spec lab, ✅ TASK-053 design, ✅ TASK-054 run (formal version = EP09/EP35 below; CRO + LC-MS/MS lab + IRB all outstanding, IRB package drafted BT-IRB-001) |

❌ TASK-084/085 diurnal protocol v2/v3 — declined (revisions of TASK-008, and they wrongly gated the CLSI studies).

**Campaign V2 (Verification-and-Validation repo) — the formal studies, all gated by 🎯 TASK-187:**

| Study | Protocol | Carts | Board |
|---|---|---|---|
| Master curve (2 lots, 10 SPUs, 7 levels) | BT-PROT-011 Rev E | 140 | 🆕 — the task that *delivers* TASK-187 |
| Precision EP15-A3 5×5 | BT-PROT-001 Rev D | 290 | ✏️ TASK-056 |
| LoB/LoD/LoQ EP17 | BT-PROT-002 | 312 | 🆕 |
| Linearity EP06 | BT-PROT-003 | 93 | ✏️ TASK-055 |
| Interference EP07 + cross-reactivity | BT-PROT-007/008 | 200 + 140 | ✏️ TASK-058 (interferents kit still waiting on Javier, 40 d) |
| Stability A reagent (13 months!) | BT-PROT-004 | 128 | 🆕 — start T=0 the day the curve locks |
| Stability B calibrator / C specimen | BT-PROT-005/006 | 168 / 34 | 🆕 |
| Method + matrix EP09/EP35 (IRB) | BT-PROT-009/010 | 100 + 50 LC-MS/MS | 🆕 (relates to TASK-054) |
| ❌ TASK-057 recovery study | — | — | declined: not a campaign-V2 study (recovery rides in EP06/EP09) |

**Pre-work that blocks TASK-187** (all 🆕): rebuild the 11 Excel capture templates against the 21-column export; SPU pre-qualification run (mid-level calibrator fleet-wide — this *is* the trusted-pipeline output); fill BT-SPEC-002 TBDs (serials, inventory per lot, sample volumes, named Study Lead/QA/Approver) + `study_readiness.py`; review the 8 Rev-A protocols against V2 inputs; traceability matrix + document register.

### 2.5 Packaging + kit — `Packaging` → 🎯 TASK-185

- ✏️ TASK-013 **kit contents** — largely decided: 2 lancets (high-flow + low-flow), gauze pad, biohazard bag, "let your hands warm up", finger stickers ($0.8/unit, samples coming), 4-cartridge box, return box. Recipe-lock gate removed (kit contents don't depend on chemistry).
- ✏️ TASK-014 (WIP, due Oct 23) **kit design v1** — multi-cartridge box concept settled (space vs size); 4-cart box quoted from Chinese suppliers; prototype to Chris to test. Tariff: $1.63 + $0.39 @1k, $1.23 + $0.27 @10k.
- 🆕 **Qualify the box manufacturer** · 🆕 **Return-logistics decision** (UPS no-pack/no-print vs FedEx no-label/no-box, pack-and-ship voucher $7–12, QR-code service, shipper packs for us) · 🆕 **3D-print sample box + hand Chris test carts**.
- ✏️ TASK-025 **SPU customer packaging** — bigger cardboard box for the SPU box, glue SPU boxes, "bigger tackle-box approach". ✅ TASK-088 functional packaging prototypes for external testing · ✅ TASK-017 foam mitigation · ✏️ TASK-018 ship testing (+ nondecane/28 °C finding) · ✅ drop testing.
- ❌ TASK-016 spike: diabetic lancing device — answered (two lancets per kit).

### 2.6 Filling line + robots — `Filling Line`, `Robot-arm` → 🎯 TASK-127

- Chain unchanged (chute → long-cycle proof → calibration → synchronized protocol → deck). ✏️ TASK-104 heated location (overdue since Aug 27). ✏️ TASK-170 auto picture line (Gio + Alejandro) ← ❌ TASK-029 merged.
- ✅ TASK-168 (ready) calibrate reagent fill + persist calibration · 🆕 **Ethernet control of the OT-2s** (Tailscale done; cables arriving) · ✅ TASK-100 1000 µL mixing (Poorvi) · ✅ reagent filling SOP · ❄ TASK-079 automated reagent filling.

### 2.7 Software — `Software`, `BIMS`, `Research System`, `App`

- **App:** ✏️ TASK-063 MVP pass 1 — Riley storyboarding; Leo's PWA (bioscale-app) now shows the middleware's interpolated result and computes nothing locally (Oct 4). Blocks TASK-186. ✏️ TASK-064 pass 2 ← ❌ TASK-091 merged.
- **Inventory (post-move mess):** ✅ TASK-144 put everything into inventory → ✏️ TASK-145 removal SOP (← ❌ TASK-119 merged; waiting on Jacob 33 d) → ✅ TASK-146 recount. ✅ TASK-107 / TASK-106 dashboards + low-stock. 🆕 **Automatic tip inventory.**
- **Device data:** 🆕 stage-check ingest (2.2) · 🆕 thermo per-sensor fix (2.2) · ✅ TASK-153 SPU data structure.
- **HR / daily ops in BIMS (Jacob builds):** 🆕 **performance reviews**, 🆕 **daily transcriptions**, 🆕 **daily cleaning checklist** (+ shift-system cleaning).
- **Documents:** 🆕 **scanner intake — auto-scan + OCR documents into BIMS** (relates: ROG doc scanning, auto-SDS pull).
- **Research system:** ❌ TASK-037 data export (export v2 shipped), ❌ TASK-033 reagent/solutions inventory (DOMAIN-33/34 shipped); ✅ 032/034/035/036/070/071/072/076 and AI milestones unchanged. ❄ ERP research.

### 2.8 Lab + people — `QMS`, chores

- 🆕 **New lab fit-out** — tables, organization, wall of tools, ROG area, cabinet sample collection. ✅ TASK-152 badges · ✅ TASK-042 preventive maintenance · ✅ TASK-078 CAD hygiene.
- Interns are the capacity story: Gio + Alejandro (robot arm, picture line), Poorvi (cartridge line, mixing), Sam (hole punch done, white device, cart system), Riley (app, shipping tests), Javier (V&V), Leo (model, app, hematocrit ideas), Chris (kit testing).

---

## 3. Board housekeeping done in this workshop

- Dead blockers removed: TASK-007 (4), TASK-017, TASK-018, TASK-009 (declined TASK-092), TASK-055/056/057/058 (TASK-009 and TASK-084 gates), TASK-090 (TASK-085, TASK-094), TASK-122 (3), TASK-127 (1), Opentron API (1).
- Milestones re-dated/retitled: TASK-089 → Nov 14; TASK-127 → Oct 31; TASK-111 → Nov 6 + retitled. Four new milestones TASK-184…187.
- Merges: 178→015, 019→179, 020→172, 095→159, 029→170, 091→064, 119→145, 043→welding bring-up.
- Declined as shipped: 120, 126, 137, 033, 037, "Create an optical test for the SPU". Declined as answered/superseded: 016, 057, 084, 085.
- Iceboxed: magnetometer board redesign, ERP research.
- ~45 new captures with `sourceRef plan:<this plan>`; none committed (commitment is Jacob's in the Kanban UI — see §6 for the suggested first pull).

---

## 4. Decisions Jacob has to make (and by when)

| # | Decision | By | Why it matters |
|---|---|---|---|
| D-1 | **A4M is a demo of a frozen configuration, not a V&V-complete product.** I removed the four CLSI studies and the gold-standard study from the A4M gate and put TASK-186 (demo config frozen, Nov 20) in their place. Reverse if you disagree. | now | With the mold uncut, no CLSI study can run on the final cartridge before Dec 11. Pretending otherwise hides the real plan. |
| D-2 | **Run V&V campaign V2 on the thermal-seal cartridge now (and bridge to the welded cart later), or wait for the welded cart?** | Oct 18 | 1,605 carts + 13-month reagent stability. Running now gives data for the fundraise; bridging later costs a partial re-run. Waiting means V&V starts in December. |
| D-3 | **Product lane A, B or C** | before the mold is cut | Bead delivery differs by lane; V&V fills three to keep the choice open, but the mold and the master curve both want to know. |
| D-4 | **IC50 target: 70 (V&V analysis) vs 77–95 ng/mL (your note)** | before the 200-cart fill | Sets bead amount for both lots and whether the 2–30 µg/dL claim survives. |
| D-5 | **Welded-cart milestone date** | after the mold quote | Everything from recipe lock to demo freeze is keyed off it. |
| D-6 | **December "to market" means what?** Demo units + beta kits under cold chain, or paying customers? | Nov 1 | Decides whether TASK-025/TASK-077 (SPU packaging, finished-goods inventory) and FGI/fulfillment matter in 2026. |

---

## 5. Step back — what we may be missing, mis-prioritizing, or could flip

1. **Treat the diluent tube as a cartridge.** The fingerstick path is 10 µL blood → 110 µL diluted → *one* 70 µL channel. The tube that makes that happen leaks, has no station, and no SOP — and it is in every human experiment from the Arbor kit onward. It gets a fraction of the attention the cartridge seal gets, for an equally fatal failure mode. TASK-185 exists so this has an owner and a date.
2. **Stop looking for a device QC that predicts the assay; look for one that predicts bead delivery.** The data already says what varies is how many beads reach the read well (lane gradient A > B ≈ C, stable per channel, invisible to optics, predicted by field gradient). The screen pipeline should carry a *bead-delivery proxy*: the sweep gradient today, and eventually a cheap bead-only cartridge (no antibody) read on the device. That is the "tie to assay results" you did not get from optics.
3. **The stage is open-loop and nobody noticed for a year.** Eleven cartridges in 350–363 were scanned in the wrong place; waking the motor moves the stage up to 0.8 mm; the counter re-synchronises on a limit hit with no log. v101 measures it. Make "home before every move" a firmware rule, record the end-of-test error on every run, and seriously price a second limit switch or a cheap encoder for the next board rev. This is cheaper than any optical fix and may explain some of the "device" variance.
4. **Use lane C as a validity control in the product, not a corrector.** The in-cartridge zero well does not correct A/B but catches fluidics failures. A product that fills one sample lane and keeps one reagent-only lane as a built-in invalidation check is a regulatory and UX asset ("this cartridge failed, retest") and costs nothing chemically. Decide this alongside D-3.
5. **Calibrators first, cartridges second.** V1 died of an evaporated CRM stock. The V2 calibrator set *already* shows a 9 % discrepancy and a 90-reading 50. The 1:2 dilution test is an afternoon; filling 350 curve cartridges against a wrong axis is a month. Order the work that way.
6. **The reagent-stability clock is 13 months.** EP25 reagent stability needs T=0 on the locked recipe/cart. Every week the lock slips is a week of shelf-life claim you cannot make at launch. If D-2 is "wait", accept that stability data at A4M is pre-V&V only, and say so on the slide.
7. **Capacity is devices and sealed cartridges, not people.** Interns added a lot of hands; the pipeline is still 9 trusted units × ~19 tests/day and ~144 wax-filled carts/day on two decks. Jacob's four experiments (~560 carts) + the 200-cart algorithm run + V2 (~1,600) ≈ 2,400 carts and ~800 device-runs. Protect fill-line uptime and the trusted-unit count like they are the critical path, because they are.
8. **Freeze the demo early and let the science continue underneath.** TASK-186 on Nov 20 is three weeks of buffer. Anything that lands after it (welded cart, new recipe) goes into the Q1 configuration; the A4M kit ships thermal-seal carts under cold chain with the known limitations written down. A frozen imperfect demo beats a moving perfect one.
9. **Fleet firmware drift is a silent variance source.** Units run v95 through v101; service-mode gating, scan positions and reading buffers differ across them. One chore (flash everything to v101, record it in BIMS) removes a confound from every experiment after it.
10. **Data flow is now the strong leg — use it to shorten the loop.** You have per-run bead index, stage check, mag sweep, thermo, fill lot and reagent lot all keyed to barcode/UDI. Put a *weekly auto-generated "fleet + lot health" page* on the validation hub (BIMS already has the pieces) so the experiment-to-decision loop is days, not analysis sessions. The research↔ops bridge task (TASK-076) is the right home.
11. **Two things on the notes list that deserve a bigger frame:** (a) *"assay record maintenance for deployed devices"* is actually the first piece of field device management — version pinning, assay push, and audit of what ran on which device; define it once, not as a patch. (b) *"performance reviews / daily transcriptions / daily cleaning"* — the transcription one is the lever: a daily transcript into the research system is the cheapest way to make the AI note-synthesis milestones real.
12. **One honest risk statement for the pitch:** the thermal-seal cartridge cannot ship warm; the welded cartridge does not exist yet; the assay saturates above ~20 µg/dL at the current bead density; no CLSI study has been executed. Each has a dated plan above. Investors fund plans with dated gates more readily than they forgive surprises in January.

---

## 6. Suggested first pull (ready cap 8, 6 in ready today)

1. Fix the distal filter slot (unblocks every re-screen) 2. One-click SCREEN firmware + BIMS 3. Mold quote + lane decision 4. Nondecane soak test protocol 5. Calibrator 1:2 dilution check (TASK-180, already ready) 6. IC50 / bead-amount decision 7. Diluent-tube lid material trial (TASK-015) 8. Ethernet OT-2 control (short, unblocks the robot-arm chain).

---

## Dependency map (becomes `blocked_by` links)

- filter-slot fix → SCREEN → fleet re-screen → thresholds (TASK-172) + assay-as-test-#4 (TASK-179) → 🎯 TASK-111 → TASK-086 diurnal devices, SPU pre-qualification (V2)
- mold + lane decision → welding bring-up → nondecane soak test → 50-cart curve → 🎯 TASK-184 → 🎯 TASK-089 recipe lock → stability v2 T=0, 🎯 TASK-187
- IC50 decision → recipe candidates → 200-cart algorithm experiment → 🎯 TASK-089
- TASK-180 calibrators → master curve generation → 🎯 TASK-187 → precision, LoD, linearity, interference, stability A/B/C, EP09/35
- TASK-015 diluent tube + TASK-157 SOP + TASK-014 kit v1 → 🎯 TASK-185 → TASK-009 internal round 1, TASK-011 external round 1
- TASK-063 app pass 1 + 🎯 TASK-184/089 outcome + fleet firmware + TASK-013 → 🎯 TASK-186 → TASK-067 photos, TASK-068 IFU/video v2, TASK-064 app pass 2 → 🎯 TASK-090
- chute → long-cycle proof → calibration → synchronized protocol → 🎯 TASK-127
