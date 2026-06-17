# Spec-Driven Development — Bootstrap Instructions

**Instructions for Claude Code:** Read this entire document, then execute the setup below. Create every file specified. When you finish, report what was created and ask the user to fill in the steering files.

---

## What you're setting up

A spec-driven development (SDD) workflow for this repository. The goals:

1. **Specs are the source of truth.** Features start as written specifications, not prompts.
2. **Phase gates prevent drift.** Specify → Plan → Tasks → Implement, with validation between each phase.
3. **Persistent context lives in the repo.** Agents read steering files every time, not just the active conversation.
4. **Audit trail by default.** Every feature leaves a paper trail of requirements, design decisions, and tasks — useful for regulated environments (ISO 13485, 21 CFR 820) and for future you.

This is adapted from patterns used by GitHub Spec Kit, AWS Kiro, and the Spec-Driven Development methodology that emerged in 2025–2026.

---

## Folder structure to create

```
.sdd/
├── steering/                    # persistent project context (read every session)
│   ├── product.md               # what we're building and why
│   ├── tech.md                  # stack, conventions, constraints
│   ├── structure.md             # codebase organization
│   └── compliance.md            # regulatory / quality requirements
├── features/                    # one folder per feature
│   └── .gitkeep
├── templates/
│   ├── spec.template.md
│   ├── plan.template.md
│   └── tasks.template.md
└── README.md                    # SDD workflow reference

.claude/
└── commands/
    ├── specify.md               # /specify slash command
    ├── plan.md                  # /plan slash command
    ├── tasks.md                 # /tasks slash command
    ├── implement.md             # /implement slash command
    └── status.md                # /status slash command

CLAUDE.md                        # root context file (create if missing, append if exists)
```

---

## Step 1 — Create `CLAUDE.md` (root)

If `CLAUDE.md` already exists, append the SDD section to it. If not, create it with this content:

```markdown
# Project Context for Claude Code

## Spec-Driven Development

This project uses spec-driven development (SDD). Before implementing any feature, you MUST:

1. Read every file in `.sdd/steering/` — this is persistent project context
2. Check `.sdd/features/` for the active feature's spec, plan, and tasks
3. Follow the workflow: `/specify` → `/plan` → `/tasks` → `/implement`
4. Never skip phases. Never write production code without an approved task from `tasks.md`

## Workflow Commands

- `/specify <feature description>` — generate a specification for a new feature
- `/plan` — generate the technical plan from the current spec
- `/tasks` — break the plan into a task checklist
- `/implement <task-id>` — implement one task from the checklist
- `/status` — show current feature state and next action

## Golden Rules

- The spec is the contract. If reality diverges from the spec, update the spec first.
- One feature at a time per branch. Feature folders are numbered: `001-feature-name`, `002-feature-name`.
- Every task produces a commit. Commit messages reference the task ID.
- Questions go to the user, not to assumptions. If a spec is ambiguous, ask.

## File Locations

- Steering: `.sdd/steering/*.md`
- Active specs: `.sdd/features/NNN-feature-name/`
- Templates: `.sdd/templates/`
```

---

## Step 2 — Create steering files

These are the persistent context files. Create them as stubs with prompts for the user to fill in. DO NOT invent content for the user — leave placeholders with clear guidance.

### `.sdd/steering/product.md`

```markdown
# Product Context

> Fill this in. This file is read at the start of every session. Keep it under 300 lines.

## What we're building

<!-- One-paragraph description of the product. What does it do, for whom, and why. -->

## Who uses it

<!-- Primary users, their context, and what they care about. -->

## Success looks like

<!-- Measurable outcomes. Not "users love it" — specifics. -->

## Non-goals

<!-- What this product is explicitly NOT. Prevents scope creep. -->

## Glossary

<!-- Domain-specific terms. Especially important for jargon-heavy fields. -->

| Term | Definition |
|------|------------|
|      |            |
```

### `.sdd/steering/tech.md`

```markdown
# Technical Context

> Fill this in. This file is read at the start of every session.

## Stack

- **Language(s):**
- **Framework(s):**
- **Database:**
- **Infrastructure:**
- **Key libraries:**

## Conventions

- **Formatting:**
- **Linting:**
- **Testing framework:**
- **Commit style:**
- **Branch naming:**

## Constraints

<!-- Non-negotiable technical requirements. Examples:
- Must run offline
- Cannot exceed 50ms response time
- Must support X firmware version
- Cannot use any GPL-licensed code -->

## Forbidden patterns

<!-- Things you've tried that didn't work, or things that would break the system.
Save agents (and future you) from repeating mistakes. -->
```

### `.sdd/steering/structure.md`

```markdown
# Code Structure

> Fill this in. This file tells agents where things live.

## Directory layout

```
<!-- Tree of main directories with one-line descriptions -->
```

## Where to put new code

- **New feature:** 
- **New API endpoint:** 
- **New database migration:** 
- **New test:** 
- **New utility/helper:** 

## Naming conventions

- **Files:** 
- **Functions:** 
- **Types/classes:** 
- **Database tables:** 
```

### `.sdd/steering/compliance.md`

```markdown
# Compliance & Quality Context

> Fill this in if your project has regulatory, security, or quality requirements.
> Delete this file if it doesn't apply.

## Applicable standards

<!-- e.g., ISO 13485, 21 CFR Part 820, SOC 2, HIPAA, GDPR -->

## Design control requirements

<!-- How specs map to design input documents, if applicable -->

## Traceability

<!-- Requirement ID format, how requirements link to code, how tests verify requirements -->

## Review and approval gates

<!-- Who reviews what, and at what phase -->

## Record retention

<!-- What artifacts must be preserved, where, and for how long -->

## Things that require human sign-off (never agent-only)

<!-- Changes to validated protocols, production firmware releases,
     anything touching patient-facing or safety-critical paths -->
```

---

## Step 3 — Create templates

### `.sdd/templates/spec.template.md`

```markdown
---
id: NNN
name: feature-name
status: draft  # draft | in-review | approved | implemented
created: YYYY-MM-DD
author:
---

# Specification: <Feature Name>

## Problem

<!-- What pain point or opportunity does this address? Whose pain? -->

## User journey

<!-- Step-by-step walkthrough from the user's perspective. -->

1. User ...
2. System ...
3. User ...

## Requirements (EARS notation)

Use Easy Approach to Requirements Syntax. Each requirement gets an ID.

**Ubiquitous** (always true):
- REQ-001: The system shall <response>.

**Event-driven** (happens in response to a trigger):
- REQ-002: When <trigger>, the system shall <response>.

**State-driven** (while a state holds):
- REQ-003: While <state>, the system shall <response>.

**Unwanted-behavior** (error / exception handling):
- REQ-004: If <unwanted condition>, then the system shall <response>.

**Optional** (feature-gated):
- REQ-005: Where <feature enabled>, the system shall <response>.

## Acceptance criteria

For each requirement, a testable criterion:

- [ ] REQ-001: <how we verify it>
- [ ] REQ-002: <how we verify it>

## Out of scope

<!-- Things someone might reasonably expect but that this feature does NOT do. -->

## Open questions

<!-- Things the user needs to answer before this spec can be approved. -->

- [ ] Q1:
- [ ] Q2:

## Dependencies

<!-- Other features, services, or decisions this depends on. -->
```

### `.sdd/templates/plan.template.md`

```markdown
---
feature_id: NNN
status: draft  # draft | in-review | approved
---

# Technical Plan: <Feature Name>

## Architecture

<!-- How does this fit into the existing system? Diagram welcome (mermaid or ASCII). -->

## Data model

<!-- Tables/schemas/types introduced or modified. Show before → after if modifying. -->

## API / interface changes

<!-- New endpoints, modified endpoints, new functions, changed signatures. -->

| Method | Path | Purpose | Auth |
|--------|------|---------|------|
|        |      |         |      |

## Technology choices

<!-- What library, pattern, or approach and WHY. Include alternatives you rejected. -->

| Decision | Chose | Rejected | Reason |
|----------|-------|----------|--------|
|          |       |          |        |

## Test strategy

- **Unit tests:** 
- **Integration tests:** 
- **Manual verification:** 
- **Regression risk:** 

## Rollout

<!-- How does this ship? Feature flag? Migration? Backfill? -->

## Risks

<!-- What could go wrong and how we'd know. -->

| Risk | Likelihood | Mitigation |
|------|------------|------------|
|      |            |            |

## Requirements trace

<!-- Which plan sections cover which requirements from the spec. -->

| REQ-ID | Covered by |
|--------|------------|
| REQ-001 |           |
```

### `.sdd/templates/tasks.template.md`

```markdown
---
feature_id: NNN
status: in-progress  # not-started | in-progress | complete
---

# Tasks: <Feature Name>

Tasks are ordered. Dependencies are marked. Check off as you complete.

## Legend

- `[ ]` not started
- `[~]` in progress  
- `[x]` complete
- `[!]` blocked

## Tasks

### Setup

- [ ] **T001** — Create feature branch `NNN-feature-name`
- [ ] **T002** — <setup task>

### Implementation

- [ ] **T003** — <task>
  - Covers: REQ-001
  - Files: `src/...`
  - Depends on: T002
  - Verification: <unit test name or manual check>

- [ ] **T004** — <task>
  - Covers: REQ-002, REQ-003
  - Files: `src/...`
  - Depends on: T003
  - Verification:

### Testing

- [ ] **TNNN** — Run full test suite
- [ ] **TNNN** — Manual verification per spec acceptance criteria

### Closeout

- [ ] **TNNN** — Update CHANGELOG
- [ ] **TNNN** — Mark spec status as `implemented`
- [ ] **TNNN** — Open PR with spec, plan, tasks linked in description
```

---

## Step 4 — Create slash commands

### `.claude/commands/specify.md`

```markdown
Generate a specification for a new feature using the spec-driven development workflow.

## Process

1. Read `.sdd/steering/*.md` to understand project context
2. Determine the next feature number (scan `.sdd/features/` for existing NNN prefixes)
3. Create a new folder: `.sdd/features/NNN-<kebab-case-name>/`
4. Copy `.sdd/templates/spec.template.md` into that folder as `spec.md`
5. Fill in the spec based on the user's description, leaving `## Open questions` for anything ambiguous
6. Write requirements in strict EARS notation
7. Do NOT invent requirements the user didn't imply — err on the side of listing them as open questions

## After generating

- Show the user the spec path
- List every open question prominently
- Do not proceed to `/plan` until the user marks the spec status as `approved`

User's feature description follows:

$ARGUMENTS
```

### `.claude/commands/plan.md`

```markdown
Generate a technical plan for the active feature.

## Process

1. Read `.sdd/steering/*.md` for project context
2. Find the active feature (most recent folder in `.sdd/features/` where spec status is `approved` but no `plan.md` exists, OR the feature the user specifies)
3. Read the spec thoroughly
4. Copy `.sdd/templates/plan.template.md` into the feature folder as `plan.md`
5. Fill in the plan:
   - Every requirement from the spec MUST appear in the "Requirements trace" table
   - Technology choices MUST list at least one rejected alternative with reasoning
   - Risks MUST be concrete, not generic
6. If you need information not in the spec or steering files, STOP and ask the user — do not guess

## After generating

- Show the plan path
- Highlight any assumptions you made
- Do not proceed to `/tasks` until the user marks the plan status as `approved`
```

### `.claude/commands/tasks.md`

```markdown
Break the approved plan into a sequenced task checklist.

## Process

1. Read `.sdd/steering/*.md`
2. Read the active feature's `spec.md` and `plan.md`
3. Verify plan status is `approved` — if not, stop and tell the user
4. Copy `.sdd/templates/tasks.template.md` into the feature folder as `tasks.md`
5. Generate tasks:
   - Each task is small enough for one focused work session (roughly 15 min to 2 hours)
   - Tasks are ordered by dependency
   - Every task lists which REQ-IDs it covers
   - Every task specifies files it will touch
   - Every task has a verification step (test name or manual check)
6. The last tasks are always: full test run, manual acceptance check against spec, changelog update, mark spec as `implemented`

## After generating

- Show the task count and estimated complexity
- Point out any task that seems likely to reveal gaps in the spec
```

### `.claude/commands/implement.md`

```markdown
Implement one task from the active feature's task list.

## Process

1. Read `.sdd/steering/*.md`
2. Read the active feature's `spec.md`, `plan.md`, and `tasks.md`
3. Identify the task to implement (from `$ARGUMENTS` if provided, else the next unblocked `[ ]` task)
4. Verify dependencies are complete
5. Mark the task `[~]` (in progress)
6. Implement ONLY what this task requires — do not expand scope
7. Run the task's verification step
8. If verification passes, mark `[x]`. If it fails, mark `[!]` and explain why
9. Commit with message format: `feat(NNN): T### - <task summary>`

## Boundaries

- Do NOT modify files outside the task's declared scope without asking
- Do NOT invent requirements not in the spec — if you find a gap, stop and surface it
- Do NOT mark a task complete if any verification step fails

Task to implement: $ARGUMENTS
```

### `.claude/commands/status.md`

```markdown
Report the current state of spec-driven work in this repo.

## Process

1. List all folders in `.sdd/features/`
2. For each, parse the frontmatter of `spec.md`, `plan.md`, `tasks.md` (if they exist)
3. Produce a status table:

| Feature | Spec | Plan | Tasks | Progress |
|---------|------|------|-------|----------|
| NNN-name | approved | approved | in-progress | 7/12 tasks |

4. Identify the ACTIVE feature (most recent in-progress)
5. For the active feature, show:
   - Next unblocked task
   - Any blocked tasks and why
   - Any open questions in the spec
6. Recommend the next command to run
```

---

## Step 5 — Create `.sdd/README.md`

```markdown
# Spec-Driven Development in This Repo

## The four phases

1. **Specify** — capture the "what" and "why" in a spec using EARS notation
2. **Plan** — design the "how" with architecture, data model, and technology choices
3. **Tasks** — break the plan into a sequenced, verifiable checklist
4. **Implement** — execute one task at a time, committing after each

Each phase has a status (`draft` → `in-review` → `approved`) and a gate. You do not advance until the current artifact is approved.

## Starting a new feature

```
/specify <describe the feature in plain language>
```

Review the generated spec. Answer the open questions. When satisfied, change `status: approved` in the spec frontmatter.

```
/plan
```

Review the generated plan. When satisfied, approve it the same way.

```
/tasks
```

Review the task list. When satisfied, start implementing:

```
/implement T003
```

Or without arguments to pick up the next unblocked task.

## Checking progress

```
/status
```

## Steering files

`.sdd/steering/` contains persistent context read at the start of every agent session:

- `product.md` — what we're building, for whom, why
- `tech.md` — stack, conventions, constraints
- `structure.md` — where code lives
- `compliance.md` — regulatory/quality requirements (delete if N/A)

Keep these under 300 lines each. Update them when reality changes.

## Why this works

Language models are excellent at pattern completion within a bounded problem. They are poor at open-ended decisions about workflow sequencing, scope boundaries, and unstated requirements. SDD externalizes those decisions into reviewable artifacts — the agent does creative work inside each phase, but the phase structure and approval gates stay deterministic and human-controlled.
```

---

## Step 6 — Report and hand off

After creating every file above:

1. Run `tree .sdd .claude` (or the equivalent) to confirm the structure
2. Tell the user:
   - Setup is complete
   - They need to fill in the four steering files: `product.md`, `tech.md`, `structure.md`, `compliance.md` (or delete `compliance.md` if it doesn't apply)
   - Once steering is filled in, they can start their first feature with `/specify <description>`
3. Offer to walk them through filling in the steering files interactively

Do NOT start generating specs or features until the user has filled in (or approved skipping) the steering files. The steering files are the foundation — without them, every spec will drift.

---

## Notes for the human (Nicholas) — read before running

A few things worth knowing before you paste this into Claude Code:

1. **Run it in a project root, not a scratch folder.** This modifies the repo structure. If you're retrofitting an existing project, commit first.

2. **The steering files matter more than the templates.** The #1 failure mode of SDD is agents generating specs that don't match your actual stack or conventions. Spend real time on `tech.md` and `structure.md`.

3. **For Brevitest / regulated work specifically:**
   - Keep `compliance.md`. It's where you note that changes to validated protocols, firmware releases, or anything touching the GEN7 cartridge pipeline needs human sign-off.
   - Consider mapping your spec IDs to your DHF requirement numbering scheme. Traceability from REQ-ID to code to verification is exactly what auditors want to see.
   - The `tasks.md` checklist with commit-per-task gives you a clean design history record.

4. **For BioScale specifically:** each PRD you've already written (lot tracking, universal work instruction framework, wax filling workflow) can be imported as an `.sdd/features/NNN-<name>/spec.md`. You don't have to start from scratch — run `/specify` with the existing PRD as context and let it reformat into EARS notation.

5. **Slash commands are Claude Code-native.** Files in `.claude/commands/` become `/commandname` automatically. The `$ARGUMENTS` placeholder receives whatever you type after the command.

6. **This is opinionated.** Spec Kit, Kiro, and OpenSpec all do this slightly differently. This version is closer to Kiro's structure (EARS notation, phased gates) but uses Spec Kit-style slash commands. If you want to swap in the official Spec Kit CLI later, the artifacts are compatible enough that migration is mostly moving folders.
