# Ask BIMS — The Final Push

**Status as of 2026-05-12:** 44/44 baseline questions pass on Haiku, voice rules baked into the system prompt, anti-redundancy enforced in code, confidence signals on every answer, cache verified working. Foundation is done.

This doc is the punch list to take it from "technically solid" to "operators reach for it daily." Five items, in priority order. After this, we declare it and move on.

---

## 1. Chemical inventory lookup

**Why this is #1:** We just inventoried 148 Brevitest chemicals and 55 Fannin chemicals for the new shared space. Ask BIMS can answer questions about wax, reagents, cartridges, equipment — but if an operator asks *"where's the methanol?"* or *"do we have enough Sodium Azide for next week?"*, it has nothing. This is the single biggest gap and the easiest win.

**What it looks like to the operator:**
- "Where do we keep the DMSO?" → "BT keeps a 500 mL bottle on the Open Lab bench (C-042). Fannin also stocks their own — heads up, you're probably looking for BT's."
- "Anything hazardous near the cartridge oven?" → returns the chemicals stored in that zone with hazard flags
- "How much 70% nitric acid do we have?" → "One gallon, BT, in the corrosives cabinet (C-091). Big bottle, be careful."

**Scope:** Bundle the chemical inventory spreadsheets into the codebase the same way the equipment datasheets are already bundled. Add one new tool that searches by name, CAS number, or tag (C-XXX / D-XXX). Surface hazard class, quantity, location, and the "dual-stocked" warning when both orgs keep their own version.

**Effort:** ~2 hours. Knowledge already loaded in memory; the structural work is identical to Phase D.

**Done = ** operators can ask about any chemical by name or tag and get the right answer, including the dual-stocking gotcha.

---

## 2. Floor plan / location-aware answers

**Why:** New shared space. People are still learning what's where. Currently equipment has a tag (B-01, F-03) but those are codes, not directions.

**What it looks like to the operator:**
- "Where is Fridge 3?" → "Tall door fridge on the Open Lab bench, north wall — the BT side."
- "What's near the OT-2 robots?" → "They're in the Manufacturing zone (lower-left), next to the wax oven and the cartridge backing station."
- "Show me everything in the Tissue Culture room." → list of equipment + chemicals in that zone

**Scope:** Floor plan layout is already captured in memory (3-band layout, zone tag conventions). Add a tool that resolves a tag or zone name to a spatial description, and let it cross-reference equipment + chemicals when asked broadly. No actual map image needed — text descriptions get you most of the way.

**Effort:** ~3 hours. Includes wiring zone metadata into a small lookup table.

**Done = ** new hires (and people who haven't been in the lab in a while) can orient themselves by asking instead of wandering.

---

## 3. Daily integrity scan (BimsAnomaly cron)

**Why this matters:** The 2026 research said it plainly — *"enterprise AI failures are mostly bad data, not bad models."* Ask BIMS already surfaces data caveats well, but it has to recompute them on every question. A daily background scan would (a) catch issues before operators do, (b) make integrity questions instant, and (c) flag drift that nobody's looking at.

**The seven checks to run:**
1. Wax runs missing a source lot
2. Receiving lots that show more consumed than received
3. Temperature sensors that haven't reported in over 4 hours
4. Cartridges stuck in mid-flight status for over 7 days
5. Reagent batches pointing at lots that don't exist
6. Inventory counters that drift from the lot-level truth
7. Cartridges still using V1 status names (the migration we know is incomplete)

**Scope:** Background job that runs once a day, writes findings to a dedicated collection. The existing data-integrity tool then queries that collection instead of recomputing.

**Effort:** ~4 hours. The check logic already exists in the data-integrity tool; we're moving it from on-demand to scheduled.

**Done = ** operators see "two issues worth attention today" the moment they open Ask BIMS, not after they ask the right question.

---

## 4. Reagent chain write path (the deferred Jacob thing)

**Why now:** Right now, asking "what reagents went into this cartridge?" returns "the workflow hasn't shipped" for most carts. That's the right answer today, but it's a placeholder. Until reagent lineage is actually being recorded, the recall/audit story leans entirely on the older tracing paths (input lots, runs, etc.). Those work, but they're indirect.

**What changes for the operator:** Cartridges manufactured after this ships will return a full reagent tree on the trace command — every protocol execution, every input material, walked back to the stock supplier. The big traceability promise becomes real.

**Scope:** On the wax-filling and reagent-filling pages, when a cart completes that stage, write an entry recording which protocol execution it came from. Plus a small backfill script for any recent carts where the data is reconstructable.

**Effort:** Medium — ~1 day. Touches a few page-server files and needs alignment with Jacob since the deferral was his call. **Confirm with him before starting** that the variant + execution flow is far enough along to support this now.

**Done =** trace asks return real chains for new carts. Older carts stay empty (documented limitation), but going forward we have actual recall-grade traceability through the consolidated path.

---

## 5. Thumbs up/down + light conversation logging

**Why:** Right now we have no signal on whether operators are actually getting the right answer. The harness validates tool selection; it doesn't measure whether operators feel served. Without thumbs feedback, we're guessing at what to improve next.

**What it looks like:**
- After every answer, two small buttons in the widget — 👍 / 👎
- Negative thumbs opens a one-line text box ("what was wrong?")
- All of it logs to a collection (question, model, tools used, answer text, feedback, optional comment) — admin-viewable
- Weekly: scan the thumbs-down comments. The patterns drive what we tune next.

**Scope:** UI buttons, a new collection, a small admin page to review. The data plumbing is straightforward; the discipline of actually reading the feedback weekly is the real ask.

**Effort:** ~3 hours code + recurring 30 min/week to triage.

**Done =** Within 30 days of launch, we have a real corpus of operator feedback driving the next phase of work, not guesses.

---

## What we're deliberately NOT doing in this push

- **Tool routing / retrieval (Tool-to-Agent pattern).** We're at 47 tools. The research said this becomes important around 60+. Phase F adds 17 more; revisit then.
- **LLM-as-judge in the test harness.** Regex + AND-of-words gets us 44/44 today. Cost-vs-value isn't worth it yet.
- **Verifier model for high-stakes calls.** Nice idea, doubles latency. Defer until we have thumbs-down data showing where the bad calls actually happen.
- **Multi-agent architecture.** No evidence we're hitting the wall on a single agent. Skip.
- **Formal Phase 1.6 operator interviews.** The roadmap calls for 6 thirty-minute sessions. Practically: you know what your operators ask. After this push ships, brain-dump 30-50 real questions you've heard them ask in the past month and we'll prioritize from there. Save the formal interviews for if the brain-dump turns out to have gaps.

---

## After the five are done

Ask BIMS becomes a thing operators reach for **before** clicking through three pages — which is the real test. The thumbs feedback then drives the next phase of work, instead of us guessing. At that point we should also:

- Rotate the API keys you pasted earlier
- Delete the local `.env`
- Merge the branch into `dev` and let it ride production for a week
- Pick the next phase based on what the thumbs feedback says, not what the roadmap predicted

---

## Rough sequence

If you're picking these up linearly: **3 → 1 → 2 → 5 → 4.**

- Daily integrity scan first because it doesn't depend on anything and you get the most quality-of-answers improvement per hour.
- Chemical lookup next because it's the biggest net-new capability and operators in the new space will hit this constantly.
- Floor plan after, because by then the chemical answers will be referencing locations and we'll want the spatial language to match.
- Thumbs feedback right before the reagent chain work — so when the chain ships, we immediately get signal on whether operators are actually using it.
- Reagent chain last because it needs Jacob's go-ahead and is the largest piece.

Total wall-clock: maybe 2-3 weeks of focused work if it's the only thing on your plate. Realistic with everything else: 4-6 weeks.
