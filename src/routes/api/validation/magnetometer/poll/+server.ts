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

	const { spuId, spuUdi, particleDeviceId, lastHash, seedOnly } = await request.json();

	if (!particleDeviceId) {
		return json({ error: 'No Particle device ID' }, { status: 400 });
	}

	try {
		// Check if device is online first (fast call, avoids timeout on offline devices)
		const { getDevice } = await import('$lib/server/particle');
		const deviceInfo = await getDevice(particleDeviceId);
		if (!deviceInfo.connected) {
			return json({ status: 'offline', error: `Device is offline (last seen: ${deviceInfo.last_heard ? new Date(deviceInfo.last_heard).toLocaleString() : 'never'})` });
		}

		const varData = await getVariable(particleDeviceId, 'magnet_validation');
		const rawResult = varData.result;

		if (!rawResult || typeof rawResult !== 'string' || rawResult.trim().length === 0) {
			return json({ status: 'no_data', hash: null, testCounter: null });
		}

		// Extract test counter from first line (format: #003\t1710268200)
		let testCounter: string | null = null;
		const counterMatch = rawResult.match(/^#(\d+)\t/);
		if (counterMatch) {
			testCounter = counterMatch[1];
		}

		// Use test counter for change detection if available, fall back to hash
		const currentHash = testCounter ?? crypto.createHash('md5').update(rawResult).digest('hex');

		// If hash/counter matches, no new data
		if (currentHash === lastHash) {
			return json({ status: 'unchanged', hash: currentHash, testCounter });
		}

		// seedOnly mode — just return the current hash, don't store
		if (seedOnly) {
			return json({ status: 'seeded', hash: currentHash, testCounter });
		}

		// Deduplicate — check if we already stored this exact data
		const existingSession = await ValidationSession.findOne({
			spuId,
			rawData: rawResult
		}).lean();
		if (existingSession) {
			return json({ status: 'unchanged', hash: currentHash, testCounter });
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
			if (well.error) {
				failureReasons.push(`Well ${well.well}: ${well.error}`);
				continue;
			}
			for (const ch of ['A', 'B', 'C'] as const) {
				const z = well[`ch${ch}_Z`];
				if (z !== null && (z < minZ || z > maxZ)) {
					failureReasons.push(`Well ${well.well} Ch ${ch}: Z=${z} (range: ${minZ}-${maxZ})`);
				}
				// Also fail if Z is null (no data for this channel)
				if (z === null) {
					failureReasons.push(`Well ${well.well} Ch ${ch}: No Z reading`);
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
			testCounter,
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
	error: string | null;
	chA_T: number | null; chA_X: number | null; chA_Y: number | null; chA_Z: number | null;
	chB_T: number | null; chB_X: number | null; chB_Y: number | null; chB_Z: number | null;
	chC_T: number | null; chC_X: number | null; chC_Y: number | null; chC_Z: number | null;
}

function parseMagValidation(raw: string): MagWellResult[] {
	// Split on \r\n or \n, trim, skip empty lines
	const lines = raw.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0);
	const results: MagWellResult[] = [];

	for (const line of lines) {
		// Skip counter/header line (e.g. #003\t1710268200)
		if (line.startsWith('#')) continue;

		// Match lines starting with well number (1-5) followed by tab
		const match = line.match(/^(\d+)\t/);
		if (!match) continue;

		const well = parseInt(match[1]);
		if (well < 1 || well > 5) continue;

		// Check for error messages in this well's data
		const hasError = line.includes('Could not find') || line.includes('error') || line.includes('Error');
		
		const parts = line.split('\t').map(s => s.trim());
		const nums = parts.slice(1).map(s => {
			const n = parseFloat(s);
			return isNaN(n) ? null : n;
		});

		results.push({
			well,
			error: hasError ? parts.slice(1).join(' ').trim() : null,
			chA_T: nums[0] ?? null, chA_X: nums[1] ?? null, chA_Y: nums[2] ?? null, chA_Z: nums[3] ?? null,
			chB_T: nums[4] ?? null, chB_X: nums[5] ?? null, chB_Y: nums[6] ?? null, chB_Z: nums[7] ?? null,
			chC_T: nums[8] ?? null, chC_X: nums[9] ?? null, chC_Y: nums[10] ?? null, chC_Z: nums[11] ?? null
		});
	}

	// Ensure all 5 wells are represented (even if missing from data)
	for (let w = 1; w <= 5; w++) {
		if (!results.find(r => r.well === w)) {
			results.push({
				well: w, error: 'No data received',
				chA_T: null, chA_X: null, chA_Y: null, chA_Z: null,
				chB_T: null, chB_X: null, chB_Y: null, chB_Z: null,
				chC_T: null, chC_X: null, chC_Y: null, chC_Z: null
			});
		}
	}

	return results.sort((a, b) => a.well - b.well);
}
