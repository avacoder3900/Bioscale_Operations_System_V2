import { json } from '@sveltejs/kit';
import { connectDB, InventoryTransaction } from '$lib/server/db';
import { requirePermission } from '$lib/server/permissions';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.user) return json({ error: 'Unauthorized' }, { status: 401 });
	requirePermission(locals.user, 'inventory:read');
	await connectDB();
	const transactions = await InventoryTransaction.find().sort({ createdAt: -1 }).limit(100).lean();
	return json({ success: true, transactions });
};
