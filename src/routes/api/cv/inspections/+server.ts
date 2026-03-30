import { json, error } from '@sveltejs/kit';
import { connectDB } from '$lib/server/db/connection.js';
import { CvInspection } from '$lib/server/db/models/cv-inspection.js';
import { generateId } from '$lib/server/db/utils.js';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ url, locals }) => {
	if (!locals.user) throw error(401, 'Unauthorized');
	await connectDB();

	const filter: Record<string, unknown> = {};
	const projectId = url.searchParams.get('projectId');
	const sampleId = url.searchParams.get('sampleId');
	const status = url.searchParams.get('status');
	const result = url.searchParams.get('result');
	const cartridgeRecordId = url.searchParams.get('cartridgeRecordId');

	if (projectId) filter.projectId = projectId;
	if (sampleId) filter.sampleId = sampleId;
	if (status) filter.status = status;
	if (result) filter.result = result;
	if (cartridgeRecordId) filter.cartridgeRecordId = cartridgeRecordId;

	const limit = Math.min(parseInt(url.searchParams.get('limit') || '50'), 200);
	const skip = parseInt(url.searchParams.get('skip') || '0');

	const [inspections, total] = await Promise.all([
		CvInspection.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
		CvInspection.countDocuments(filter)
	]);

	return json({ data: JSON.parse(JSON.stringify(inspections)), total });
};

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) throw error(401, 'Unauthorized');
	await connectDB();

	try {
		const body = await request.json();
		if (!body.projectId) return json({ error: 'projectId is required' }, { status: 400 });
		if (!body.imageId) return json({ error: 'imageId is required' }, { status: 400 });

		const inspection = await CvInspection.create({
			_id: generateId(),
			sampleId: body.sampleId,
			imageId: body.imageId,
			projectId: body.projectId,
			inspectionType: body.inspectionType,
			cartridgeRecordId: body.cartridgeRecordId,
			phase: body.phase
		});

		return json({ data: JSON.parse(JSON.stringify(inspection)) }, { status: 201 });
	} catch (err: any) {
		return json({ error: err.message }, { status: 500 });
	}
};
