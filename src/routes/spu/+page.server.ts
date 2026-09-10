import { requirePermission } from '$lib/server/permissions';
import { connectDB, Spu } from '$lib/server/db';
import { cycleSummary } from '$lib/server/spu-validation-cycle';
import type { PageServerLoad } from './$types';

// SPU inventory: every unit, for search + list access. Moved here from /spu/mfg (SPU-INV-02).
export const load: PageServerLoad = async ({ locals }) => {
	requirePermission(locals.user, 'spu:read');
	await connectDB();

	// Projection matters: attachments[].content holds inline CSV blobs and
	// assembly.stepRecords[] is large — neither is needed for the list.
	const spus = await Spu.find()
		.select('udi barcode status qcStatus owner location batch particleLink validation validationResetAt createdAt')
		.sort({ createdAt: -1 })
		.lean();

	return {
		spus: spus.map((s: any) => {
			// Only the current validation cycle counts (reset when the unit
			// last entered servicing) — see spu-validation-cycle.ts.
			const cycle = cycleSummary(s);
			return {
				id: s._id,
				udi: s.udi,
				deviceId: s.particleLink?.particleDeviceId ?? null,
				barcode: s.barcode ?? null,
				status: s.status ?? 'draft',
				qcStatus: s.qcStatus ?? 'pending',
				owner: s.owner ?? null,
				location: s.location ?? null,
				batchNumber: s.batch?.batchNumber ?? null,
				validationPassed: cycle.passed,
				validationTotal: cycle.total,
				createdAt: s.createdAt
			};
		})
	};
};
