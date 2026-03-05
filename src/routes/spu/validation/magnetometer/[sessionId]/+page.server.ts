import { error } from '@sveltejs/kit';
import { requirePermission } from '$lib/server/permissions';
import { connectDB, ValidationSession, User, generateId } from '$lib/server/db';
import { getVariable } from '$lib/server/particle';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, params }) => {
	requirePermission(locals.user, 'spu:read');
	await connectDB();

	const session = await ValidationSession.findById(params.sessionId).lean() as any;
	if (!session) error(404, 'Session not found');

	const user = session.userId ? await User.findById(session.userId, { username: 1 }).lean() as any : null;

	return {
		session: {
			id: session._id,
			status: session.status,
			startedAt: session.startedAt?.toISOString() ?? null,
			completedAt: session.completedAt?.toISOString() ?? null,
			barcode: session.barcode ?? null,
			username: user?.username ?? null,
			spuUdi: session.spuUdi ?? null,
			particleDeviceId: session.particleDeviceId ?? null
		},
		result: session.magResults ? {
			id: session._id,
			testType: 'magnetometer',
			rawData: session.rawData ?? null,
			processedData: {
				metrics: session.magResults,
				interpretation: session.overallPassed ? 'All Z values within acceptable range' : 'One or more Z values outside acceptable range',
				failureReasons: session.failureReasons ?? []
			},
			passed: session.overallPassed ?? null,
			notes: null,
			createdAt: session.completedAt?.toISOString() ?? session.createdAt?.toISOString() ?? new Date().toISOString()
		} : null
	};
};

export const actions: Actions = {
	readResults: async ({ locals, params }) => {
		requirePermission(locals.user, 'spu:write');
		await connectDB();

		const session = await ValidationSession.findById(params.sessionId) as any;
		if (!session) return { error: 'Session not found' };
		if (!session.particleDeviceId) return { error: 'No device linked to this session' };

		try {
			const varData = await getVariable(session.particleDeviceId, 'magnet_validation');
			const rawResult = varData.result;
			if (!rawResult || typeof rawResult !== 'string') {
				return { error: 'No magnet_validation data available on device' };
			}

			// Parse the tab-delimited magnet validation result
			const parsed = parseMagValidation(rawResult);

			// Get criteria
			const { Integration } = await import('$lib/server/db');
			const criteria = await Integration.findOne({ type: 'mag_criteria' }).lean() as any;
			const minZ = criteria?.minZ ?? 3900;
			const maxZ = criteria?.maxZ ?? 4500;

			// Evaluate pass/fail per well per channel
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

			await ValidationSession.updateOne(
				{ _id: params.sessionId },
				{
					$set: {
						status: overallPassed ? 'completed' : 'failed',
						completedAt: new Date(),
						rawData: rawResult,
						magResults: parsed,
						overallPassed,
						failureReasons,
						criteriaUsed: { minZ, maxZ }
					}
				}
			);

			return { success: true, overallPassed };
		} catch (err) {
			return { error: `Failed to read device: ${err instanceof Error ? err.message : String(err)}` };
		}
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
		// Match lines starting with a number (well rows)
		const match = line.match(/^(\d+)\t/);
		if (!match) continue;

		const parts = line.split('\t').map(s => s.trim());
		const well = parseInt(parts[0]);
		const nums = parts.slice(1).map(s => {
			const n = parseFloat(s);
			return isNaN(n) ? null : n;
		});

		// Expected: T X Y Z (chA) T X Y Z (chB) T X Y Z (chC) = 12 values
		results.push({
			well,
			chA_T: nums[0] ?? null, chA_X: nums[1] ?? null, chA_Y: nums[2] ?? null, chA_Z: nums[3] ?? null,
			chB_T: nums[4] ?? null, chB_X: nums[5] ?? null, chB_Y: nums[6] ?? null, chB_Z: nums[7] ?? null,
			chC_T: nums[8] ?? null, chC_X: nums[9] ?? null, chC_Y: nums[10] ?? null, chC_Z: nums[11] ?? null
		});
	}

	return results;
}
