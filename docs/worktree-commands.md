# Git Worktree Command Reference

## Create a worktree for a new workstream
```bash
git worktree add /Users/agent001/Bioscale_Worktrees/[feature-name] -b ralph/[feature-name]
```

## List all active worktrees
```bash
git worktree list
```

## Remove a worktree after merge is complete
```bash
git worktree remove /Users/agent001/Bioscale_Worktrees/[feature-name]
# If it has uncommitted changes and you're sure:
git worktree remove --force /Users/agent001/Bioscale_Worktrees/[feature-name]
```

## Prune stale worktree references
```bash
git worktree prune
```

## Copy .env to new worktree (shares same DATABASE_URL)
```bash
cp /Users/agent001/Bioscale_Operations_System/.env /Users/agent001/Bioscale_Worktrees/[feature-name]/.env
```

## Install dependencies in new worktree
```bash
cd /Users/agent001/Bioscale_Worktrees/[feature-name] && npm install
```

## Smart merge: feature branch → dev
```bash
cd /Users/agent001/Bioscale_Operations_System
git checkout dev
git pull origin dev
git merge --no-ff ralph/[feature-name]
# Resolve conflicts if any, then:
npm run check && npm run lint && npm run test:unit
npm run db:push
# Only after all pass and human approves:
git push origin dev
```

## Delete feature branch after successful merge
```bash
git branch -d ralph/[feature-name]
git push origin --delete ralph/[feature-name]
```
