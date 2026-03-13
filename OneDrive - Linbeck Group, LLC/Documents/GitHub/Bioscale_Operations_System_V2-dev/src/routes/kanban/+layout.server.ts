import { redirect } from '@sveltejs/kit';
import { requirePermission } from '$lib/server/permissions';
import { connectDB, KanbanProject, User } from '$lib/server/db';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = async ({ locals }) => {
	if (!locals.user) redirect(302, '/login');
	requirePermission(locals.user, 'kanban:read');

	await connectDB();

	const projects = await KanbanProject.find({ isActive: true }).sort({ sortOrder: 1 }).lean();
	const users = await User.find({}, { _id: 1, username: 1 }).lean();

	return {
		user: locals.user,
		projects: projects.map((p) => ({
			id: p._id, name: p.name, description: p.description ?? null,
			color: p.color, isActive: p.isActive, sortOrder: p.sortOrder,
			createdBy: p.createdBy ?? null
		})),
		users: users.map((u) => ({ id: u._id, username: u.username }))
	};
};
