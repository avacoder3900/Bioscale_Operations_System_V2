import { redirect, fail } from '@sveltejs/kit';
import { requirePermission } from '$lib/server/permissions';
import { connectDB, CartridgeRecord, AssayDefinition, Customer, ShippingLot, generateId, AuditLog } from '$lib/server/db';
import type { PageServerLoad, Actions } from './$types';

const PAGE_SIZE = 50;

export const load: PageServerLoad = async ({ locals, url }) => {
	if (!locals.user) redirect(302, '/login');
	requirePermission(locals.user, 'cartridge:read');
	await connectDB();

	const page = Math.max(1, Number(url.searchParams.get('page') ?? 1));
	const search = url.searchParams.get('search') ?? '';
	const assayTypeId = url.searchParams.get('assayTypeId') ?? '';
	const lifecycleStage = url.searchParams.get('lifecycleStage') ?? '';
	const sortBy = url.searchParams.get('sortBy') ?? 'createdAt';
	const sortDir = url.searchParams.get('sortDir') ?? 'desc';

	const filter: Record<string, any> = {
		status: { $in: ['sealed', 'cured', 'stored', 'released'] }
	};
	if (assayTypeId) filter['reagentFilling.assayType._id'] = assayTypeId;
	if (lifecycleStage) filter.status = lifecycleStage;
	if (search) filter._id = { $regex: search, $options: 'i' };

	const sortField = sortBy === 'createdAt' ? 'createdAt' : sortBy;
	const sortOrder = sortDir === 'asc' ? 1 : -1;

	const [rawCartridges, total, assayTypes, customers, lots] = await Promise.all([
		CartridgeRecord.find(filter)
			.sort({ [sortField]: sortOrder })
			.skip((page - 1) * PAGE_SIZE)
			.limit(PAGE_SIZE)
			.lean(),
		CartridgeRecord.countDocuments(filter),
		AssayDefinition.find({ isActive: true }, { _id: 1, name: 1 }).lean(),
		Customer.find({ status: 'active' }, { _id: 1, name: 1 }).lean(),
		ShippingLot.find({ status: { $in: ['open', 'released'] } }).sort({ createdAt: -1 }).lean()
	]);

	return {
		cartridges: (rawCartridges as any[]).map((c: any) => ({
			cartridgeId: c._id,
			currentLifecycleStage: c.status ?? 'unknown',
			assayTypeId: c.reagentFilling?.assayType?._id ?? null,
			assayTypeName: c.reagentFilling?.assayType?.name ?? null,
			reagentRunId: c.reagentFilling?.runId ?? null,
			filledAt: c.reagentFilling?.fillDate ?? null,
			inspectionStatus: c.reagentInspection?.status ?? null,
			topSealBatchId: c.topSeal?.batchId ?? null,
			shippingLotId: c.shipping?.packageId ?? null,
			createdAt: c.createdAt
		})),
		total,
		pageNum: page,
		pageSize: PAGE_SIZE,
		assayTypes: (assayTypes as any[]).map((a: any) => ({ id: a._id, name: a.name })),
		customers: (customers as any[]).map((c: any) => ({ id: c._id, name: c.name })),
		lots: (lots as any[]).map((l: any) => ({
			id: l._id,
			assayTypeId: l.assayType?._id ?? null,
			customerId: l.customer?._id ?? null,
			status: l.status ?? 'open',
			cartridgeCount: l.cartridgeCount ?? 0,
			createdAt: l.createdAt
		})),
		filters: { search, assayTypeId, lifecycleStage, sortBy, sortDir }
	};
};

export const actions: Actions = {
	createLot: async ({ request, locals }) => {
		requirePermission(locals.user, 'cartridge:write');
		await connectDB();
		const form = await request.formData();
		const assayTypeId = form.get('assayTypeId')?.toString();
		const customerId = form.get('customerId')?.toString();

		let assayRef = null;
		if (assayTypeId) {
			const assay = await AssayDefinition.findById(assayTypeId, { name: 1 }).lean() as any;
			if (assay) assayRef = { _id: assay._id, name: assay.name };
		}
		let customerRef = null;
		if (customerId) {
			const customer = await Customer.findById(customerId, { name: 1 }).lean() as any;
			if (customer) customerRef = { _id: customer._id, name: customer.name };
		}

		const lot = await ShippingLot.create({
			_id: generateId(),
			assayType: assayRef,
			customer: customerRef,
			status: 'open',
			cartridgeCount: 0
		});
		await AuditLog.create({
			_id: generateId(),
			tableName: 'shipping_lots',
			recordId: lot._id,
			action: 'INSERT',
			changedBy: locals.user?.username ?? locals.user?._id,
			changedAt: new Date()
		});

		return { success: true, action: 'createLot', lotId: lot._id };
	},

	addToLot: async ({ request, locals }) => {
		requirePermission(locals.user, 'cartridge:write');
		await connectDB();
		const form = await request.formData();
		const lotId = form.get('lotId')?.toString();
		const cartridgeIds = form.getAll('cartridgeId').map((id) => id.toString());
		if (!lotId || !cartridgeIds.length) return fail(400, { error: 'Lot ID and cartridges required' });

		await ShippingLot.updateOne(
			{ _id: lotId },
			{ $inc: { cartridgeCount: cartridgeIds.length } }
		);
		await AuditLog.create({
			_id: generateId(),
			tableName: 'shipping_lots',
			recordId: lotId,
			action: 'UPDATE',
			changedBy: locals.user?.username ?? locals.user?._id,
			changedAt: new Date()
		});

		return { success: true, message: `${cartridgeIds.length} cartridges added to lot` };
	}
};

export const config = { maxDuration: 60 };
