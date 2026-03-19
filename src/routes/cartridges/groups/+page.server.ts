import { fail } from '@sveltejs/kit';
import { requirePermission } from '$lib/server/permissions';
import { connectDB, CartridgeGroup, CartridgeRecord, generateId } from '$lib/server/db';
import type { PageServerLoad, Actions } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	requirePermission(locals.user, 'cartridge:read');
	await connectDB();

	const groups = await CartridgeGroup.find().sort({ name: 1 }).lean();

	// Count cartridges per group
	const groupIds = groups.map((g: any) => g._id);
	const counts = groupIds.length
		? await CartridgeRecord.aggregate([
				{ $match: { groupId: { $in: groupIds } } },
				{ $group: { _id: '$groupId', count: { $sum: 1 } } }
			])
		: [];
	const countMap = new Map(counts.map((c: any) => [c._id, c.count]));

	return {
		groups: groups.map((g: any) => ({
			id: g._id,
			name: g.name,
			description: g.description ?? null,
			color: g.color ?? null,
			cartridgeCount: countMap.get(g._id) ?? 0
		}))
	};
};

export const actions: Actions = {
	createGroup: async ({ request, locals }) => {
		requirePermission(locals.user, 'cartridge:write');
		await connectDB();
		const form = await request.formData();
		const name = form.get('name')?.toString().trim();
		if (!name) return fail(400, { error: 'Group name is required' });
		const description = form.get('description')?.toString().trim() || undefined;
		const color = form.get('color')?.toString() || undefined;
		await CartridgeGroup.create({ _id: generateId(), name, description, color });
		return { success: true };
	},

	deleteGroup: async ({ request, locals }) => {
		requirePermission(locals.user, 'cartridge:write');
		await connectDB();
		const form = await request.formData();
		const id = form.get('id')?.toString();
		if (!id) return fail(400, { error: 'Group ID required' });
		const count = await CartridgeRecord.countDocuments({ groupId: id });
		if (count > 0) return fail(400, { error: 'Cannot delete group with cartridges' });
		await CartridgeGroup.deleteOne({ _id: id });
		return { success: true };
	}
};

export const config = { maxDuration: 60 };
