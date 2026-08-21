# KB2-32 — Capacity v2 MCP surface: what-ifs, effortDays everywhere, velocity report, bulk estimates

**Status:** approved 2026-08-20. Source: `scheduler-capacity-v2-spec.md` §MCP tool
surface. Companion: KB2-31 (the model). The workshop agent operates BIMS entirely
through MCP, so every KB2-31 capability needs a tool path. New tool NAMES require a
fresh Claude-app conversation to bind; new PARAMS on existing tools pass through
immediately — extend where sensible.

## Extended tools (params — no rebind needed)
- **`kanban_get_policy`**: echoes the `capacity` block (it already returns the whole
  policy doc — free). **`kanban_set_policy` stays human-only per PERM-05** (spec
  deviation, recorded in KB2-31): its description is updated to say capacity lives on
  /kanban/policy and to point the agent at the what-if overrides instead.
- **`kanban_capture`, `kanban_capture_bulk`, `kanban_create_subtasks`, `kanban_process`,
  `kanban_update_task`**: accept `effortDays` (number > 0; `null` on update_task
  clears). Wired through agent-shapes / processTask / reshapeTask / PATCH endpoint,
  echoed in task payloads.
- **`kanban_roadmap`**: optional what-if params, applied to THIS computation only,
  never persisted:
  `{ capacityOverride?: number, scheduleOverride?: [{from, teamEstDaysPerWeek}] }` —
  "what does A4M look like at 6 vs 10 vs 15 days/week?" live in a capacity conversation
  with John, without touching policy. Output always includes
  `measuredVelocityDaysPerWeek`, `velocitySource`, `resolvedCapacitySchedule`, and
  per-task `effortDays` where set.

## New tools (agent rebinds in a fresh chat after deploy)
- **`kanban_velocity_report`** (read-only) → GET
  `/api/agent/operations/kanban/velocity-report`: the speedometer's homework — the
  trailing-window completion list (taskId, title, completedAt, estimateDays, effortDays,
  countedDays + which field was counted), weekly buckets, measured velocity, sample size
  n, the velocitySource decision trace (policy/blend/measured + thresholds + knob), and
  calibration over the same field the clamp consumes. Purpose: the agent must be able
  to EXPLAIN any projection and audit velocity pollution, not trust one opaque number.
- **`kanban_set_estimates`** (bulk write) → POST
  `/api/agent/operations/kanban/estimates`: `[{taskId, estimateDays?, effortDays?}]`,
  1–50 entries, per-item results (applied/rejected + reason) like capture_bulk, one
  audit row per applied item. Rationale: estimate workshops are the hot loop — the v4
  worksheet took ~50 sequential `kanban_update_task` calls and hit per-turn tool caps
  twice. Single biggest agent-ergonomics win in the spec.

## Versioning
MCP server version bump (3.2.x → 3.3.0) so claude.ai refreshes the tool list; the two
new tool names still need a fresh conversation to bind.

## Acceptance (spec check #6)
- `kanban_roadmap({capacityOverride: 15})` returns the improved projection without
  persisting (immediate re-call without override matches pre-override output).
- `kanban_set_estimates` with 3 entries (one bad taskId) applies 2, rejects 1, per-item
  results.
- `kanban_velocity_report` decision trace matches the velocitySource the roadmap used.
