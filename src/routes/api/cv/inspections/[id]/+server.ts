import { json, error } from '@sveltejs/kit';
import { connectDB } from '$lib/server/db/connection.js';
import { CvInspection } from '$lib/server/db/models/cv-inspection.js';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) throw error(401, 'Unauthorized');
	await connectDB();

	const inspection = await CvInspection.findById(params.id).lean();
	if (!inspection) return json({ error: 'Inspection not found' }, { status: 404 });

	return json({ data: JSON.parse(JSON.stringify(inspection)) });
};
