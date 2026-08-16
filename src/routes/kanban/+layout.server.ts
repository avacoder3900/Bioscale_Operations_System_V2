import { redirect } from '@sveltejs/kit';
import { requirePermission } from '$lib/server/permissions';
import { connectDB, User } from '$lib/server/db';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = async ({ locals }) => {
	if (!locals.user) redirect(302, '/login');
	requirePermission(locals.user, 'kanban:read');

	await connectDB();

	// KB2-16: projects are gone — tags on tasks carry the grouping.
	const users = await User.find({}, { _id: 1, username: 1 }).lean();

	return {
		user: JSON.parse(JSON.stringify(locals.user)),
		users: users.map((u) => ({ id: u._id, username: u.username }))
	};
};

export const config = { maxDuration: 60 };
