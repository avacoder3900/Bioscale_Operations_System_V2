import { redirect } from '@sveltejs/kit';
import { connectDB } from '$lib/server/db/connection.js';
import { CvInspection } from '$lib/server/db/models/cv-inspection.js';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = async ({ locals }) => {
	if (!locals.user) {
		redirect(302, '/login');
	}

	await connectDB();

	// Needs-review queue size for the nav badge — model verdict present, no
	// human review yet, non-shadow (same query as /cv/review; indexed).
	const reviewQueueCount = await CvInspection.countDocuments({
		result: { $ne: null },
		humanLabel: null,
		isShadow: { $ne: true },
		status: 'completed'
	});

	return {
		user: locals.user,
		reviewQueueCount
	};
};

export const config = { maxDuration: 60 };
