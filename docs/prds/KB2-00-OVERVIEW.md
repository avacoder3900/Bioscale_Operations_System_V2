# KB2-00 — Two-Tier Kanban: Overview & Decisions of Record

**Status:** Approved by Jacob 2026-07-30 (workshopped in-session against the Nicholas Cox draft spec
`two-tier-kanban-spec.md` + a full code/data audit).
**Branch:** `feat/kanban-two-tier`
**Reading order:** this doc → KB2-01 → KB2-02 → … Each PRD is independently shippable, in order.

## The problem

One flat per-project list is doing two jobs (inventory of everything we know about + what to work on
now) and doing both badly: `prioritized` is a boolean and 60/88 active tasks carry it (zero signal);
`ready` is six per-project queues (= no queue); small work crowds out the main stream; discovered
work enters the same pile with no decision point; flow data barely accrues (only the agent API path
stamps flow timestamps — humans dragging cards stamp nothing).

## The fix (Kanban method, not invention)

A single enforced **commitment point** between:

- **Tier 1 (upstream, uncommitted)** — statuses `captured → processed → (icebox | declined)`.
  Unbounded inventory of options, ranked per project.
- **Tier 2 (downstream, committed)** — statuses `ready → wip → (waiting | blocked) → done`
  (+ `review` on the software board). One **global ordered queue** per board, capped.

Crossing Tier 1 → Tier 2 is a privileged operation (`replenish`) — never available through normal
task update. Demotion is allowed and audited.

## Status vocabulary (final)

| Status | Tier | Meaning |
|---|---|---|
| `captured` | 1 | Written down so it isn't lost. One line is enough. Default for all new items. |
| `processed` | 1 | Looked at: sized, classed, ranked. A real candidate for replenishment. (Renamed from spec's "triaged" per Jacob.) |
| `icebox` | 1 | Deliberately parked. Visible, not deleted, skipped at processing. |
| `declined` | 1 | Explicitly not doing; kept for the record (who/why). |
| `ready` | 2 | The global ordered queue. Capped. Pull from top 3 only. |
| `wip` | 2 | Actively worked. Per-person WIP limits. |
| `waiting` | 2 | Blocked on an external dependency (requires named dependency + date). |
| `blocked` | 2 | Blocked on us (requires reason). NEW as a real schema status — previously a phantom advertised by APIs but rejected by the model enum. |
| `review` | 2 | Software board only: PR open, awaiting review. |
| `done` | 2 | Finished. Archived by cron after 24h (existing behavior, kept). |

`tier` is **derived from status** (one source of truth, never stored/writable).

## Decisions of record

1. **`processed` not `triaged`** (Jacob 2026-07-30).
2. **Priority is deleted as a concept.** No boolean, no High/Med/Low anywhere. `rank: integer`,
   strict ordinal, no ties — per-project in Tier 1, global-per-board in Tier 2. `prioritized`
   removed outright (not deprecated-for-a-release; Jacob: "get rid of priority altogether").
3. **One transition service.** Every status write — UI, API, MCP, cron — goes through
   `transitionTask()`. Equal data capture regardless of channel.
4. **No drag-and-drop.** Cards advance via explicit buttons mapped 1:1 to named transitions
   (drag/drop was buggy; buttons are auditable operations).
5. **Tier 2 board is one flat vertical queue** — no horizontal swim lanes. Rank number badge
   top-left of each card. There is one priority order on a team this size (~7 people).
6. **Only a human replenishes** — including a human driving Claude. Every mutating MCP tool takes a
   required `actor` (username); replenish validates it. New permission `kanban:replenish`.
7. **Weekly replenishment cadence.**
8. **[SUPERSEDED by KB2-16 (2026-08-16): one board — 'software' is a tag; `review` is legal
   everywhere.]** **Software board**: same engine, `board: 'software'` discriminator, own global queue + cap +
   policy block, shared per-person WIP limits across boards, extra `review` status. Software DoR
   includes an **agent handoff brief** — commitment = writing the description that lets a coding
   agent execute without re-discovery.
9. **Standing work (e.g. cartridge build queue) is not a flow item.** Separate Supply panel with
   live target-vs-actual computed from BIMS data (KB2-10).
10. **[SUPERSEDED by KB2-16 (2026-08-16): projects removed entirely — tasks carry tags; the
    kanban_projects collection is dead data.]** **Projects stay a separate collection** (containers by construction — they are not tasks and
    can never enter Tier 2). No merge into the task collection.
11. **All policy numbers live in a `KanbanPolicy` config doc** (singleton `_id:'default'`),
    tunable via admin UI + MCP tool, no deploys. Numbers below are SEEDS to be recomputed from
    measured flow after ~4 weeks.
12. **No per-person productivity aggregates — enforced at the query layer.** No per-person
    throughput/cycle-time/leaderboards in any API, query, or export. (Documented cause of
    cherry-picking; the redesign exists to fix that.) Per-person WIP is a limit, not a score, and
    is fine.
13. **QMS/design control: explicitly out of scope for now.** Revisit before running a regulated
    device-development project on this board.
14. **Site-wide permission revamp is a separate future project** (security audit 2026-07-29 found
    systemic gaps); KB2 only adds `kanban:replenish`.
15. Old code predates good agentic coding — **improve/replace freely where touched** rather than
    preserving legacy patterns (Jacob).

## Seed policy numbers

| Knob | Seed | Rule |
|---|---|---|
| Ready cap (per board) | 8 | throughput × replenishment interval + buffer; recompute after 4 weeks of done data |
| Minimum order point | 3 | below this, emit replenishment signal |
| WIP per person | 2 (max 1 chore) | across both boards combined |
| Pull window | top 3 of global ready order | enforced server-side |
| Expedite | 1 system-wide; alert if >5% of committed items over rolling month | |
| Capacity allocation | standard 60% / fixed_date 25% / chore 15% (floor AND ceiling) | recompute from arrival rates after 60 days |
| SLE | seed from historical archived data (19 samples: p50 3d, p85 20d, all 'medium') | 85th percentile default; show "insufficient data" until n is real |

## Current-state facts the PRDs rely on (audited 2026-07-29/30)

- 9 projects, 407 tasks total: 88 active (51 backlog, 17 ready, 11 waiting, 6 wip, 2 `todo`,
  1 `in_progress` — the last two are rogue values that bypass the enum), 319 archived done.
- Done tasks are archived (flag flip) by weekly cron `archive-done-tasks` after 24h — closure
  discipline is healthy; metrics must include archived docs.
- Flow timestamps are sparse: only the agent PATCH path stamps `wipDate`/`completedDate`/
  `transitions[]`; UI paths stamp only `statusChangedAt` + activityLog. 19 tasks have computable
  wip→done cycle time.
- `sortOrder` exists but is 0 everywhere; `parentTaskId` unused (0 tasks); status vocabulary is
  hardcoded in ~14 places with two conflicting column lists (5 vs 6 incl. phantom `blocked`).
- WIP limit enforced only on UI/move paths (limit = `user.wipLimit ?? 3`), NOT on agent PATCH.

## PRD index

| PRD | Title | Depends on |
|---|---|---|
| KB2-01 | Foundation: status module, transition service, schema + migration | — |
| KB2-02 | Commitment point: replenish/demote, global ranked queue, caps | 01 |
| KB2-03 | Processing (triage) + Definition of Ready | 01 |
| KB2-04 | Policy engine: WIP, pull window, expedite, allocations + tuning UI | 02 |
| KB2-05 | Flow metrics: Work Item Age first, SLE/scatter later | 01 |
| KB2-06 | Views: Inventory, Queue, Replenishment, Flow (buttons, rank badges) | 02 |
| KB2-07 | Spikes + discovered work (stop-now test) | 01 |
| KB2-08 | Software board + agent handoff brief | 02 |
| KB2-09 | MCP toolset v2 (actor attribution; lands incrementally with each phase) | rolling |
| KB2-10 | Standing work / Supply panel (cartridge build queue) | independent |

## Non-goals

Time tracking; performance dashboards; daily-log system; portfolio rollups beyond projects;
changes to approvals/equipment/inventory modules; QMS record semantics; site-wide RBAC revamp.
