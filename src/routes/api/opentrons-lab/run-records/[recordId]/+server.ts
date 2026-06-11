/**
 * GET /api/opentrons-lab/run-records/:recordId — Get run record with traceability data
 */
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { connectDB, OpentronsRunRecord } from '$lib/server/db';
import { requirePermission } from '$lib/server/permissions';

export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) return json({ error: 'Unauthorized' }, { status: 401 });
	requirePermission(locals.user, 'manufacturing:read');

	await connectDB();
	const record = await OpentronsRunRecord.findById(params.recordId).lean();
	if (!record) return json({ error: 'Not found' }, { status: 404 });

	return json({ data: JSON.parse(JSON.stringify(record)) });
};
