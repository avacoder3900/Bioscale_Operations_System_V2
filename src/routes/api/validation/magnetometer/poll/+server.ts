import { json } from '@sveltejs/kit';

export const config = {
	maxDuration: 60
};
import { connectDB, ValidationSession, Integration, generateId } from '$lib/server/db';
import { getVariable } from '$lib/server/particle';
import type { RequestHandler } from './$types';
import crypto from 'crypto';

/**
 * Poll the magnet_validation variable on a Particle device.
 * If the data has changed since the last known hash, save a new ValidationSession.
 */
export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) return json({ error: 'Unauthorized' }, { status: 401 });

	await connectDB();

	const { spuId, spuUdi, particleDeviceId, lastHash } = await request.json();

	if (!particleDeviceId) {
		return json({ error: 'No Particle device ID' }, { status: 400 });
	}

	try {
		const varData = await getVariable(particleDeviceId, 'magnet_validation');
		const rawResult = varData.result;

		if (!rawResult || typeof rawResult !== 'string' || rawResult.trim().length === 0) {
			return json({ status: 'no_data', hash: null });
		}

		// Hash the result to detect changes
		const currentHash = crypto.createHash('md5').update(rawResult).digest('hex');

		// If hash matches, no new data
		if (currentHash === lastHash) {
			return json({ status: 'unchanged', hash: currentHash });
		}

		// New data detected — parse and save
		const parsed = parseMagValidation(rawResult);

		// Get criteria
		const criteria = await Integration.findOne({ type: 'mag_criteria' }).lean() as any;
		const minZ = criteria?.minZ ?? 3900;
		const maxZ = criteria?.maxZ ?? 4500;

		// Evaluate pass/fail
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
			userId: locals.user._id,
			spuUdi: spuUdi,
			spuId: spuId,
			particleDeviceId: particleDeviceId,
			rawData: rawResult,
			magResults: parsed,
			overallPassed,
			failureReasons,
			criteriaUsed: { minZ, maxZ },
			source: 'auto-poll'
		});

		return json({
			status: 'new_result',
			hash: currentHash,
			session: {
				id: sessionId,
				overallPassed,
				failureCount: failureReasons.length,
				wellCount: parsed.length,
				completedAt: new Date().toISOString(),
				spuUdi
			}
		});
	} catch (err: any) {
		return json({
			status: 'error',
			error: err.message || 'Failed to read from device'
		}, { status: 500 });
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
