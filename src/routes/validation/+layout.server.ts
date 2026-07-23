import { redirect } from '@sveltejs/kit';
import { requirePermission } from '$lib/server/permissions';
import { connectDB, ValidationRun } from '$lib/server/db';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = async ({ locals }) => {
	if (!locals.user) redirect(302, '/login');
	requirePermission(locals.user, 'spu:read');
	await connectDB();

	// Badge on the Runs nav tab: how many runs are being worked right now
	const activeRunCount = await ValidationRun.countDocuments({ status: 'in_progress' });

	return { user: JSON.parse(JSON.stringify(locals.user)), activeRunCount };
};

export const config = { maxDuration: 60 };
