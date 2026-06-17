import { redirect } from '@sveltejs/kit';
import { requirePermission } from '$lib/server/permissions';
import { connectDB, KanbanProject, User } from '$lib/server/db';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = async ({ locals, depends }) => {
	if (!locals.user) redirect(302, '/login');
	requirePermission(locals.user, 'kanban:read');

	// Tag for `invalidate('kanban:projects')` calls from the client so this
	// layout re-runs after a UI-state POST mutates KanbanProject. Without this,
	// the layout's `data.projects` would stay stale across sibling-route
	// navigations (e.g., /kanban → /kanban/list → /kanban) because SvelteKit
	// caches layout data by default.
	depends('kanban:projects');

	await connectDB();

	const projects = await KanbanProject.find({ isActive: true }).sort({ sortOrder: 1 }).lean();
	const users = await User.find({}, { _id: 1, username: 1 }).lean();

	return {
		user: JSON.parse(JSON.stringify(locals.user)),
		projects: projects.map((p) => ({
			id: p._id, name: p.name, description: p.description ?? null,
			color: p.color, isActive: p.isActive, sortOrder: p.sortOrder,
			createdBy: p.createdBy ?? null,
			// Default-aware normalization: collapsed defaults to false (expanded),
			// backlogCollapsed defaults to true (collapsed). Legacy projects with
			// missing fields fall through to these defaults.
			collapsed: p.collapsed === true,
			backlogCollapsed: p.backlogCollapsed !== false
		})),
		users: users.map((u) => ({ id: u._id, username: u.username }))
	};
};

export const config = { maxDuration: 60 };
