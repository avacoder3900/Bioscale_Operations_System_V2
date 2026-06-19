import { fail } from '@sveltejs/kit';
import { requirePermission } from '$lib/server/permissions';
import { connectDB, Spu, Batch, User, generateId } from '$lib/server/db';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	requirePermission(locals.user, 'spu:read');
	await connectDB();

	const [spus, batches] = await Promise.all([
		Spu.find().sort({ createdAt: -1 }).lean(),
		Batch.find().sort({ batchNumber: 1 }).lean()
	]);

	// Resolve createdBy usernames
	const userIds = [...new Set(spus.map((s: any) => s.createdBy).filter(Boolean))];
	const users = userIds.length
		? await User.find({ _id: { $in: userIds } }, { username: 1 }).lean()
		: [];
	const userMap = new Map(users.map((u: any) => [u._id, u.username]));

	return {
		spus: spus.map((s: any) => ({
			id: s._id,
			udi: s.udi,
			barcode: s.barcode ?? null,
			status: s.status ?? 'draft',
			deviceState: s.deviceState ?? '',
			owner: s.owner ?? null,
			batchNumber: s.batch?.batchNumber ?? null,
			qcStatus: s.qcStatus ?? 'pending',
			validationStatus: s.validation?.status ?? 'pending',
			createdAt: s.createdAt,
			createdByUsername: userMap.get(s.createdBy) ?? null
		})),
		batches: batches.map((b: any) => ({ id: b._id, batchNumber: b.batchNumber ?? '' })),
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
	}
};
