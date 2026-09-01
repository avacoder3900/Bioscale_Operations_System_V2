import { requirePermission } from '$lib/server/permissions';
import { connectDB, Spu } from '$lib/server/db';
import type { PageServerLoad } from './$types';

// SPU inventory: every unit, for search + list access. Moved here from /spu/mfg (SPU-INV-02).
export const load: PageServerLoad = async ({ locals }) => {
	requirePermission(locals.user, 'spu:read');
	await connectDB();

	// Projection matters: attachments[].content holds inline CSV blobs and
	// assembly.stepRecords[] is large — neither is needed for the list.
	const spus = await Spu.find()
		.select('udi barcode status qcStatus owner batch particleLink validation validationResetAt createdAt')
		.sort({ createdAt: -1 })
		.lean();

	const VALIDATION_KEYS = ['magnetometer', 'spectrophotometer', 'thermocouple'];

	return {
		spus: spus.map((s: any) => {
			const v = s.validation ?? {};
			// Validations completed before a service return don't count toward the current cycle.
			const reset = s.validationResetAt ? new Date(s.validationResetAt).getTime() : null;
			const validationPassed = VALIDATION_KEYS.filter((k) => {
				const r = v[k];
				const passed = r?.status === 'passed' || r?.status === 'overridden';
				if (!passed) return false;
				if (reset === null) return true;
				return r.completedAt && new Date(r.completedAt).getTime() >= reset;
			}).length;
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
