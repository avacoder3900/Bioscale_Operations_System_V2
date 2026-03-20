import { fail } from '@sveltejs/kit';
import { requirePermission } from '$lib/server/permissions';
import { connectDB, Batch, Spu, generateId } from '$lib/server/db';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	requirePermission(locals.user, 'spu:read');
	await connectDB();

	const batches = await Batch.find().sort({ createdAt: -1 }).lean();

	// Count SPUs per batch
	const batchIds = batches.map((b: any) => b._id);
	const spuCounts = await Spu.aggregate([
		{ $match: { 'batch._id': { $in: batchIds } } },
		{ $group: { _id: '$batch._id', count: { $sum: 1 } } }
	]);
	const countMap = new Map(spuCounts.map((c: any) => [c._id, c.count]));

	return {
		batches: batches.map((b: any) => ({
			id: b._id,
			batchNumber: b.batchNumber ?? '',
			description: b.description ?? null,
			targetQuantity: b.targetQuantity ?? null,
			spuCount: countMap.get(b._id) ?? 0,
			startedAt: b.startedAt ?? null,
			completedAt: b.completedAt ?? null,
			createdAt: b.createdAt
		}))
	};
};

export const actions: Actions = {
	create: async ({ request, locals }) => {
		requirePermission(locals.user, 'spu:write');
		await connectDB();
		const form = await request.formData();
		const batchNumber = form.get('batchNumber')?.toString().trim();
		if (!batchNumber) return fail(400, { error: 'Batch number required' });

		const existing = await Batch.findOne({ batchNumber });
		if (existing) return fail(400, { error: 'Batch number already exists' });

		await Batch.create({
			_id: generateId(),
			batchNumber,
			description: form.get('description')?.toString() || undefined,
			targetQuantity: form.get('targetQuantity') ? Number(form.get('targetQuantity')) : undefined,
			createdBy: locals.user!._id
		});
		return { success: true };
	},

	update: async ({ request, locals }) => {
		requirePermission(locals.user, 'spu:write');
		await connectDB();
		const form = await request.formData();
		const batchId = form.get('batchId')?.toString();
		if (!batchId) return fail(400, { error: 'Batch ID required' });

		const updates: Record<string, any> = {};
		if (form.get('description') !== null) updates.description = form.get('description')?.toString() || undefined;
		if (form.get('targetQuantity')) updates.targetQuantity = Number(form.get('targetQuantity'));

		await Batch.updateOne({ _id: batchId }, { $set: updates });
		return { success: true };
	},

	start: async ({ request, locals }) => {
		requirePermission(locals.user, 'spu:write');
		await connectDB();
		const form = await request.formData();
		const batchId = form.get('batchId')?.toString();
		if (!batchId) return fail(400, { error: 'Batch ID required' });
		await Batch.updateOne({ _id: batchId }, { $set: { startedAt: new Date() } });
		return { success: true };
	},

	complete: async ({ request, locals }) => {
		requirePermission(locals.user, 'spu:write');
		await connectDB();
		const form = await request.formData();
		const batchId = form.get('batchId')?.toString();
		if (!batchId) return fail(400, { error: 'Batch ID required' });
		await Batch.updateOne({ _id: batchId }, { $set: { completedAt: new Date() } });
		return { success: true };
	}
};
