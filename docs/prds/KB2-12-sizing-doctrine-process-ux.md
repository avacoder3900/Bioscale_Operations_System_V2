# KB2-12 — Sizing Doctrine + Unified Process UX

**Approved:** Jacob 2026-08-03. **Depends:** KB2-03/06.

## Why

Assigning time to tasks failed here before because it forced predictions on unpredictable
work. The doctrine (agreed 2026-08-03): **size class is a measurement bucket, never a promise;
SLEs are computed from history; unknown-time work never enters the queue as itself — its
milestones do, or a spike buys the answer.**

## The decision test (canonical wording — used everywhere)

> **Can you confidently pick a size?**
> - **Yes** → it's a `deliverable`; size it.
> - **No, but you can name the next milestone** → split; capture and size the milestone
>   (outcome = the milestone, e.g. "seal survives 3 thermal cycles").
> - **No, and you can't name the milestone** → it's a `spike`; timebox the question instead
>   ("2 days to learn whether X is viable"). "Still unknown" is a valid result.
> - None of the above → it's a project, not an item. It stays upstream; only its milestones flow.

## Changes

1. **Process modal (Inventory)**: embed the decision test as helper text; size-class options
   render the written definitions from policy.
2. **One button.** Replace the separate "Process…" and "Edit DoR" buttons with a single
   **"Process"** button (no ellipsis — it truncates). One unified modal:
   - `captured` item → full process flow (size + class required → `processed`).
   - `processed` item → same modal pre-filled; edits size/class/DoR in place (audited),
     no status change. (Server: extend the DoR-edit action to also accept
     sizeClass/classOfService for processed items.)
3. **Policy size-class definitions**: default texts updated to carry the doctrine (short/
   medium/long definitions + "if you can't pick one confidently, apply the decision test").
4. **MCP**: `kanban_process` and `kanban_capture` descriptions carry the decision test so
   Claude triages by the same rule as humans.

## Acceptance

- [ ] Inventory shows exactly one shaping button, labeled "Process", for both captured and
      processed items; modal behaves per state.
- [ ] Decision test visible in the modal and present in both MCP tool descriptions.
- [ ] Editing size/class of a processed item is audited and does not change status.
