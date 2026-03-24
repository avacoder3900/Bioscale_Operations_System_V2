# CLAUDE.md — Coding Standards for Bioscale Operations System V2

> **Security:** All auth, permission, and session code MUST follow patterns in [`SECURITY.md`](SECURITY.md). Read it before modifying any auth-related files.

## Stack
- **Framework:** SvelteKit 2 + Svelte 5
- **Database:** MongoDB Atlas + Mongoose 8
- **Language:** TypeScript (strict mode)
- **Styling:** Tailwind CSS
- **Auth:** Cookie-based sessions, bcrypt password hashing
- **IDs:** nanoid strings (not ObjectId)

## File Structure

```
src/
├── routes/                    # SvelteKit file-based routing
│   ├── +layout.svelte         # Root layout (DO NOT MODIFY)
│   ├── +layout.server.ts      # Root auth check
│   ├── login/                 # Public auth routes
│   ├── spu/                   # Main app routes (protected)
│   ├── kanban/                # Kanban board
│   ├── documents/             # Document control
│   ├── opentrons/             # Lab robot control
│   └── api/                   # API endpoints
├── lib/
│   ├── components/            # Shared Svelte components (DO NOT MODIFY)
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

## Rules

### DO NOT MODIFY
- Any `.svelte` file (UI layer is frozen — copied from old app)
- `src/lib/components/`
- `src/lib/stores/`
- `src/lib/utils/` (client-side)
- `src/app.html`, `src/app.css`
- `static/`

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
- **Don't forget JSON serialization** — SvelteKit can't serialize Mongoose docs directly
- **Don't modify .svelte files** — the UI layer is frozen
- **Don't skip audit logging** — every mutation gets an AuditLog entry
