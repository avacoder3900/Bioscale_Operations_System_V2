# docs/agent — what an agent needs before touching the OT-2 fill system

Written 2026-10-26 (OT2-WIRED-1 workstream E). These pages are for Claude Code / any coding agent working on BIMS's robot side. They are facts and procedures, not design history; the design history is in `docs/prds/` and `docs/OT2-TAILNET-CONNECTION-AUDIT-2026-10-07.md`.

| Page | Read it when |
|---|---|
| [SYSTEM-MAP.md](SYSTEM-MAP.md) | you need an id, hostname, address, mount, deck, fixture value or a "normal" number for a robot |
| [CONNECTION-ARCHITECTURE.md](CONNECTION-ARCHITECTURE.md) | anything says "offline", "did not respond", "line", "queue", "tailnet", "bridge" |
| [INVARIANTS.md](INVARIANTS.md) | before editing labware definitions, calibration, run start, the daemon, or the Studio |
| [RUNBOOK-CONNECTIVITY-TRIAGE.md](RUNBOOK-CONNECTIVITY-TRIAGE.md) | a robot or fill page is slow, stuck or "offline" |
| [RUNBOOK-CALIBRATION-AND-RACK-DRIFT.md](RUNBOOK-CALIBRATION-AND-RACK-DRIFT.md) | tips land off, pick-ups fail, "NO TIP DETECTED", Studio and fill disagree |
| [DATA-DICTIONARY.md](DATA-DICTIONARY.md) | you need to know where a fact is recorded and for how long |
| [DECISIONS.md](DECISIONS.md) | you are about to re-decide something that was already decided |
| [IMPROVEMENT-LOOP.md](IMPROVEMENT-LOOP.md) | after an incident, or on the weekly review |

Rules of engagement that apply to every page here:
- Production is `origin/master`; the local checkout on the lab iMac lags — read `git show origin/master:<path>`.
- Robots are production equipment. Reads are free; anything that moves a gantry, changes a network profile, restarts a service or edits geometry is announced to the operator first and done between runs.
- Secrets never go in the repo or in chat. The Mongo connection string lives outside the repo on the lab iMac (see SYSTEM-MAP).
- Keep `progress.txt` current (CLAUDE.md "Progress Log Heartbeat").
