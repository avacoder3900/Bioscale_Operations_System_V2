/**
 * GET /api/cv/inspections — list machine verdicts.
 *
 * Filters: projectId, status (running|completed|failed), result (pass|fail),
 * cartridgeRecordId, imageId. Inspections are machine-only rows; human QC
 * truth lives on cartridge_records.photos[].qcLabel and is joined by imageId
 * by review UIs. Inspections are created solely by run-inference / infer —
 * there is no create endpoint here.
 */
import { json, error } from '@sveltejs/kit';
import { connectDB } from '$lib/server/db/connection.js';
import { CvInspection } from '$lib/server/db/models/cv-inspection.js';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ url, locals }) => {
	if (!locals.user) throw error(401, 'Unauthorized');
	await connectDB();

	const filter: Record<string, unknown> = {};
	const projectId = url.searchParams.get('projectId');
	const status = url.searchParams.get('status');
	const result = url.searchParams.get('result');
	const cartridgeRecordId = url.searchParams.get('cartridgeRecordId');
	const imageId = url.searchParams.get('imageId');

	if (projectId) filter.projectId = projectId;
	if (status) filter.status = status;
	if (result) filter.result = result;
	if (cartridgeRecordId) filter.cartridgeRecordId = cartridgeRecordId;
	if (imageId) filter.imageId = imageId;

	const limit = Math.min(parseInt(url.searchParams.get('limit') || '50'), 200);
	const skip = parseInt(url.searchParams.get('skip') || '0');

	const [inspections, total] = await Promise.all([
		CvInspection.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
		CvInspection.countDocuments(filter)
	]);

	return json({ data: JSON.parse(JSON.stringify(inspections)), total });
};
