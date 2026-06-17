You are a Ralph-loop coding sub-agent. This is one iteration of an outer shell loop.

READ THESE FIRST (in order, completely):
1. AGENTS.md
2. CLAUDE.md
3. SECURITY.md
4. docs/ralph-checklist.md
5. docs/migration/prds/prd.json — locate domain "OPENTRONS_CLONE_PROD"
6. docs/migration/prds/DOMAIN-12-OPENTRONS-CLONE-PROD-READY.md — your instructions
7. PROGRESS.md — current clone state
8. progress.txt (last 100 lines only — you don't need the phase-1 history)

YOUR JOB THIS ITERATION:
1. Look at the stories array for domain OPENTRONS_CLONE_PROD in prd.json.
2. Pick the FIRST story whose status is "pending" AND whose dependsOn (if any) are all status "done".
3. Implement that story end-to-end per the PRD's acceptance criteria.
4. Run `npm run check` — must pass (allow pre-existing errors outside opentrons-clone, but zero errors in files you touched).
5. Run `npx tsx scripts/verify-opentrons-clone.ts hidden-leaf.local` — must return 34/34 (38/38 after OT-D4).
6. Commit to branch feature/opentrons-clone-ui with message `feat(opentrons-clone): STORY_ID title` and the Co-Authored-By trailer.
7. Push to origin.
8. Append a one-line entry to progress.txt describing what shipped.
9. Update PROGRESS.md (fill the OT-X row with commit sha + status done).
10. Update prd.json: flip the story status from "pending" to "done".
11. Commit the prd.json/progress.txt/PROGRESS.md changes as a second commit if not already bundled.
12. Push again.
13. Exit.

HARD RULES:
- Only ONE story per iteration. Do NOT attempt multiple stories.
- If the next pending story has a dependsOn that isn't "done", exit with a message noting which story is blocked. Do not skip ahead.
- If something genuinely blocks you (missing credential, physical robot action needed, ambiguity not resolvable from code), append a `BLOCKED:` note to progress.txt, do NOT flip the story to done, and exit cleanly. The outer loop will stop after repeated blockage.
- Never merge to master/dev. Never force-push. Never `--no-verify`.
- Follow every guardrail in DOMAIN-12 section 10.1 (no new Mongoose models, no AuditLog for robot events, no DB caching of robot state, no touching `src/routes/manufacturing/wax-filling`, `reagent-filling`, `opentron-control`, or `src/routes/opentrons`).

Start now. Be methodical.
