import { requirePermission } from '$lib/server/permissions';
import { connectDB, Spu } from '$lib/server/db';
import type { PageServerLoad } from './$types';

// Minimal SPU Mfg page: just the units, for search + widget access.
export const load: PageServerLoad = async ({ locals }) => {
	requirePermission(locals.user, 'spu:read');
	await connectDB();

	const spus = await Spu.find().sort({ createdAt: -1 }).lean();

	const VALIDATION_KEYS = ['magnetometer', 'spectrophotometer', 'thermocouple'];

	return {
		spus: spus.map((s: any) => {
			const v = s.validation ?? {};
			const validationPassed = VALIDATION_KEYS.filter(
				(k) => v[k]?.status === 'passed' || v[k]?.status === 'overridden'
			).length;
			return {
				id: s._id,
				udi: s.udi,
				deviceId: s.particleLink?.particleDeviceId ?? null,
				barcode: s.barcode ?? null,
				status: s.status ?? 'draft',
				qcStatus: s.qcStatus ?? 'pending',
				owner: s.owner ?? null,
				batchNumber: s.batch?.batchNumber ?? null,
				validationPassed,
				validationTotal: VALIDATION_KEYS.length,
				createdAt: s.createdAt
			};
		})
	};
};
