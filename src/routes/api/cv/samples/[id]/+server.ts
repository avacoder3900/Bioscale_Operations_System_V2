import { json, error } from '@sveltejs/kit';
import { connectDB } from '$lib/server/db/connection.js';
import { CvSample } from '$lib/server/db/models/cv-sample.js';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) throw error(401, 'Unauthorized');
	await connectDB();

	const sample = await CvSample.findById(params.id).lean();
	if (!sample) return json({ error: 'Sample not found' }, { status: 404 });

	return json({ data: JSON.parse(JSON.stringify(sample)) });
};

export const PATCH: RequestHandler = async ({ params, request, locals }) => {
	if (!locals.user) throw error(401, 'Unauthorized');
	await connectDB();

	try {
		const body = await request.json();
		const allowed = ['name', 'description', 'tags', 'metadata'];
		const update: Record<string, unknown> = {};
		for (const key of allowed) {
			if (body[key] !== undefined) update[key] = body[key];
		}

		const sample = await CvSample.findByIdAndUpdate(params.id, update, { new: true }).lean();
		if (!sample) return json({ error: 'Sample not found' }, { status: 404 });

		return json({ data: JSON.parse(JSON.stringify(sample)) });
	} catch (err: any) {
		return json({ error: err.message }, { status: 500 });
	}
};

export const DELETE: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) throw error(401, 'Unauthorized');
	await connectDB();

	const sample = await CvSample.findByIdAndDelete(params.id).lean();
	if (!sample) return json({ error: 'Sample not found' }, { status: 404 });

	return json({ success: true });
};
