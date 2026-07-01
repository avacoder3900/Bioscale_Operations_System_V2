# CLAUDE.md — Coding Standards for Bioscale Operations System V2

> **Security:** All auth, permission, and session code MUST follow patterns in [`SECURITY.md`](SECURITY.md). Read it before modifying any auth-related files.

## Stack
- **Framework:** SvelteKit 2 + Svelte 5
- **Database:** MongoDB Atlas + Mongoose 9
- **Language:** TypeScript (strict mode)
- **Styling:** Tailwind CSS
- **Auth:** Cookie-based sessions, bcrypt password hashing
- **IDs:** nanoid strings (not ObjectId)

## File Structure

```
src/
├── routes/                    # SvelteKit file-based routing
│   ├── +layout.svelte         # Root layout
│   ├── +layout.server.ts      # Root auth check
│   ├── login/                 # Public auth routes
│   ├── spu/                   # Main app routes (protected)
│   ├── kanban/                # Kanban board
│   ├── documents/             # Document control
│   ├── opentrons/             # Lab robot control
│   └── api/                   # API endpoints
├── lib/
│   ├── components/            # Shared Svelte components
│   ├── server/
│   │   ├── db/
│   │   │   ├── connection.ts  # Mongoose connection singleton
│   │   │   ├── models/        # All 53 Mongoose models
│   │   │   └── middleware/    # Sacred + immutable middleware
│   │   ├── auth.ts            # Session management utilities
│   │   └── permissions.ts     # Permission checking
│   ├── stores/                # Svelte stores (DO NOT MODIFY)
│   ├── utils/                 # Client-side utilities (DO NOT MODIFY)
│   └── types/                 # TypeScript types
├── app.html                   # HTML template (DO NOT MODIFY)
└── hooks.server.ts            # Auth middleware (session validation on every request)
```

## Deployment Rules (MANDATORY)

**NEVER deploy to Vercel from local (`npx vercel deploy` / `vercel deploy --prod`).** This has already
caused untraceable deployments in this project — a deployment with no git metadata means nobody can
find the branch/commit it came from later. Always:
1. Commit to the feature branch.
2. `git push origin <branch>` to GitHub.
3. Let Vercel's GitHub integration build/deploy from that push (preview for branches, production for
   `master`). If the GitHub integration isn't firing (check the Vercel dashboard's Deployments tab
   before assuming this), fix *that* — don't route around it with a local CLI deploy.

Every deployment must be traceable to a GitHub commit. If you ever must deploy from local as a one-off
exception, log it immediately in `progress.txt` per the Deployment Log Entries format below so it stays
traceable.

### Progress Log Heartbeat (MANDATORY)

Update `progress.txt` at least once per hour of active session work — every 30 minutes when the
session involves substantial, ongoing changes. Don't wait until the end of a session to write it up;
if the session is interrupted, the log should still reflect what was actually done.

Each entry:
```
================================================================================
YYYY-MM-DD — <branch-name> — <one-line summary>
================================================================================
What was built/changed/fixed, in the existing narrative style (see entries below this
section for the established tone/detail level). Include: files touched, root cause if
it's a fix, and `npm run check` status (error count vs. the current baseline).
```

### Deployment Log Entries (MANDATORY)

Any time a deployment (preview or production) is created for a branch, log it — don't rely on the
Vercel dashboard alone, since deployment history there is not branch/commit-searchable the way this
file is. Append to the relevant progress.txt entry:
```
Deployment: <preview|production> — <deployment URL>
Source: branch <branch-name> @ commit <short-sha>
Retrieve this exact code: git checkout <branch-name> at commit <short-sha>
  (or: git log <branch-name> --oneline to find it if the branch has since moved on)
What this deployment is for: <one line — what feature/fix it's meant to demonstrate or test>
```

## Rules

### DO NOT MODIFY
- `src/lib/stores/`
- `src/lib/utils/` (client-side)
- `src/app.html`, `src/app.css`
- `static/`

> **Svelte UI freeze lifted (2026-06-19):** `.svelte` files and `src/lib/components/` are no longer frozen and may be modified. (`stores/`, `utils/`, `app.html`, `app.css`, and `static/` remain off-limits unless explicitly authorized.)

### Server Files (what you CAN modify)
- `+page.server.ts` — load functions and form actions
- `+layout.server.ts` — layout data loading
- `+server.ts` — API endpoints
- `src/lib/server/` — all server-side code
- `src/hooks.server.ts` — auth middleware

## Coding Patterns

### Load Functions
```typescript
import { connectDB } from '$lib/server/db/connection';
import { SomeModel } from '$lib/server/db/models';
import { requirePermission } from '$lib/server/permissions';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
    requirePermission(locals.user, 'resource:read');
    await connectDB();
    
    const items = await SomeModel.find({ active: true })
        .select('name status createdAt')
        .sort({ createdAt: -1 })
        .lean();
    
    return { items: JSON.parse(JSON.stringify(items)) };
};
```

### Form Actions
```typescript
import { fail, redirect } from '@sveltejs/kit';
import { generateId } from '$lib/server/db/models';
import { AuditLog } from '$lib/server/db/models';

export const actions = {
    create: async ({ request, locals }) => {
        requirePermission(locals.user, 'resource:write');
        await connectDB();
        
        const data = await event.request.formData();
        const name = data.get('name')?.toString();
        if (!name) return fail(400, { error: 'Name is required' });
        
        const item = await SomeModel.create({
            _id: generateId(),
            name,
            createdBy: { _id: event.locals.user._id, username: event.locals.user.username },
            createdAt: new Date()
        });
        
        await AuditLog.create({
            _id: generateId(),
            action: 'create',
            resourceType: 'some_resource',
            resourceId: item._id,
            userId: event.locals.user._id,
            username: event.locals.user.username,
            timestamp: new Date(),
            details: { name }
        });
        
        throw redirect(303, `/spu/resource/${item._id}`);
    }
};
```

### API Endpoints
```typescript
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async (event) => {
    const apiKey = event.request.headers.get('x-api-key') 
        || event.request.headers.get('x-agent-api-key');
    if (apiKey !== process.env.AGENT_API_KEY) {
        return json({ error: 'Unauthorized' }, { status: 401 });
    }
    
    await connectDB();
    const data = await SomeModel.find().lean();
    return json({ data });
};
```

### Sacred Document Mutations
```typescript
// Always check finalization before mutating
const doc = await SacredModel.findById(id);
if (doc.finalizedAt) {
    return fail(400, { error: 'Cannot modify finalized document. Use corrections.' });
}

// Corrections for finalized docs
await SacredModel.findByIdAndUpdate(id, {
    $push: {
        corrections: {
            field: 'fieldName',
            oldValue: doc.fieldName,
            newValue: newValue,
            reason: 'Reason for correction',
            correctedBy: { _id: user._id, username: user.username },
            correctedAt: new Date()
        }
    }
});
```

### Serialization
Always serialize Mongoose documents for SvelteKit:
```typescript
// Use .lean() for queries (returns plain objects)
const items = await Model.find().lean();

// JSON round-trip to strip Mongoose internals
return { items: JSON.parse(JSON.stringify(items)) };
```

## Validation Commands
```bash
npm run check          # TypeScript + Svelte type checking
npm run build          # Production build
npm run test:contracts # Run 84 contract tests against running app
npx tsx scripts/seed.ts # Seed test data
```

## Common Pitfalls
- **Don't use ObjectId** — all `_id` fields are nanoid strings
- **Don't forget `await connectDB()`** — Mongoose connection is lazy
- **Don't forget `.lean()`** — without it, Mongoose returns heavy documents
- **Don't forget JSON serialization** — SvelteKit can't serialize Mongoose docs directly. Always `JSON.parse(JSON.stringify(data))` before returning from load functions, especially for user objects in layouts.
- **Don't skip audit logging** — every mutation gets an AuditLog entry
- **Don't forget `_id: false` on subdocument arrays** — Mongoose auto-adds ObjectId `_id` to every subdocument unless you opt out. ObjectId breaks SvelteKit serialization. Use `_id: false` for data-only subdocs, or `_id: { type: String, default: () => generateId() }` for trackable subdocs.
- **Don't skip `requirePermission()`** — every load function and action needs it. See [SECURITY.md](SECURITY.md).
