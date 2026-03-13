import { fail } from '@sveltejs/kit';
import { requirePermission } from '$lib/server/permissions';
import {
	connectDB, Spu, Batch, BomItem, ProductionRun, Customer, User, AuditLog, generateId
} from '$lib/server/db';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, url }) => {
	requirePermission(locals.user, 'spu:read');
	await connectDB();

	const stateFilter = url.searchParams.get('state');

	const spuQuery: Record<string, any> = {};
	if (stateFilter) spuQuery.status = stateFilter;

	const [spus, batches, bomItems, activeRuns, customers] = await Promise.all([
		Spu.find(spuQuery).sort({ createdAt: -1 }).lean(),
		Batch.find().sort({ batchNumber: 1 }).lean(),
		BomItem.find({ isActive: true }).lean(),
		ProductionRun.find({ status: { $in: ['planning', 'in_progress', 'paused'] } }).lean(),
		Customer.find({ status: 'active' }).lean()
	]);

	// Build user lookup for createdBy
	const userIds = [...new Set(spus.map((s: any) => s.createdBy).filter(Boolean))];
	const users = userIds.length ? await User.find({ _id: { $in: userIds } }, { username: 1 }).lean() : [];
	const userMap = new Map(users.map((u: any) => [u._id, u.username]));

	// State counts
	const stateCounts: Record<string, number> = {};
	const allSpus = stateFilter ? await Spu.find({}, { status: 1 }).lean() : spus;
	for (const s of allSpus) {
		const st = (s as any).status || 'draft';
		stateCounts[st] = (stateCounts[st] || 0) + 1;
	}

	// BOM summary
	const activeItems = bomItems.filter((b: any) => b.isActive);
	const totalCost = activeItems.reduce((sum: number, b: any) => sum + (Number(b.unitCost) || 0), 0);
	const now = new Date();
	const thirtyDays = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
	const expiringItems = activeItems.filter(
		(b: any) => b.expirationDate && new Date(b.expirationDate) <= thirtyDays
	);

	return {
		spus: spus.map((s: any) => ({
			id: s._id,
			udi: s.udi,
			barcode: s.barcode ?? null,
			status: s.status ?? 'draft',
			deviceState: s.deviceState ?? '',
			owner: s.owner ?? null,
			ownerNotes: s.ownerNotes ?? null,
			batchId: s.batch?._id ?? null,
			batchNumber: s.batch?.batchNumber ?? null,
			createdAt: s.createdAt,
			createdByUsername: userMap.get(s.createdBy) ?? null,
			assignmentType: s.assignment?.type ?? null,
			assignmentCustomerId: s.assignment?.customer?._id ?? null,
			customerName: s.assignment?.customer?.name ?? null,
			qcStatus: s.qcStatus ?? 'pending',
			qcDocumentUrl: s.qcDocumentUrl ?? null,
			assemblyStatus: s.assemblyStatus ?? 'created'
		})),
		batches: batches.map((b: any) => ({ id: b._id, batchNumber: b.batchNumber ?? '' })),
		bomSummary: {
			totalItems: bomItems.length,
			activeItems: activeItems.length,
			totalCost: totalCost.toFixed(2),
			expiringWithin30Days: expiringItems.length,
			lastSyncAt: null,
			lastSyncStatus: null,
			lastSyncError: null
		},
		expiringItems: expiringItems.map((b: any) => ({
			partNumber: b.partNumber ?? '',
			name: b.name ?? '',
			expirationDate: b.expirationDate
		})),
		syncErrorDetail: null as { message: string; code?: string } | null,
		costBreakdown: null as {
			materialSubtotal: number;
			laborSubtotal: number;
			lineItems: { partName: string; materialCost: number; laborCost: number }[];
		} | null,
		activeRuns: activeRuns.map((r: any) => ({
			id: r._id,
			runNumber: r.runNumber ?? '',
			status: r.status,
			quantity: r.quantity ?? 0,
			workInstructionId: r.workInstructionId ?? '',
			workInstructionTitle: '',
			completedUnits: (r.units ?? []).filter((u: any) => u.status === 'completed').length
		})),
		stateCounts,
		stateFilter,
		fieldHints: { batchRecommended: true, ownerRecommended: false },
		fleetSummary: (() => {
			const spuList = spus.map((s: any) => ({
				id: s._id, udi: s.udi, status: s.status ?? 'draft',
				deviceState: s.deviceState ?? '', owner: s.owner ?? null,
				ownerNotes: s.ownerNotes ?? null, batchId: s.batch?._id ?? null,
				createdAt: s.createdAt ?? null, updatedAt: s.updatedAt ?? null,
				finalizedAt: s.finalizedAt ?? null, qcStatus: s.qcStatus ?? 'pending',
				qcDocumentUrl: s.qcDocumentUrl ?? null, assemblyStatus: s.assemblyStatus ?? 'created',
				assignmentType: s.assignment?.type ?? null,
				assignmentCustomerId: s.assignment?.customer?._id ?? null
			}));
			const rnd = spuList.filter((s) => s.assignmentType === 'rnd');
			const manufacturing = spuList.filter((s) => s.assignmentType === 'manufacturing');
			const unassigned = spuList.filter((s) => !s.assignmentType);
			const customerGroups = customers
				.map((c: any) => ({
					customer: { id: c._id, name: c.name ?? '', customerType: c.customerType ?? '' },
					spus: spuList.filter((s) => s.assignmentCustomerId === c._id)
				}))
				.filter((g) => g.spus.length > 0);
			return { rnd, manufacturing, customers: customerGroups, unassigned };
		})(),
		activeCustomers: customers.map((c: any) => ({
			id: c._id,
			name: c.name ?? '',
			customerType: c.customerType ?? ''
		}))
	};
};

export const actions: Actions = {
	create: async ({ request, locals }) => {
		requirePermission(locals.user, 'spu:write');
		await connectDB();
		const form = await request.formData();
		const serialNumber = form.get('serialNumber')?.toString().trim();
		if (!serialNumber) return fail(400, { error: 'Serial number is required' });

		// Generate UDI from serial number
		const udi = `SPU-${serialNumber}`;
		const existing = await Spu.findOne({ udi });
		if (existing) return fail(400, { error: 'UDI already exists' });

		const batchId = form.get('batchId')?.toString() || undefined;
		let batchRef;
		if (batchId) {
			const batch = await Batch.findById(batchId).lean();
			if (batch) batchRef = { _id: (batch as any)._id, batchNumber: (batch as any).batchNumber };
		}

		const barcode = form.get('barcode')?.toString().trim() || undefined;
		await Spu.create({
			_id: generateId(),
			udi,
			barcode,
			status: 'draft',
			assemblyStatus: 'created',
			qcStatus: 'pending',
			batch: batchRef,
			createdBy: locals.user!._id
		});

		return { success: true };
	},

	register: async ({ request, locals }) => {
		requirePermission(locals.user, 'spu:write');
		await connectDB();
		const form = await request.formData();
		const udi = form.get('udi')?.toString().trim();
		if (!udi) return fail(400, { error: 'UDI is required' });

		const existing = await Spu.findOne({ udi });
		if (existing) return fail(400, { error: 'UDI already exists' });

		const batchId = form.get('batchId')?.toString() || undefined;
		let batchRef;
		if (batchId) {
			const batch = await Batch.findById(batchId).lean();
			if (batch) batchRef = { _id: (batch as any)._id, batchNumber: (batch as any).batchNumber };
		}

		const spuId = generateId();
		const barcode = form.get('barcode')?.toString().trim() || undefined;
		await Spu.create({
			_id: spuId,
			udi,
			barcode,
			status: 'draft',
			deviceState: form.get('deviceState')?.toString() || undefined,
			owner: form.get('owner')?.toString() || undefined,
			ownerNotes: form.get('ownerNotes')?.toString() || undefined,
			assemblyStatus: 'created',
			qcStatus: 'pending',
			batch: batchRef,
			createdBy: locals.user!._id
		});

		return { success: true, spuId };
	},

	updateState: async ({ request, locals }) => {
		requirePermission(locals.user, 'spu:write');
		await connectDB();
		const form = await request.formData();
		const spuId = form.get('spuId')?.toString();
		const deviceState = form.get('deviceState')?.toString();
		if (!spuId || !deviceState) return fail(400, { error: 'SPU ID and state required' });

		const spu = await Spu.findById(spuId);
		if (!spu) return fail(400, { error: 'SPU not found' });
		if ((spu as any).finalizedAt) return fail(400, { error: 'SPU is finalized and cannot be modified' });

		const updates: Record<string, any> = { deviceState };
		if (form.get('owner')) updates.owner = form.get('owner')!.toString();
		if (form.get('ownerNotes')) updates.ownerNotes = form.get('ownerNotes')!.toString();

		await Spu.updateOne({ _id: spuId }, { $set: updates });
		return { success: true };
	},

	bulkUpdateState: async ({ request, locals }) => {
		requirePermission(locals.user, 'spu:write');
		await connectDB();
		const form = await request.formData();
		const spuIds = form.get('spuIds')?.toString().split(',').map((s) => s.trim()).filter(Boolean);
		const deviceState = form.get('deviceState')?.toString();
		if (!spuIds?.length || !deviceState) return fail(400, { error: 'SPU IDs and state required' });

		const result = await Spu.updateMany(
			{ _id: { $in: spuIds }, finalizedAt: null },
			{ $set: { deviceState } }
		);
		return { success: true, updatedCount: result.modifiedCount };
	},

	assignSpu: async ({ request, locals }) => {
		requirePermission(locals.user, 'spu:write');
		await connectDB();
		const form = await request.formData();
		const spuId = form.get('spuId')?.toString();
		const assignmentType = form.get('assignmentType')?.toString();
		if (!spuId || !assignmentType) return fail(400, { assignError: 'SPU ID and type required' });

		const assignment: Record<string, any> = {
			type: assignmentType,
			assignedAt: new Date(),
			assignedBy: { _id: locals.user!._id, username: locals.user!.username }
		};

		if (assignmentType === 'customer') {
			const customerId = form.get('customerId')?.toString();
			if (customerId) {
				const customer = await Customer.findById(customerId).lean();
				if (customer) assignment.customer = { _id: (customer as any)._id, name: (customer as any).name };
			}
		}

		await Spu.updateOne({ _id: spuId }, { $set: { assignment, status: 'assigned' } });
		return { assignSuccess: true };
	},

	retrySync: async ({ locals }) => {
		requirePermission(locals.user, 'inventory:write');
		// Box sync would go here — placeholder
		return { syncSuccess: true, syncMessage: 'Sync not configured' };
	},

	updateStatus: async ({ request, locals }) => {
		requirePermission(locals.user, 'spu:write');
		await connectDB();
		const form = await request.formData();
		const spuId = form.get('spuId')?.toString();
		const newStatus = form.get('status')?.toString();
		if (!spuId || !newStatus) return fail(400, { error: 'SPU ID and status required' });

		const validStatuses = ['draft', 'assembling', 'assembled', 'validating', 'validated', 'assigned', 'deployed', 'servicing', 'retired', 'voided'];
		if (!validStatuses.includes(newStatus)) return fail(400, { error: 'Invalid status' });

		const spu = await Spu.findById(spuId);
		if (!spu) return fail(404, { error: 'SPU not found' });
		if ((spu as any).finalizedAt) return fail(400, { error: 'SPU is finalized' });

		await Spu.updateOne({ _id: spuId }, { $set: { status: newStatus } });

		// Audit log
		await AuditLog.create({
			_id: generateId(),
			tableName: 'spus',
			recordId: spuId,
			action: 'UPDATE',
			oldData: { status: (spu as any).status },
			newData: { status: newStatus },
			changedBy: locals.user!.username ?? locals.user!._id
		});

		return { statusUpdateSuccess: true, updatedStatus: newStatus };
	}
};
