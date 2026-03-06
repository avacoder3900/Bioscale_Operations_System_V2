/**
 * Shared magnetometer validation logic.
 * Used by: main page actions, SPU history page actions, and poll API route.
 */
import { connectDB, ValidationSession, Integration, Spu, generateId } from '$lib/server/db';
import { getVariable } from '$lib/server/particle';

export interface MagWellResult {
	well: number;
	chA_T: number | null; chA_X: number | null; chA_Y: number | null; chA_Z: number | null;
	chB_T: number | null; chB_X: number | null; chB_Y: number | null; chB_Z: number | null;
	chC_T: number | null; chC_X: number | null; chC_Y: number | null; chC_Z: number | null;
}

/**
 * Parse tab-delimited magnet_validation variable output into structured well data.
 */
export function parseMagValidation(raw: string): MagWellResult[] {
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

/**
 * Extract Unix timestamp string from the filename in the raw device output.
 * e.g. "/validation/magnet-1772655738.txt" → "1772655738"
 */
export function extractTimestamp(raw: string): string | null {
	const match = raw.match(/\/validation\/magnet-(\d+)\.txt/);
	return match ? match[1] : null;
}

/**
 * Evaluate pass/fail criteria against well data.
 * Returns overallPassed and an array of failure reason strings.
 */
export function evaluateCriteria(
	wells: MagWellResult[],
	minZ: number,
	maxZ: number
): { overallPassed: boolean; failureReasons: string[] } {
	const failureReasons: string[] = [];

	for (const well of wells) {
		for (const ch of ['A', 'B', 'C'] as const) {
			const z = well[`ch${ch}_Z` as keyof MagWellResult] as number | null;
			if (z !== null && (z < minZ || z > maxZ)) {
				failureReasons.push(`Well ${well.well} Ch ${ch}: Z=${z} (range: ${minZ}-${maxZ})`);
			}
		}
	}

	return { overallPassed: failureReasons.length === 0, failureReasons };
}

export interface ReadAndStoreResult {
	newSession: boolean;
	sessionId?: string;
	session?: any;
	passed?: boolean;
	message?: string;
	error?: string;
}

/**
 * Full flow: read magnet_validation from device, check timestamp dedup, store if new.
 * Returns { newSession: true, session } if a new session was created,
 * or { newSession: false, message } if already stored or no data.
 */
export async function readAndStoreIfNew(
	spuId: string,
	particleDeviceId: string
): Promise<ReadAndStoreResult> {
	await connectDB();

	try {
		// 1. Read variable from device
		const varData = await getVariable(particleDeviceId, 'magnet_validation');
		const raw = varData?.result;

		if (!raw || typeof raw !== 'string') {
			return { newSession: false, message: 'No magnet_validation data on device. Run a test first.' };
		}

		// 2. Extract timestamp for dedup
		const deviceTimestamp = extractTimestamp(raw);

		// 3. Check if we already have a session with this timestamp for this SPU
		if (deviceTimestamp) {
			const existing = await ValidationSession.findOne({
				spuId,
				deviceTimestamp,
				type: 'mag'
			}).lean() as any;

			if (existing) {
				return {
					newSession: false,
					message: 'No new test data. Already stored this test result.',
					sessionId: existing._id,
					session: existing
				};
			}
		}

		// 4. New data — parse and evaluate
		const wells = parseMagValidation(raw);

		// 5. Get current criteria
		const criteria = await Integration.findOne({ type: 'mag_criteria' }).lean() as any;
		const minZ = criteria?.minZ ?? 3900;
		const maxZ = criteria?.maxZ ?? 4500;

		const { overallPassed, failureReasons } = evaluateCriteria(wells, minZ, maxZ);

		// 6. Get SPU info for UDI
		const spu = await Spu.findById(spuId, { udi: 1 }).lean() as any;

		// 7. Create new session
		const sessionId = generateId();
		const session = await ValidationSession.create({
			_id: sessionId,
			type: 'mag',
			status: overallPassed ? 'completed' : 'failed',
			startedAt: new Date(),
			completedAt: new Date(),
			spuId,
			spuUdi: spu?.udi ?? null,
			particleDeviceId,
			rawData: raw,
			magResults: wells,
			overallPassed,
			failureReasons,
			criteriaUsed: { minZ, maxZ },
			deviceTimestamp: deviceTimestamp ?? undefined
		});

		return {
			newSession: true,
			sessionId: session._id,
			passed: overallPassed,
			session: JSON.parse(JSON.stringify(session))
		};
	} catch (err: any) {
		// Handle duplicate key error (race condition — session was just inserted)
		if (err?.code === 11000) {
			return { newSession: false, message: 'Already stored this test result (duplicate).' };
		}
		return { newSession: false, error: `Failed: ${err instanceof Error ? err.message : String(err)}` };
	}
}
