# KB2-17 — Strategy Layer (CONCEPT NOTE, not a build PRD)

**Status:** idea captured 2026-08-16 (Jacob, in-session). Nothing scheduled. Revisit when the
KB2-16 tag model has settled.

## The idea

There is a concept bigger than projects or tasks: **strategic areas of focus**. A small set
(3–5) of them, arrived at by broad discussion and consensus, that answer "what are we actually
trying to win at right now." Strategy spawns projects; projects spawn tasks. The cascade exists
whether or not we model it — today it lives implicitly in Jacob's head and shows up as ad-hoc
inventory pruning (e.g. the 2026-08-16 decline sweep).

## Decisions sketched in-session

1. **No UI.** Strategic areas are a low-frequency, high-deliberation artifact — a handful of
   records revised quarterly. CRUD screens for that become an OKR-tool graveyard: form-filling
   ritual, stale pages. The consensus discussion happens between humans; the artifact is a
   document.
2. **The doc is the UI.** `docs/strategy/FOCUS.md` (name TBD): each area gets a paragraph on
   what winning looks like and roughly what share of attention it deserves. Versioned, dated,
   names on it. Consensus that isn't written down with a date evaporates.
3. **AI owns downstream coherence.** The continuous, boring part humans skip. A recurring agent
   reads FOCUS.md + the live board (the MCP toolset, KB2-09, already exposes everything needed)
   and produces a **drift report**: captured options serving no stated focus area (decline/icebox
   candidates); areas starving while another eats most of the committed capacity; options the
   inventory is missing for an underserved area.
4. **The agent reports, never mutates.** Proposals only; a human clicks the button. Matches the
   system's existing philosophy (audited transitions, privileged tier crossings).
5. **Join to the task layer: tags.** Post-KB2-16 there are no projects — focus areas map to
   canonical tags (or to named groups of tags listed in FOCUS.md). The strategy layer needs no
   schema at all.

## Why this was deferred

KB2-00 already lists "portfolio rollups beyond projects" as a non-goal for the KB2 series.
This note upgrades that from "not now" to "here is the intended shape when it happens."
