export const config = { maxDuration: 60 };
import { fail } from '@sveltejs/kit';
import { requirePermission } from '$lib/server/permissions';
import { connectDB, Spu, Batch, ProductionRun, PartDefinition, User, generateId } from '$lib/server/db';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, url }) => {
	requirePermission(locals.user, 'spu:read');
	await connectDB();

	const stateFilter = url.searchParams.get('state');
	const spuQuery: Record<string, any> = {};
	if (stateFilter) spuQuery.status = stateFilter;

	const [spus, batches, activeRuns] = await Promise.all([
		Spu.find(spuQuery).sort({ createdAt: -1 }).lean(),
		Batch.find().sort({ batchNumber: 1 }).lean(),
		ProductionRun.find({ status: { $in: ['planning', 'in_progress', 'paused'] } }).lean()
	]);

	// Build user lookup for createdBy
	const userIds = [...new Set(spus.map((s: any) => s.createdBy).filter(Boolean))];
	const users = userIds.length ? await User.find({ _id: { $in: userIds } }, { username: 1 }).lean() : [];
	const userMap = new Map(users.map((u: any) => [u._id, u.username]));

	// State counts (always over all SPUs, regardless of filter)
	const stateCounts: Record<string, number> = {};
	const allSpus = stateFilter ? await Spu.find({}, { status: 1 }).lean() : spus;
	for (const s of allSpus) {
		const st = (s as any).status || 'draft';
		stateCounts[st] = (stateCounts[st] || 0) + 1;
	}

	// SPU parts — lowest inventory + build capacity (BOM parts only)
	const spuParts = (await PartDefinition.find({
		isActive: true,
		isBom: { $ne: false },
		$or: [{ bomType: 'spu' }, { bomType: { $exists: false } }]
	}).sort({ inventoryCount: 1 }).lean()) as any[];

	const lowestSpuParts = spuParts.slice(0, 5).map((p: any) => ({
		id: p._id,
		partNumber: p.partNumber ?? '',
		name: p.name ?? '',
		inventoryCount: p.inventoryCount ?? 0,
		quantityPerUnit: p.quantityPerUnit ?? 1
	}));

	const spuBuildCapacity = spuParts
		.filter((p: any) => (p.quantityPerUnit ?? 0) > 0 && (p.inventoryCount ?? 0) >= 0)
		.reduce((min: number, p: any) => {
			const canBuild = Math.floor((p.inventoryCount ?? 0) / (p.quantityPerUnit ?? 1));
			return Math.min(min, canBuild);
		}, Infinity);
	const spuBuildCount = spuBuildCapacity === Infinity ? 0 : spuBuildCapacity;

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
			qcStatus: s.qcStatus ?? 'pending',
			qcDocumentUrl: s.qcDocumentUrl ?? null,
			assemblyStatus: s.assemblyStatus ?? 'created'
		})),
		batches: batches.map((b: any) => ({ id: b._id, batchNumber: b.batchNumber ?? '' })),
		lowestSpuParts,
		spuBuildCount,
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
		fieldHints: { batchRecommended: true, ownerRecommended: false }
	};
};

export const actions: Actions = {
	create: async ({ request, locals }) => {
		requirePermission(locals.user, 'spu:write');
		await connectDB();
		const form = await request.formData();
		const serialNumber = form.get('serialNumber')?.toString().trim();
		if (!serialNumber) return fail(400, { error: 'Serial number is required' });

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
	}
};
