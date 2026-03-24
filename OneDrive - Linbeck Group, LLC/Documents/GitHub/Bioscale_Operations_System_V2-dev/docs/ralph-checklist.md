# Ralph Loop — Story Implementation Checklist

Use this checklist for every coding sub-agent session.

## Pre-Implementation (Coding Sub-Agent Startup)
- [ ] `git pull origin [feature-branch]` — always, before anything else
- [ ] Read repo `AGENTS.md` completely
- [ ] Read repo `CLAUDE.md` (coding standards)
- [ ] Read repo `progress.txt` — Codebase Patterns section first, then recent entries
- [ ] Read repo `prd.json` — locate assigned story
- [ ] Confirm story is right-sized (completable in one context window)
- [ ] Confirm story dependencies are already implemented

## Implementation
- [ ] Follow coding standards from CLAUDE.md exactly
- [ ] Use existing patterns from progress.txt Codebase Patterns section
- [ ] No dead code, no commented-out blocks
- [ ] Security requirements met (input validation, auth checks, audit logging)
- [ ] Mobile/tablet touch targets respected (min 44px)

## Validation
- [ ] `npm run check` passes (TypeScript + Svelte)
- [ ] `npm run lint` passes (ESLint + Prettier)
- [ ] `npm run test:unit` passes (Vitest)
- [ ] If schema.ts was modified: ran `npm run db:push:auto` successfully (no data-loss abort)
- [ ] If new columns added to schema: verified they exist in DB after push
- [ ] If new columns queried in page loads: verified page loads without 500 error
- [ ] Tested in browser if UI changes

## Commit & Push
- [ ] Staged all relevant changes
- [ ] Commit message follows format: `feat: US-XXX - Brief description\n\nCo-Authored-By: Claude Code <noreply@anthropic.com>`
- [ ] Committed to feature branch (NEVER to dev or main)
- [ ] `git push origin [feature-branch]` — so orchestrator and other sub-agents stay current
- [ ] `prd.json` story status updated to `complete`

## Progress Log
- [ ] Appended entry to `progress.txt` following existing entry format exactly
- [ ] Included: what was implemented, files changed, key learnings
- [ ] Updated Codebase Patterns section if new reusable pattern discovered

## Handoff
- [ ] Report completion to orchestrator sub-agent
- [ ] List any blockers or dependencies for subsequent stories
- [ ] Session ends
