import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireAgentApiKey } from '$lib/server/api-auth';
import { connectDB } from '$lib/server/db';
import mongoose from 'mongoose';

export const POST: RequestHandler = async ({ request }) => {
	requireAgentApiKey(request);
	await connectDB();

	const body = await request.json();
	const { alertId } = body;

	if (!alertId) {
		return json({ error: 'alertId is required' }, { status: 400 });
	}

	const col = mongoose.connection.db!.collection('temperature_alerts');
	const update = {
		$set: { acknowledged: true, acknowledgedAt: new Date() }
	};

	// Try string ID first, then ObjectId
	let result = await col.updateOne({ _id: alertId as any }, update);
	if (result.matchedCount === 0) {
		try {
			result = await col.updateOne(
				{ _id: new mongoose.Types.ObjectId(alertId) as any },
				update
			);
		} catch { /* not a valid ObjectId */ }
	}

	if (result.matchedCount === 0) {
		return json({ error: 'Alert not found' }, { status: 404 });
	}

	return json({ success: true });
};
