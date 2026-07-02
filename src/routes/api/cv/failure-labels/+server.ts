import { json, error } from '@sveltejs/kit';
import { connectDB } from '$lib/server/db/connection.js';
import { FailureLabel } from '$lib/server/db/models/failure-label.js';
import { requirePermission } from '$lib/server/permissions';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.user) throw error(401, 'Unauthorized');
	await connectDB();

	const labels = await FailureLabel.find().sort({ text: 1 }).lean();
	return json({ data: JSON.parse(JSON.stringify(labels)) });
};

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) throw error(401, 'Unauthorized');
	requirePermission(locals.user, 'manufacturing:read');
	await connectDB();

	const body = await request.json();
	const text = (body.text as string)?.trim();
	if (!text) return json({ error: 'text is required' }, { status: 400 });

	// Case-insensitive: if a matching label already exists, return it instead
	// of erroring or creating a duplicate.
	const existing = await FailureLabel.findOne({ text }).collation({ locale: 'en', strength: 2 }).lean();
	if (existing) return json({ data: JSON.parse(JSON.stringify(existing)) });

	try {
		const created = await FailureLabel.create({
			text,
			createdBy: { _id: locals.user._id, username: locals.user.username },
			createdAt: new Date()
		});
		return json({ data: JSON.parse(JSON.stringify(created.toObject())) });
	} catch (err: any) {
		// Race: another request created the same (case-insensitive) text first.
		if (err?.code === 11000) {
			const race = await FailureLabel.findOne({ text }).collation({ locale: 'en', strength: 2 }).lean();
			if (race) return json({ data: JSON.parse(JSON.stringify(race)) });
		}
		throw err;
	}
};
