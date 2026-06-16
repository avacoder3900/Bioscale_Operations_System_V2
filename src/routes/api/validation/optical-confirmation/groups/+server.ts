import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { connectDB, CartridgeGroup, AuditLog, generateId } from '$lib/server/db';
import { requirePermission } from '$lib/server/permissions';

// Search validation groups for the search bar.
export const GET: RequestHandler = async ({ url, locals }) => {
	if (!locals.user) return json({ error: 'Unauthorized' }, { status: 401 });
	requirePermission(locals.user, 'cartridge:read');
	await connectDB();
	const q = (url.searchParams.get('q') ?? '').trim();
	const filter = q ? { name: { $regex: q, $options: 'i' } } : {};
	const groups = await CartridgeGroup.find(filter).select('name description color').sort({ name: 1 }).limit(20).lean();
	return json({ groups: JSON.parse(JSON.stringify(groups)) });
};

// Create a new validation group.
export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) return json({ error: 'Unauthorized' }, { status: 401 });
	requirePermission(locals.user, 'cartridge:write');
	await connectDB();
	const { name, description, color } = await request.json();
	const trimmed = (name ?? '').trim();
	if (!trimmed) return json({ error: 'Group name is required' }, { status: 400 });

	const existing = await CartridgeGroup.findOne({ name: trimmed }).lean();
	if (existing) return json({ group: JSON.parse(JSON.stringify(existing)), created: false });

	const group = await CartridgeGroup.create({
		_id: generateId(),
		name: trimmed,
		description: description ?? '',
		color: color ?? '',
		createdBy: locals.user._id
	});
	await AuditLog.create({
		tableName: 'cartridge_groups', recordId: group._id, action: 'INSERT',
		newData: { name: trimmed }, changedBy: locals.user._id, changedAt: new Date(),
		reason: 'Create optical-confirmation validation group'
	});
	return json({ group: JSON.parse(JSON.stringify(group)), created: true });
};
