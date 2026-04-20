# What I'm about to build — plain-language walkthrough

**Goal:** make the Opentrons Clone inside BIMS a real replacement for the Opentrons desktop App's "start a run" flow. Today you can click Create Run and hit Play, but you'd be missing the setup steps the real app does before every run. This pass fills in those missing steps.

There are **four things** I'm going to build, in this order. After I'm done, you'll be able to run a real manufacturing protocol from BIMS without opening the Opentrons App.

I'll commit after each one so you can review a clean diff per piece. After everything is done, I'll write a `PRODUCTION-READY.md` at the repo root summarizing the whole pass.

---

## 1. Runtime parameters form

**The problem right now:** Your protocols have knobs built in. For example, `Full Deck Protocol Single Channel.py` lets you pick how many cartridges to fill (1–20), whether the sample well gets liquid, whether Beads A go in, etc. Today, when you click "Create run from this protocol" in the clone, it uses the **default values** only. You can't change them. In the Opentrons App you can.

**What I'll build:**
- On the protocol detail page, under "Start a run," I'll add a **parameters form**.
- It pulls the knobs out of the protocol's analysis (the robot already told us what they are — the UI just isn't using that info).
- Each knob becomes a field: numbers get number inputs with min/max, booleans become checkboxes, dropdowns become `<select>`, CSV-file params become a dropdown of data files you've uploaded.
- When you click Create Run, your values get sent to the robot along with the protocol ID, so the run uses the values you picked.

**What you'll see:** a clean form above the Create Run button. It respects the defaults the protocol defines so you can just hit Create Run if you're happy with them. Change any field and that override gets sent instead.

**Why it matters:** without this, every run uses default values only, which is almost never what you want in production. This is the biggest one — after this, the clone can actually replace the Opentrons App for 90% of runs.

---

## 2. Deck and labware setup checklist

**The problem right now:** The Opentrons App, before it lets you start a run, shows you a picture of the deck and a list of "put this labware in slot 3, put this tip rack in slot 8" etc. You tick a checkbox for each one to confirm you've physically set it up. The clone today just trusts you and starts the run. If you forgot to load the tip rack, the robot finds out the hard way mid-run.

**What I'll build:**
- A "Setup checklist" section that shows up between the parameters form and the Create Run button.
- For each slot the protocol uses, it shows which labware goes there (pulled from the analysis).
- Each row has a checkbox: "I've placed this."
- The Create Run button stays disabled until every box is ticked.

**What you'll see:** a simple table with rows like "Slot 3 — opentrons_96_tiprack_300ul — [ ] ready" and the Create Run button greyed out until the last one gets ticked.

**Why it matters:** prevents the 30-seconds-into-a-run "oh no I forgot the tips" crash. This is a safety net — cheap to build, high upside.

---

## 3. Pipette attach confirmation

**The problem right now:** A protocol declares "I need a P300 single-channel on the left mount and a P20 single-channel on the right." If the robot physically has a different pipette attached, the Opentrons App catches this *before* you can start the run and tells you. The clone today doesn't check — it'd happily send the run to the robot which would then error out.

**What I'll build:**
- A "Pipettes" section near the top of the Start-a-run area.
- Two columns: "Protocol requires" vs "Currently attached."
- If they match, shows a green OK.
- If they don't match, shows a red warning **and** blocks the Create Run button until they do.

**What you'll see:** a small card that either says "pipettes OK — p300 left / p20 right" in green, or "Mismatch — protocol wants p300 left but p1000 is attached" in red with Create Run disabled.

**Why it matters:** catches the single most common pre-flight mistake. Ten seconds of work at run creation saves a ten-minute abort mid-run.

---

## 4. Labware Position Check wizard

**The problem right now:** Your physical labware is never exactly where the robot thinks it is — every plate is off by a fraction of a millimeter in X/Y/Z. The Opentrons App has an interactive wizard called "Labware Position Check" (LPC) that does this:

1. Tells the robot to pick up a tip.
2. Moves the pipette over a spot on each piece of labware you've loaded.
3. Shows you jog buttons (up/down/left/right/forward/back in 1mm or 0.1mm steps) to nudge the pipette tip until it's **exactly** centered on a known reference point on that labware.
4. Saves the offset (x/y/z difference between where the robot thought the tip was and where it really needs to be).
5. When you create the run, those per-labware offsets get attached to the run so every movement in the run is corrected.

This is the big one. It's what keeps the robot from crashing tips into wells. Without it, your protocols would miss their targets by a few millimeters and pipetting would be unreliable.

**What I'll build:**
- A new page: `/opentrons-clone/[robotId]/protocols/[protocolId]/lpc`
- When you click "Run Labware Position Check" on the protocol detail page, it takes you there.
- The page walks you through, one labware at a time:
  - "Attach a tip to the P300 left pipette" → click next
  - "The pipette will move over Slot 3, well A1. Use the jog buttons below to center it exactly on the well." → shows +/- X, Y, Z jog buttons at two step sizes (1mm and 0.1mm)
  - "Good? Save and continue" → stores the offset, moves to the next slot
- When all slots are done, you land back on the protocol detail page with the offsets saved and the Create Run flow automatically applies them.

**The under-the-hood bit:**
- Uses the robot's `/maintenance_runs` endpoint to start a side session (so it doesn't interfere with real runs).
- Sends `pickUpTip` → `moveToWell` commands for each labware.
- Uses `aspirateInPlace`-style jog commands (really a `moveRelative` under the hood) for the arrow buttons.
- Saves offsets via `POST /runs/{id}/labware_offsets` when the real run is created.

**What you'll see:** a wizard-style page with a big "move the pipette" display, step-size buttons, jog buttons as a D-pad, and a progress bar along the top ("Labware 2 of 5").

**Why it matters:** this is the most-used daily feature of the Opentrons App that the clone is missing. Without it, every real run needs the Opentrons App open in another tab anyway — which defeats the purpose of the clone. This is what makes the clone a true replacement.

**Honesty note:** this one is the biggest chunk of work — probably the majority of the pass. It's a multi-step state machine with physical consequences (the robot is moving while you're clicking), so I'm going to build it carefully, commit in small pieces, and test every path before calling it done.

---

## What I won't touch

- The three one-time calibration wizards in the Opentrons App (pipette offset, tip length, deck calibration). Those only run when a pipette gets bumped or replaced — maybe once a month. You'll still use the Opentrons App for those. This was the explicit call in the original plan (`OPENTRONS-CLONE-PLAN.md §2.4`) and it still stands.
- Anything outside `/opentrons-clone/**`. No changes to the wax-filling, reagent-filling, or opentron-control pages. That integration is still Step 2.
- MongoDB. None of this adds new database models. Everything still pass-through to the robot, per the Step 1 rules.

---

## How I'll verify each piece

After I commit each of the four pieces, I re-run the end-to-end verify script against `hidden-leaf`:

```bash
npx tsx scripts/verify-opentrons-clone.ts hidden-leaf.local
```

If that 34-row suite stays green, the underlying API layer is intact. On top of that I'll do manual smoke tests of the new UI paths as much as I can without a physical operator.

## What you might need to do

- For Task 4 (LPC wizard), the real validation is "stand at the robot, click through the wizard, confirm the pipette ends up where your eyes say it should." I can't do that part — it needs a human standing at R04 with a tip attached. I'll build the software, you drive the physical side when you're back at the lab.

## Timing guess

Roughly a week of a person's focused attention if done by hand. Working through it autonomously with short breaks between commits, I'd expect something like a full day of clock time — maybe more if Task 4 hits subtle issues (which it probably will). I'll wake myself up between commits and keep pushing unless something actually blocks me that only you can unblock.

---

Tell me `go` when your permissions are set the way you want them and I'll start on Task 1.
