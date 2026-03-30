import { json } from '@sveltejs/kit';
import { connectDB, BomItem } from '$lib/server/db';
import { requirePermission } from '$lib/server/permissions';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ url, locals }) => {
	if (!locals.user) return json({ error: 'Unauthorized' }, { status: 401 });
	requirePermission(locals.user, 'inventory:read');
	await connectDB();
	const q = url.searchParams.get('q') || '';
	const results = await BomItem.find({
		$or: [
			{ name: { $regex: q, $options: 'i' } },
			{ partNumber: { $regex: q, $options: 'i' } }
		]
	}).limit(50).lean();
	return json({ success: true, results });
};
