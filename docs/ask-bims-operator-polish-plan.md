# Ask BIMS Operator-Polish Plan

**Status:** Plan written 2026-05-12 in response to the operator-perspective audit. Sequences fixes for 15 audit findings (5 HIGH + 5 MEDIUM + 5 LOW) plus 10 new-idea items into 4 phases (J → K → L → M). Phase J ships in the session this plan was authored in; the rest is staged for follow-on commits.

## How to read this plan

Each item maps back to its audit code (`O-H1`, `O-M3`, etc.). Phases are grouped by *what surface they touch*, because the BIMS UI freeze (per `CLAUDE.md`) means widget changes get a different review path than server-only changes.

- **Phase J — server-only operator polish.** No widget touch. Shippable today on the current branch.
- **Phase K — pageContext plumb.** Mixed: a thin server addition plus a small widget addition. Foundation for several Phase L items.
- **Phase L — widget UX polish.** All widget changes. Follow the thumbs-UI pattern (committed 2026-05-07) for review.
- **Phase M — voice + long-tail.** Big-rock items (voice input, mobile pass, confidence calibration). Schedule separately.

Each phase has a "ready to ship" gate so we never half-ship.

---

## The 15 audit findings + 10 new ideas, indexed

### HIGH severity

| Code | Finding | Surface | Phase |
|---|---|---|---|
| O-H1 | No page-context awareness | server + widget | K |
| O-H2 | No quick-action chips | widget (needs pageContext) | L |
| O-H3 | No voice input | widget + new server endpoint | M |
| O-H4 | Answers don't lead with the number | server (system prompt) | J |
| O-H5 | "Today" / "this shift" ambiguous | server (system prompt + new tool) | J |

### MEDIUM severity

| Code | Finding | Surface | Phase |
|---|---|---|---|
| O-M1 | No "what can you do?" discovery surface | widget (first-open banner) | L |
| O-M2 | Cross-site (BT/Fannin) disambiguation absent | server (system prompt) | J |
| O-M3 | Pronoun coherence in multi-turn unreliable | server (system prompt) | J |
| O-M4 | Cooldown / recovery from bad answer invisible | widget | L |
| O-M5 | Safety-critical answers not visually loud | server (flag) + widget (render) | K/L |

### LOW severity

| Code | Finding | Surface | Phase |
|---|---|---|---|
| O-L1 | No shift-handover summary | server (new tool) | J |
| O-L2 | No "next step" proactivity | server (system prompt) | J |
| O-L3 | No training-status banner | server (new tool extension) | J |
| O-L4 | Mobile / tablet UX unverified | widget (verification pass) | M |
| O-L5 | Confidence "high"-tagged answers may mislead | server (analysis + tuning) | M |

### 10 new-idea items (from audit closing)

These are *additional* improvements the audit surfaced beyond the 15 gaps. Listed here for completeness but not all scheduled into a phase yet.

1. **Shift handover tool** — covered as O-L1.
2. **What-changed-since-last-question** — new tool. Phase L extension.
3. **Cartridge "explain" mode** — annotate genealogy with operator-friendly captions. Phase J nice-to-have.
4. **Where-do-I-find-this-part** — physical-location lookup against `EquipmentLocation` + part part-of-bom joins. Phase K (uses pageContext for "the part I'm looking at").
5. **One-tap troubleshoot** — when a run is blocked, surface the 3 most likely fixes with one-tap "I tried it" feedback. Phase L.
6. **Print this answer** — generate a print-friendly version for paper SOP routing. Phase L.
7. **Bookmark this answer** — saved-answers list. Phase L.
8. **Today's anomalies** — push `bims-anomaly-scan` results into Ask BIMS so the agent can volunteer them. Phase J extension.
9. **Operator nickname / preferred name** — store on User; greet on first ask of the day. Phase L.
10. **Quick-cite mode** — for FDA-relevant answers, format the result as a citable line: "BIMS Ask, 2026-05-12T14:32Z, response abc123, model haiku-4-5". Phase J.

---

## Phase J — Server-only operator polish

**Scope:** every fix that lives in `src/lib/server/ask-bims.ts` or new server-side tools. No widget changes. Ships on the current `feat/ask-bims-markdown-context` branch.

### J.1 — Answer-format rule (O-H4)

**Change:** Add system-prompt rule **"OPERATOR FORMATTING: lead with the number, then one line of context, then the ID + verify link."** Targets quantitative questions like "how many cartridges, how much wax, when does the run unblock."

**Acceptance:**
- New `ACCURACY DISCIPLINE` rule 10 (or new `OPERATOR EXPERIENCE` section) lands in `SYSTEM_PROMPT`.
- 3 fixtures in `tests/ask-bims/baseline.ts` verify "how many" answers start with a digit + unit on line 1.
- Existing fixtures still pass.

**Effort:** ~30 minutes.

### J.2 — Site disambiguation rule (O-M2)

**Change:** Add system-prompt rule **"SITE DISAMBIGUATION: if a question references equipment or chemicals and the org isn't specified, ask 'BT or Fannin?' OR pick the side that matches `B-XX` (BT floor) / `F-XX` (Fannin bench) prefixes in the result."** Targets "where's the centrifuge?" types where both sites have one.

**Acceptance:**
- New rule in `SYSTEM_PROMPT`.
- 2 fixtures: ambiguous "where's the centrifuge?" returns both with prefix-disambiguation; unambiguous "where's the F-04 ultracentrifuge?" returns just Fannin's.
- Tool description for `list_equipment` mentions org prefix convention.

**Effort:** ~20 minutes.

### J.3 — Shift-aware "today" + multi-turn pronouns (O-H5 + O-M3)

**Change:** Two related rules added together.

1. **"TIME WINDOWS: 'today' means since 06:00 site-local (shift start). 'this shift' means since 06:00 if before 18:00, since 18:00 otherwise. State the time window in the answer."**
2. **"PRONOUN COHERENCE: when the user says 'it', 'the run', 'the cartridge', resolve to the entity from the previous turn's tool result. If ambiguous (multiple entities mentioned), ask."**

**Acceptance:**
- Two new rules in `SYSTEM_PROMPT`.
- 4 fixtures: "today's runs," "this shift's anomalies," "what about it" (pronoun resolution to prior turn), "what about it" (ambiguous → asks).
- `shift_summary` tool (J.5) honors the same window definition.

**Effort:** ~30 minutes.

### J.4 — Next-step proactivity (O-L2)

**Change:** Add system-prompt rule **"NEXT STEP: after answering, if the answer reveals a clear blocked workflow or next action, surface it under a `nextStep:` line. Examples: 'The run is awaiting wax fill → next step: scan PT-CT-114 from the rack.' Do NOT invent steps when the answer is informational."**

**Acceptance:**
- New rule in `SYSTEM_PROMPT`.
- 2 fixtures: blocked-run question returns a `nextStep:` line; informational question (e.g. "what is a backing lot?") does NOT.

**Effort:** ~20 minutes.

### J.5 — `shift_summary` tool (O-L1)

**Change:** New read-only tool `shift_summary(site?: 'BT' | 'Fannin' | 'both', windowHours?: number = 8)` that returns a structured summary for shift handover:

```
{
  windowStart, windowEnd,
  runsCompleted: number,
  runsStarted: number,
  runsBlocked: { runId, blockReason, cartridgeCount }[],
  anomaliesOpen: { anomalyId, summary, severity }[],
  equipmentOutOfCal: { tag, name, dueDays }[],
  chemicalsExpiringSoon: { partNumber, lotId, daysToExpiry }[],
  scrappedCartridges: number,
  dataIntegrityNotes?: string[]
}
```

Pulls from `ProductionRun`, `WaxFillingRun`, `BimsAnomaly`, `CalibrationRecord`, `ReceivingLot`, `ManualCartridgeRemoval`.

**Acceptance:**
- Tool defined + `runTool` case + fixture in `baseline.ts` ("give me the shift summary" → returns all 7 sections).
- Tool description includes `Use when` (shift change, EOD report) and `Don't use for` (specific cartridge lookup → use `find_cartridge`).
- Uses the same time-window definition as J.3.

**Effort:** ~60 minutes.

### J.6 — Training-status surface (O-L3)

**Change:** Extend the existing operator-info path. Either (a) extend an existing tool to include training-status, or (b) add a small `who_is_this_operator(username?)` tool that returns the operator's role + recent permission grants + any open training assignments. (We do not yet have a `TrainingRecord` model, so this is best-effort: pull role, permission grants from `User`, and surface "training tracker model not yet present" cleanly.)

**Acceptance:**
- Tool ships with `dataIntegrityNotes` calling out the missing training model.
- 1 fixture verifying the disclaimer fires.

**Effort:** ~30 minutes.

### J.7 — Quick-cite mode (new-idea #10)

**Change:** New system-prompt rule **"CITATION MODE: when the user asks 'cite this' or 'for the record', append a single line: `Cited: BIMS Ask, <ISO timestamp>, response <responseId>, model <model>`. responseId is available in the runtime context."**

**Acceptance:**
- Rule lands; 1 fixture verifies citation line on "cite this last answer."

**Effort:** ~15 minutes.

### Phase J commit shape

Two commits to keep diffs reviewable:

1. **`feat(ask-bims): Phase J.1-J.4 + J.7 — operator-experience system prompt rules`** — all rule-only additions, ~6 new fixtures, no new code paths.
2. **`feat(ask-bims): Phase J.5 — shift_summary tool + J.6 training-status surface`** — new tool definitions + runTool cases + ~3 fixtures.

Total Phase J effort: **~3 hours**. Both commits ship on the current branch; user reviews; we move to Phase K.

---

## Phase K — pageContext plumb (server + widget foundation)

**Scope:** thread the current page (path, title, optional pageData like "current cartridgeId from URL") from the widget through to the agent. Many later items use this.

### K.1 — Server: extend `AskBimsOpts`

Add `pageContext?: { path: string; title: string; entityType?: 'cartridge' | 'run' | 'lot' | ...; entityId?: string }` to the `askBims` opts. Surface to the agent by prepending a small `## CURRENT PAGE` block to the user message (so it stays cacheable).

### K.2 — Endpoint accepts `pageContext`

`/api/agent/ask/+server.ts` accepts `pageContext` in body, validates shape, forwards to `askBims`. Bad shape → silently drop (not a hard error — page context is optional).

### K.3 — System-prompt rule on pageContext usage

**"PAGE CONTEXT: if `## CURRENT PAGE` is present and the question is short ('what's wrong with this?', 'who finalized it?'), resolve 'this' to `pageContext.entityId`. If `pageContext.entityType` mismatches the question subject, ignore pageContext."**

### K.4 — Widget changes

In `AskBimsWidget.svelte`:
- On open, capture `window.location.pathname` and `document.title`.
- Parse common BIMS URL shapes: `/spu/cartridge/{id}`, `/spu/run/{id}`, `/spu/wax-batch/{id}`, etc., into `entityType` + `entityId`.
- Send as `pageContext` in the `/api/agent/ask` body.

### K.5 — Fixtures

3 fixtures: pageContext for a cartridge route → "what's wrong?" resolves to that cartridge; pageContext for a run route → "who finalized it?" resolves to that run; mismatch case → agent ignores pageContext and asks for clarification.

### K.6 — Safety-content marker (O-M5, partial)

Add an internal flag the agent can set on tool results: `safetyCritical: true`. Used for:
- Chemical exposure / HTX answers
- "Don't do X" style warnings
- Equipment lockout / tagout questions

Widget will render these specially in Phase L. Server-side, this is just a result-field convention; Phase K only adds it to the tool result schema for a small subset (e.g. `lookup_chemical` HTX results, `find_equipment_calibration` overdue results).

### Phase K commit shape

1. **`feat(ask-bims): Phase K.1-K.3 — server pageContext plumb + system-prompt rule`** — server-only piece, ships independently.
2. **`feat(ask-bims): Phase K.4-K.5 — widget pageContext capture + fixtures`** — widget piece; gets reviewed under the UI-touch path.
3. **`feat(ask-bims): Phase K.6 — safetyCritical result flag (server side)`** — preps for Phase L.3.

Total Phase K effort: **~3 hours** (1.5h server, 1h widget, 0.5h fixtures).

---

## Phase L — widget UX polish

**Scope:** all widget-side improvements. Each is a small, isolated change to `AskBimsWidget.svelte` (or whichever component owns the widget) that follows the thumbs-UI pattern from 2026-05-07.

### L.1 — Quick-action chips (O-H2)

Below the input, render 4 chips with page-aware suggestions:

- **No pageContext:** "What's blocked today?", "Today's anomalies", "Shift summary", "What can you do?"
- **Cartridge page:** "Why is this cartridge stuck?", "Show genealogy", "What's the QC status?", "Where is it physically?"
- **Run page:** "What's blocking this run?", "Who finalized it?", "Show parts consumed", "Spec deviations?"

Chip click → fills the input + fires.

### L.2 — Help / discovery banner (O-M1)

First-open of the widget per browser session shows a small banner: "I can help with cartridges, runs, equipment, chemicals, anomalies, and shift summaries. Try `What's blocked today?` or click a suggestion below." Dismissible. Stored in `localStorage.askBimsHelpDismissed`.

### L.3 — Hazard banner for `safetyCritical` (O-M5)

When the response payload contains a result marked `safetyCritical: true`, render a distinct visual block (yellow/orange border, ⚠️ leading char, larger font for the critical text). Counter the operator-audit finding that HTX/exposure answers don't visually stand out from chatty answers.

### L.4 — Auto-rephrase on thumbs-down (O-M4)

When the user clicks thumbs-down:
- Show inline: "Want me to try again with more detail / a different angle?"
- One-click → re-fires the question with a system suffix `(prior answer marked incorrect; try a different tool path)`.
- The original thumbs-down still posts to `/api/agent/ask/feedback`.

### L.5 — Flag-for-review button (carried over from earlier)

Already server-ready as of 2026-05-13. Wire the UI: 🚩 button next to thumbs, opens free-text textarea, POSTs `flagged:true` + `flagReason`. Confirm toast: "Flagged for review."

### L.6 — Saved answers / bookmark (new-idea #7)

Small bookmark icon next to each answer. Click → save to `localStorage.askBimsBookmarks` with question + answer + timestamp + responseId. A new "Bookmarks" tab in the widget header lists them. Defer until L.1-L.5 ship.

### L.7 — Print-friendly mode (new-idea #6)

"Print" button per answer → renders the answer + responseId + timestamp into a clean printable view. Defer until L.1-L.5 ship.

### Phase L commit shape

3-4 commits, each one small UI change + screenshot for review. Order: L.5 → L.1 → L.2 → L.3 → L.4 → L.6 → L.7. (L.5 ships first because it's already server-supported and is the highest-leverage UX gap right now.)

Total Phase L effort: **~6-8 hours** spread across 3-4 PRs.

---

## Phase M — voice + long-tail

**Scope:** big-rock items that need product-strategy buy-in or significant infra work.

### M.1 — Voice input (O-H3)

- Add mic button to widget.
- `MediaRecorder` API captures audio.
- POST audio to new `/api/agent/transcribe` endpoint (calls OpenAI Whisper or Anthropic-supported equivalent).
- Transcript fills the widget input — operator confirms before firing.
- Optional Phase M.1a: TTS readback of short answers.

**Effort:** **~6-10 hours.** Needs:
- Whisper API key + cost-cap policy (separate from Ask BIMS daily caps)
- Mic permission UX (one-time popup per browser)
- Audio file size handling (compress before POST)
- Fallback when mic unsupported

### M.2 — Mobile / tablet pass (O-L4)

Connect a real iPad (production target — Fannin floor uses tablets). Walk through 10 common questions. Identify text-size, button-tap-target, and keyboard-blocking issues. Patch.

**Effort:** **~3 hours.**

### M.3 — Confidence calibration (O-L5)

Pull last 200 conversations where `confidence: 'high'`. Cross-reference with thumbs feedback. If >10% of high-confidence answers got thumbs-down, the confidence-inference rule is mis-calibrated. Re-tune the system-prompt confidence rule based on the patterns we see.

**Effort:** **~4 hours** (analysis + tuning + verification fixtures).

### Phase M commit shape

Each item gets its own commit + the data analysis for M.3 gets a memory file. Voice (M.1) is the heaviest — schedule explicitly with user before starting.

Total Phase M effort: **~13-17 hours.** Schedule across separate sessions.

---

## Sequencing summary

| Phase | Effort | Ships in | Blocks |
|---|---|---|---|
| J | ~3h | This session | nothing |
| K | ~3h | Next session | enables L.1, L.3 |
| L | ~6-8h | After K | enables M.2 verification |
| M | ~13-17h | Schedule separately | end of operator-polish stream |

Total operator-polish: **~25-31 hours** across 4 phases. Phase J ships *today*; the rest is staged.

---

## Standing constraints (carry-forward)

- **Never push to main.** Per `feedback_no_master_merge.md`. All work lands on the current `feat/ask-bims-markdown-context` branch (or a polish-specific child branch if Phase L/M wants its own).
- **Read-only Ask BIMS.** Per system prompt rule 8 (added 2026-05-08). Nothing in this plan creates mutations; the only writes are telemetry (already in place) and feedback (already in place).
- **UI freeze lite.** Per `CLAUDE.md`, .svelte files are nominally frozen. The widget + admin pages have been touched with user approval (thumbs UI 2026-05-07). Phase K.4 and Phase L items extend that pattern; surface each one in commit messages so the user can spot-check.
- **Cost caps.** Phase J adds zero new external calls. Phase M.1 introduces Whisper costs and needs its own cap policy added to the user's existing 5-layer cost defense.

---

## Open questions for the user

These can be deferred but worth flagging:

1. **Site-local shift boundary.** J.3 assumes 06:00 / 18:00. Confirm? Multi-site (BT Houston + Fannin) presumably share one shift schedule but verify.
2. **Cartridge "explain" mode (new-idea #3).** Worth Phase L or skip?
3. **Whisper budget.** Phase M.1 needs a daily cap separate from Anthropic. ~$0.006 / minute of audio. Suggest $5/day workspace cap initially.
4. **Saved answers + print (L.6 + L.7).** Both are nice-to-haves. Defer to a "Phase L+ polish" sweep, or ship inline with L.1-L.5?

When the answers land, fold them into this doc and update the relevant phase.
