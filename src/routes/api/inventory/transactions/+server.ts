import { json } from '@sveltejs/kit';
import { connectDB, InventoryTransaction } from '$lib/server/db';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async () => {
	await connectDB();
	const transactions = await InventoryTransaction.find().sort({ createdAt: -1 }).limit(100).lean();
	return json({ success: true, transactions });
};
