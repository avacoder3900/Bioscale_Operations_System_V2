# KB2-07 — Spikes + Discovered Work (the stop-now test)

**Depends on:** KB2-01 (+03 for DoR hook). Read KB2-00 first.

## Spikes (timeboxed investigations — output is knowledge, not a deliverable)

- `itemType:'spike'` requires `spike.question` (non-empty — if the question can't be written,
  the uncertainty isn't shaped enough to fund) and `spike.timebox {amount, unit}` at creation.
  Enforced in `createKanbanItem` + process/replenish DoR.
- A spike is `done` when the timebox expires, **regardless of whether the question was
  answered** — "we spent two days and still don't know" is a valid, recorded outcome. No UI or
  metric treats an unanswered spike as failure. Timebox expiry while `wip` → surfaced in alerts
  (nudge to close), never auto-failed.
- Closing a spike requires `spike.outcome` text and prompts "what options does this create?" —
  a multi-capture box that files new `captured` items with `origin:'discovered'`,
  `spawnedFrom: spikeId`. A spike's output is almost always options, never tasks.

## Discovered work — the stop-now test

When creating an item from within an in-progress item (task-detail "add related", subtask flows,
and the MCP capture tool when Claude is working a task), surface the test:

> **If I stopped right now, is the parent item's stated outcome achieved?**
> - **Yes** → new OPTION: created `captured`, `origin:'discovered'`, `spawnedFrom` set. `ready`
>   is not offered on that path at all — it goes through replenishment like everything else.
> - **No** → it was always inside the parent's boundary: append to the parent as context
>   (description/comment), do NOT create an item.

UI: the create-from-task modal leads with this question (two buttons: "New option" / "Part of
parent"). MCP: the capture tool's description embeds the test so Claude applies it; the tool
accepts `spawnedFrom` and defaults discovered items to `captured`.

`parentTaskId` (subtask containment) and `spawnedFrom` (provenance) remain distinct fields.

## Acceptance criteria

- [ ] Spike creation without question/timebox rejected (spec §11 item 10).
- [ ] Spike close records outcome + files options as captured/discovered.
- [ ] Create-from-task defaults to `captured` + `origin:'discovered'` + `spawnedFrom`; no path
      on that flow offers `ready` (spec §11 item 11).
- [ ] Discovered-ratio (KB2-05) computes from these fields.
