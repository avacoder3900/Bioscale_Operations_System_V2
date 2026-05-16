# PRD — Kanban Analytics: Daily WIP Timeline

**Domain:** Kanban / Analytics / WIP visualization
**Status:** Draft
**Depends on:** `KANBAN-ANALYTICS-FOUNDATION.md`
**Related:** `KANBAN-WIP-LIMIT-ENFORCEMENT.md` (the hard cap that makes the row-count meaningful)

---

## Problem

The kanban board shows current state per project and status, but it doesn't show *who* is working on *what* *right now*. It's also blind to the time dimension within a day — when did a task enter WIP, has it been there for 20 minutes or 6 hours, is one person carrying yesterday's work into today.

The single chart that closes all those gaps is a daily timeline grid where every person has rows equal to their WIP limit and tasks paint as colored time blocks. It collapses **operational awareness**, **WIP enforcement**, and **time-in-status** into one view.

## Goal

A full-width grid widget on `/kanban/analytics` showing one day at a time: each person occupies N stacked rows (where N = their WIP limit), the X axis is segmented into 15-minute cells from before-7-AM through after-6-PM, and each cell fills with a project color when a WIP task overlaps that bucket.

## Non-Goals

- Editing time blocks (drag to resize, shift start, etc.) — pure visualization.
- Resource forecasting / planning future blocks.
- Per-cell notes or descriptions beyond the underlying task.
- Multi-day views — the chart shows ONE day. Use the day-tabs to navigate.
- Per-team / per-project filter on this widget — shows everyone, every task.

## Scope

### 1. Visual model

```
                                 BEFORE       SCHEDULE                              AFTER
                                 ────         ───────────────────────────           ────
                                 < 7AM   7:00 7:15 7:30 ... 5:30 5:45 6:00          ≥ 6PM
┌─────────────────────────────┐ ┌─────┐┌────┬────┬────┬─────┬────┬────┬────┐ ┌─────┐
│ Alice                       │ │     ││ ▓▓ │ ▓▓ │ ▓▓ │ ▓▓  │    │    │    │ │     │  ← Lane 1
│   WIP limit: 3              │ │     ││    │    │    │     │ ░░ │ ░░ │ ░░ │ │     │  ← Lane 2
│                             │ │     ││    │    │    │     │    │    │    │ │     │  ← Lane 3 (empty)
├─────────────────────────────┤ ├─────┤├────┼────┼────┼─────┼────┼────┼────┤ ├─────┤
│ Bob                         │ │ ▒▒  ││ ▒▒ │ ▒▒ │ ▒▒ │ ▒▒  │ ▒▒ │ ▒▒ │    │ │     │  ← Lane 1 (carry-over)
│   WIP limit: 2              │ │     ││    │    │    │ ██  │ ██ │    │    │ │     │  ← Lane 2
└─────────────────────────────┘ └─────┘└────┴────┴────┴─────┴────┴────┴────┘ └─────┘
```

- **Each user contributes `wipLimit` rows.** Empty rows are visible — they're the "you have room to take another" cue.
- **Bars are cell-grid, not continuous.** Each 15-min cell either has a single solid project color (active during that quarter-hour) or is empty (light grey).
- **Overflow cells** at left and right are wider (or visually distinct) and act as catch-all buckets for activity outside the 7 AM – 6 PM window — including carry-over from prior days.

### 2. Time bucket scheme

- **44 regular buckets**, each 15 minutes wide:
  - `7:00–7:15`, `7:15–7:30`, …, `17:45–18:00` (i.e., 7 AM through 5:45 PM inclusive of the start, 6 PM exclusive)
- **`< 7 AM` overflow** on the left: any WIP duration that occurred in the 0:00–6:59 window of the chart day, OR any carry-over from prior days where the task was still in WIP at the start of the chart day.
- **`≥ 6 PM` overflow** on the right: any WIP duration that occurred 18:00 or later, OR any continuation into the next day (rendered as filled to indicate the task was still in WIP when the chart day ended).

> **Confirmed 2026-05-15**: first regular bucket is `7:00`. The `< 7 AM` overflow catches anything strictly before 7:00.

### 3. Lane assignment (within a person's WIP-limit rows)

For each person, given their list of [start, end] intervals (each interval = one WIP segment of one task):
1. Sort intervals by start time.
2. For each interval, assign it to the lowest-numbered free lane (`0` through `wipLimit - 1`) that has no overlap with already-placed intervals.
3. If no lane is free, that means `wipLimit` was effectively exceeded historically. Render the extra interval in a special "overflow lane" above the WIP-limit rows, colored red, to flag the violation. (This is a soft retrospective signal — actual prevention is in `KANBAN-WIP-LIMIT-ENFORCEMENT.md`.)

### 4. Day navigation

- Tabs at the top of the widget: **S M T W R F S** for the current week, plus a single back/forward arrow set to jump weeks.
- Active tab highlights with the Tron accent.
- Default: today. Days in the future are shown but empty (no tasks have entered the future yet — duh).
- URL state: `?day=YYYY-MM-DD` so deep-links are shareable.

### 5. Carry-over rendering

If task T is moved to WIP at 3 PM Tuesday and exits WIP at 11 AM Thursday:
- **Tuesday's chart**: cells filled from `15:00` bucket through `≥ 6 PM` overflow (the task was still in WIP at end of day).
- **Wednesday's chart**: `< 7 AM` overflow filled (carry-over), every regular bucket filled, `≥ 6 PM` overflow filled (continues to next day).
- **Thursday's chart**: `< 7 AM` overflow filled (carry-over), then regular buckets `7:00` through `10:45` filled, `11:00` and later empty.

### 6. Interactivity

- **Click a cell** → opens the task detail of the task occupying that cell. If multiple tasks happen to share a cell on the same lane (shouldn't, given lane-assignment) → pick the one whose start is earliest.
- **Hover a cell** → tooltip: task title, project, time entered WIP, time left WIP (or "still in WIP"), total duration in WIP today.
- **Click a person's name** → `/kanban/list?assignee=<id>`.

### 7. Polling

- Refresh data every 30 seconds while the page is visible (use Page Visibility API to pause when tab is hidden).
- Updates are seamless — no full page reload, just the widget's state.

### 8. Data shape

```typescript
type WipTimelinePerson = {
  userId: string;
  username: string;
  wipLimit: number;       // from User.wipLimit, default 3
  lanes: WipLane[];       // length === wipLimit + (overflow if violations)
};

type WipLane = {
  laneIndex: number;
  isOverflow: boolean;    // true for lanes above wipLimit (red-bordered)
  segments: WipSegment[];
};

type WipSegment = {
  taskId: string;
  taskTitle: string;
  projectId: string | null;
  projectColor: string;   // hex, falls back to '#888' if no project
  startBucket: BucketRef; // 'before' | { hour, quarter } | 'after'
  endBucket: BucketRef;
  startUtc: string;       // ISO, exact moment for tooltip
  endUtc: string | null;  // null if still in WIP
};
```

### 9. Data source

Read from `KanbanTask.activityLog[]` filtered to entries with `action: 'status_change'` and `details.to === 'wip'` or `details.from === 'wip'`. Walk per-task to pair entries into [start, end] intervals. Clip each interval to the chart day's window. Group by task `assignee._id`.

Tasks with no assignee but in WIP on the chart day get aggregated under "— Unassigned —" with `wipLimit: 0` (zero lanes; their bars all render in overflow lanes to make them visible as anomalies).

## Decisions

- **Row identity = assignee**, not actor.
- **Browser local time** for bucket computation. Server returns raw UTC timestamps; client converts. (Avoids server needing to know each user's timezone.)
- **First bucket is `7:00`** unless Jacob confirms otherwise.
- **Polling every 30s**, paused when tab hidden.
- **Overflow lane in red** flags retrospective WIP violations (separate from the hard cap in the enforcement PRD).

## Acceptance criteria

1. Widget renders below the CFD with the day-tab strip, the person rows, and the bucket grid.
2. A task moved to WIP at 9:30 AM today fills cell `9:30` immediately on next poll.
3. A task moved out of WIP at 11:15 AM stops adding cells; cells already filled remain.
4. A task in WIP at end of day yesterday and still in WIP today shows `< 7 AM` overflow filled on today's chart.
5. Each person has exactly `wipLimit` lanes (default 3 if `User.wipLimit` not set).
6. Click a filled cell → navigates to `/kanban/task/[taskId]`.
7. Hover shows tooltip with task title, project, and time entered WIP.
8. Day tabs work — clicking Monday shows Monday's data, URL updates to `?day=YYYY-MM-DD`.
9. Polling fires every 30s while visible (verify in devtools network panel).
10. If a person has 4 WIP tasks at once (violating their limit-of-3), the 4th appears in a red-bordered overflow lane above their normal 3.
11. `npm run check` clean.

## Files touched

| File | Change |
|------|--------|
| `src/lib/server/db/models/user.ts` | Add `wipLimit: { type: Number, default: 3 }` |
| `src/lib/server/kanban/analytics.ts` | Add `wipTimeline` block, parameterized by day |
| `src/lib/components/kanban/WipTimelineWidget.svelte` | New: grid + day tabs |
| `src/lib/components/kanban/WipTimelineCell.svelte` | New: single 15-min cell (props: filled, color, taskRef) |
| `src/routes/kanban/analytics/+page.svelte` | Embed widget below CFD |
| `docs/prds/KANBAN-WIP-TIMELINE.md` | This doc |

## Risk / rollback

- **Visual density**: 46 cells × (N people × 3 lanes) can get tall fast. Cap at vertical scroll within the widget if > 30 people. Probably fine at our team size.
- **Polling load**: 30s polling × N concurrent viewers = N/30 RPS. Trivial.
- **Timezone drift**: server returns UTC, client interprets — single source of truth. Should be robust.
- **Lane assignment edge case**: extremely rapid wip → other → wip flips on the same task in the same day could create many small segments. Acceptable as-is.
- **Rollback**: hide the widget; data block stays unused.

## Open questions (deferred — not blocking implementation)

- **Overflow lane behavior**: render in red above normal lanes (PRD default), or suppress entirely and only show violations on a separate "WIP violations" KPI card?
- **Should `< 7 AM` carry-over also indicate the originating prior day** (e.g., dotted hatch + tooltip showing "started 3:00 PM Tuesday")? Default: tooltip only.
