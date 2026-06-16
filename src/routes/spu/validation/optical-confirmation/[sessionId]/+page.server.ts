import { error } from '@sveltejs/kit';
import { requirePermission } from '$lib/server/permissions';
import { connectDB, ValidationSession } from '$lib/server/db';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, params }) => {
	requirePermission(locals.user, 'spu:read');
	await connectDB();

	const session = await ValidationSession.findById(params.sessionId).lean();
	if (!session) throw error(404, 'Session not found');

	return { session: JSON.parse(JSON.stringify(session)) };
};

export const config = { maxDuration: 60 };
