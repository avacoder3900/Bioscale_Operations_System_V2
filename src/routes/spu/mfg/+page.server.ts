import { requirePermission } from '$lib/server/permissions';
import { connectDB, Spu } from '$lib/server/db';
import type { PageServerLoad } from './$types';

// Minimal SPU Mfg page: just the units, for search + widget access.
export const load: PageServerLoad = async ({ locals }) => {
	requirePermission(locals.user, 'spu:read');
	await connectDB();

	const spus = await Spu.find().sort({ createdAt: -1 }).lean();

	return {
		spus: spus.map((s: any) => ({
			id: s._id,
			udi: s.udi,
			barcode: s.barcode ?? null,
			status: s.status ?? 'draft',
			qcStatus: s.qcStatus ?? 'pending',
			owner: s.owner ?? null,
			batchNumber: s.batch?.batchNumber ?? null,
			createdAt: s.createdAt
		}))
	};
};
