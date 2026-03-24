import { redirect } from '@sveltejs/kit';
import { connectDB, LabCartridge, CartridgeGroup } from '$lib/server/db';
import { requirePermission } from '$lib/server/permissions';
import type { PageServerLoad, Actions } from './$types';

export const load: PageServerLoad = async ({ locals, url }) => {
	if (!locals.user) redirect(302, '/login');
	requirePermission(locals.user, 'cartridge:read');

	await connectDB();

	const page = parseInt(url.searchParams.get('page') || '1');
	const limit = 50;
	const statusFilter = url.searchParams.get('status') || null;
	const groupFilter = url.searchParams.get('group') || null;

	const filter: any = {};
	if (statusFilter) filter.status = statusFilter;
	if (groupFilter) filter.groupId = groupFilter;

	const [cartridges, total, groups] = await Promise.all([
		LabCartridge.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
		LabCartridge.countDocuments(filter),
		CartridgeGroup.find().sort({ name: 1 }).lean()
	]);

	return {
		cartridges: cartridges.map((c: any) => ({
			id: c._id,
			barcode: c.barcode,
			serialNumber: c.serialNumber,
			lotNumber: c.lotNumber,
			cartridgeType: c.cartridgeType,
			status: c.status,
			groupId: c.groupId,
			manufacturer: c.manufacturer,
			expirationDate: c.expirationDate,
			receivedDate: c.receivedDate,
			openedDate: c.openedDate,
			usesRemaining: c.usesRemaining,
			totalUses: c.totalUses,
			storageLocation: c.storageLocation,
			storageConditions: c.storageConditions,
			notes: c.notes,
			isActive: c.isActive,
			usageLogCount: c.usageLog?.length ?? 0,
			createdAt: c.createdAt,
			updatedAt: c.updatedAt
		})),
		groups: groups.map((g: any) => ({
			id: g._id,
			name: g.name,
			description: g.description,
			color: g.color
		})),
		pagination: { page, limit, total, hasNext: page * limit < total, hasPrev: page > 1 },
		filters: { status: statusFilter, group: groupFilter }
	};
};

export const actions: Actions = {
	create: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		requirePermission(locals.user, 'cartridge:write');
		await connectDB();

		const data = await request.formData();
		await LabCartridge.create({
			barcode: data.get('barcode') as string || undefined,
			serialNumber: data.get('serialNumber') as string || undefined,
			lotNumber: data.get('lotNumber') as string || undefined,
			cartridgeType: data.get('cartridgeType') as string || 'measurement',
			status: 'available',
			groupId: data.get('groupId') as string || undefined,
			manufacturer: data.get('manufacturer') as string || undefined,
			expirationDate: data.get('expirationDate') ? new Date(data.get('expirationDate') as string) : undefined,
			receivedDate: new Date(),
			usesRemaining: data.get('totalUses') ? parseInt(data.get('totalUses') as string) : undefined,
			totalUses: data.get('totalUses') ? parseInt(data.get('totalUses') as string) : undefined,
			storageLocation: data.get('storageLocation') as string || undefined,
			storageConditions: data.get('storageConditions') as string || undefined,
			notes: data.get('notes') as string || undefined,
			isActive: true,
			createdBy: locals.user._id,
			usageLog: [{
				action: 'registered',
				performedBy: { _id: locals.user._id, username: locals.user.username },
				performedAt: new Date()
			}]
		});

		return { success: true };
	},

	updateStatus: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		requirePermission(locals.user, 'cartridge:write');
		await connectDB();

		const data = await request.formData();
		const cartridgeId = data.get('cartridgeId') as string;
		const newStatus = data.get('status') as string;

		const cart = await LabCartridge.findById(cartridgeId);
		if (!cart) return { success: false, error: 'Not found' };

		const oldStatus = cart.status;
		cart.status = newStatus as any;
		cart.usageLog.push({
			action: 'status_changed',
			previousValue: oldStatus,
			newValue: newStatus,
			performedBy: { _id: locals.user._id, username: locals.user.username },
			performedAt: new Date()
		} as any);
		await cart.save();

		return { success: true };
	},

	changeGroup: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		requirePermission(locals.user, 'cartridge:write');
		await connectDB();

		const data = await request.formData();
		const cartridgeId = data.get('cartridgeId') as string;
		const newGroupId = data.get('groupId') as string;

		const cart = await LabCartridge.findById(cartridgeId);
		if (!cart) return { success: false, error: 'Not found' };

		const oldGroup = cart.groupId;
		cart.groupId = newGroupId;
		cart.usageLog.push({
			action: 'group_changed',
			previousValue: oldGroup,
			newValue: newGroupId,
			performedBy: { _id: locals.user._id, username: locals.user.username },
			performedAt: new Date()
		} as any);
		await cart.save();

		return { success: true };
	},

	createGroup: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		requirePermission(locals.user, 'cartridge:write');
		await connectDB();

		const data = await request.formData();
		await CartridgeGroup.create({
			name: data.get('name') as string,
			description: data.get('description') as string || undefined,
			color: data.get('color') as string || undefined,
			createdBy: locals.user._id
		});

		return { success: true };
	}
};

export const config = { maxDuration: 60 };
