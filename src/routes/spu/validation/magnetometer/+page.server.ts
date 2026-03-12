import { fail, redirect } from '@sveltejs/kit';
import { requirePermission } from '$lib/server/permissions';
import { connectDB, ValidationSession, Spu, Integration, generateId } from '$lib/server/db';
import { getVariable } from '$lib/server/particle';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	requirePermission(locals.user, 'spu:read');
	await connectDB();

	// Get all SPUs with particle links
	const spus = await Spu.find(
		{ 'particleLink.particleDeviceId': { $exists: true, $ne: null } },
		{ udi: 1, 'particleLink.particleDeviceId': 1, status: 1 }
	).sort({ udi: 1 }).lean() as any[];

	// Get criteria
	const criteria = await Integration.findOne({ type: 'mag_criteria' }).lean() as any;

	return {
		spus: spus.map((s: any) => ({
			id: s._id,
			udi: s.udi,
			particleDeviceId: s.particleLink?.particleDeviceId ?? null,
			status: s.status
		})),
		criteria: {
			minZ: criteria?.minZ ?? 3900,
			maxZ: criteria?.maxZ ?? 4500
		}
	};
};

export const actions: Actions = {
	readFromDevice: async ({ request, locals }) => {
		requirePermission(locals.user, 'spu:write');
		await connectDB();

		const form = await request.formData();
		const spuId = form.get('spuId')?.toString();
		if (!spuId) return fail(400, { error: 'Select an SPU' });

		const spu = await Spu.findById(spuId).lean() as any;
		if (!spu?.particleLink?.particleDeviceId) return fail(400, { error: 'SPU has no Particle device linked' });

		// Read the current magnet_validation variable (from a previous run_test)
		try {
			const varData = await getVariable(spu.particleLink.particleDeviceId, 'magnet_validation');
			const rawResult = varData.result;
			if (!rawResult || typeof rawResult !== 'string') {
				return fail(400, { error: 'No magnet_validation data on device. Run a test first.' });
			}

			// Parse
			const parsed = parseMagValidation(rawResult);

			// Get criteria
			const criteria = await Integration.findOne({ type: 'mag_criteria' }).lean() as any;
			const minZ = criteria?.minZ ?? 3900;
			const maxZ = criteria?.maxZ ?? 4500;

			// Evaluate
			const failureReasons: string[] = [];
			for (const well of parsed) {
				for (const ch of ['A', 'B', 'C'] as const) {
					const z = well[`ch${ch}_Z`];
					if (z !== null && (z < minZ || z > maxZ)) {
						failureReasons.push(`Well ${well.well} Ch ${ch}: Z=${z} (range: ${minZ}-${maxZ})`);
					}
				}
			}

			const overallPassed = failureReasons.length === 0;

			const sessionId = generateId();
			await ValidationSession.create({
				_id: sessionId,
				type: 'mag',
				status: overallPassed ? 'completed' : 'failed',
				startedAt: new Date(),
				completedAt: new Date(),
				userId: locals.user!._id,
				spuUdi: spu.udi,
				spuId: spu._id,
				particleDeviceId: spu.particleLink.particleDeviceId,
				rawData: rawResult,
				magResults: parsed,
				overallPassed,
				failureReasons,
				criteriaUsed: { minZ, maxZ }
			});

			// Update SPU validation record
			const magStatus = overallPassed ? 'passed' : 'failed';
			await Spu.updateOne({ _id: spuId }, {
				$set: {
					'validation.magnetometer': {
						status: magStatus,
						sessionId,
						completedAt: new Date(),
						rawData: rawResult,
						results: parsed,
						failureReasons,
						criteriaUsed: { minZ, maxZ }
					},
					qcStatus: magStatus
				}
			});

			redirect(303, `/spu/validation/magnetometer/${sessionId}`);
		} catch (err: any) {
			if (err?.status === 303) throw err; // re-throw redirect
			return fail(400, { error: `Failed: ${err instanceof Error ? err.message : String(err)}` });
		}
	},

	updateCriteria: async ({ request, locals }) => {
		requirePermission(locals.user, 'spu:write');
		await connectDB();

		const form = await request.formData();
		const minZ = parseFloat(form.get('minZ')?.toString() ?? '3900');
		const maxZ = parseFloat(form.get('maxZ')?.toString() ?? '4500');

		if (isNaN(minZ) || isNaN(maxZ) || minZ >= maxZ) {
			return fail(400, { error: 'Invalid criteria range' });
		}

		await Integration.updateOne(
			{ type: 'mag_criteria' },
			{ $set: { type: 'mag_criteria', minZ, maxZ, updatedAt: new Date() } },
			{ upsert: true }
		);

		return { criteriaUpdated: true };
	}
};

interface MagWellResult {
	well: number;
	chA_T: number | null; chA_X: number | null; chA_Y: number | null; chA_Z: number | null;
	chB_T: number | null; chB_X: number | null; chB_Y: number | null; chB_Z: number | null;
	chC_T: number | null; chC_X: number | null; chC_Y: number | null; chC_Z: number | null;
}

function parseMagValidation(raw: string): MagWellResult[] {
	const lines = raw.split('\n').map(l => l.trim()).filter(l => l.length > 0);
	const results: MagWellResult[] = [];

	for (const line of lines) {
		const match = line.match(/^(\d+)\t/);
		if (!match) continue;

		const parts = line.split('\t').map(s => s.trim());
		const well = parseInt(parts[0]);
		const nums = parts.slice(1).map(s => {
			const n = parseFloat(s);
			return isNaN(n) ? null : n;
		});

		results.push({
			well,
			chA_T: nums[0] ?? null, chA_X: nums[1] ?? null, chA_Y: nums[2] ?? null, chA_Z: nums[3] ?? null,
			chB_T: nums[4] ?? null, chB_X: nums[5] ?? null, chB_Y: nums[6] ?? null, chB_Z: nums[7] ?? null,
			chC_T: nums[8] ?? null, chC_X: nums[9] ?? null, chC_Y: nums[10] ?? null, chC_Z: nums[11] ?? null
		});
	}

	return results;
}
