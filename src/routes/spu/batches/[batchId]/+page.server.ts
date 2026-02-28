import { fail, error } from '@sveltejs/kit';
import { requirePermission } from '$lib/server/permissions';
import { connectDB, Batch, Spu } from '$lib/server/db';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, params }) => {
	requirePermission(locals.user, 'spu:read');
	await connectDB();

	const batch = await Batch.findById(params.batchId).lean();
	if (!batch) throw error(404, 'Batch not found');

	const spus = await Spu.find({ 'batch._id': params.batchId })
		.sort({ createdAt: -1 })
		.lean();

	return {
		batch: {
			id: (batch as any)._id,
			batchNumber: (batch as any).batchNumber ?? '',
			description: (batch as any).description ?? null,
			targetQuantity: (batch as any).targetQuantity ?? null,
			startedAt: (batch as any).startedAt ?? null,
			completedAt: (batch as any).completedAt ?? null,
			createdAt: (batch as any).createdAt
		},
		spus: spus.map((s: any) => ({
			id: s._id,
			udi: s.udi,
			status: s.status ?? 'draft',
			deviceState: s.deviceState ?? '',
			createdAt: s.createdAt
		}))
	};
};
