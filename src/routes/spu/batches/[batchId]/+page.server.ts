import { fail, error } from '@sveltejs/kit';
import { requirePermission } from '$lib/server/permissions';
import { connectDB, Batch, Spu, User } from '$lib/server/db';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, params }) => {
	requirePermission(locals.user, 'spu:read');
	await connectDB();

	const batch = await Batch.findById(params.batchId).lean() as any;
	if (!batch) throw error(404, 'Batch not found');

	const spus = await Spu.find({ 'batch._id': params.batchId })
		.sort({ createdAt: -1 })
		.lean();

	// Look up creator name
	let creatorName = batch.createdByUsername ?? batch.createdBy ?? null;
	if (batch.createdBy && !creatorName) {
		const creator = await User.findById(batch.createdBy).select('username').lean() as any;
		creatorName = creator?.username ?? null;
	}

	// Compute stats from spus
	const spuList = spus.map((s: any) => s as any);
	const stats = {
		total: spuList.length,
		completed: spuList.filter((s) => s.assemblyStatus === 'completed' || s.status === 'assembled').length,
		inProgress: spuList.filter((s) => s.assemblyStatus === 'in_progress').length,
		pending: spuList.filter((s) => !s.assemblyStatus || s.assemblyStatus === 'created').length
	};

	return {
		batch: {
			id: batch._id,
			batchNumber: batch.batchNumber ?? '',
			description: batch.description ?? null,
			targetQuantity: batch.targetQuantity ?? null,
			startedAt: batch.startedAt ?? null,
			completedAt: batch.completedAt ?? null,
			createdAt: batch.createdAt
		},
		stats,
		creatorName,
		spus: spus.map((s: any) => ({
			id: s._id,
			udi: s.udi,
			status: s.status ?? 'draft',
			deviceState: s.deviceState ?? '',
			createdAt: s.createdAt,
			assemblyCompletedAt: s.assembly?.completedAt ?? null
		}))
	};
};

export const actions: Actions = {
	start: async ({ params, locals }) => {
		requirePermission(locals.user, 'spu:write');
		await connectDB();
		const batch = await Batch.findById(params.batchId).lean() as any;
		if (!batch) return fail(404, { error: 'Batch not found' });
		if (batch.startedAt) return fail(400, { error: 'Batch already started' });
		await Batch.updateOne({ _id: params.batchId }, { $set: { startedAt: new Date(), status: 'in_progress' } });
		return { success: true };
	},

	complete: async ({ params, locals }) => {
		requirePermission(locals.user, 'spu:write');
		await connectDB();
		const batch = await Batch.findById(params.batchId).lean() as any;
		if (!batch) return fail(404, { error: 'Batch not found' });
		await Batch.updateOne({ _id: params.batchId }, { $set: { completedAt: new Date(), status: 'completed' } });
		return { success: true };
	}
};
