/**
 * Shared magnetometer ingest.
 *
 * The read-and-store path used to live inline in the /api/validation/magnetometer/poll
 * handler, which meant anything else that wanted to capture a run had to copy it.
 * The per-channel |B| math already went through that cycle once (three copies that
 * drifted), so this path gets extracted the first time it has a second caller
 * instead of the third.
 *
 * Callers:
 *   - poll/+server.ts    browser-driven, actor = locals.user, source 'auto-poll'
 *   - record/+server.ts  API-key driven, actor resolved from the last active
 *                        BIMS session, source 'auto-record'
 *
 * Note this reads the `magnet_validation` cloud variable, i.e. the output of the
 * EXISTING magnet test. It has nothing to do with the firmware stage sweep
 * (serial cmd 77), which is a bench diagnostic and is deliberately not reachable
 * from BIMS. An earlier name for the record route implied otherwise.
 */
import crypto from 'crypto';
import { connectDB, ValidationSession, Integration, Spu, Session, User, generateId } from '$lib/server/db';
import { getVariable, getDevice } from '$lib/server/particle';
import { extractMagTestTime } from '$lib/server/magnetometer-time';
import { withFieldMagnitudes, summarizeField, type MagWellMagnitudes } from '$lib/server/magnetometer-field';
import { autoEnterValidating } from '$lib/server/spu-auto-validate';

export interface IngestActor {
	_id: string;
	username: string;
}

export interface IngestOptions {
	spuId?: string | null;
	spuUdi?: string | null;
	particleDeviceId: string;
	lastHash?: string | null;
	seedOnly?: boolean;
	/** Who the resulting ValidationSession is attributed to. May be null — userId
	 *  is not required on validationSessionSchema. */
	actor: IngestActor | null;
	/** Stored on the session so bench-captured runs stay distinguishable from
	 *  operator-captured ones. Must match validationSessionSchema.source's enum
	 *  or Mongoose rejects the write. */
	source: 'auto-poll' | 'auto-record';
}

export interface IngestResult {
	status: 'offline' | 'no_data' | 'unchanged' | 'seeded' | 'new_result' | 'error';
	hash?: string | null;
	testCounter?: string | null;
	error?: string;
	session?: {
		id: string;
		overallPassed: boolean;
		failureCount: number;
		wellCount: number;
		fieldSummary: ReturnType<typeof summarizeField>;
		testRanAt: string | null;
		pulledAt: string;
		completedAt: string;
		spuUdi?: string | null;
	};
}

/**
 * Best available answer to "who was last using BIMS".
 *
 * CAVEAT: sessionSchema is { timestamps: false }, so there is no stored login
 * time anywhere. expiresAt (login + TTL, bumped on renewal) is the only time
 * field, which makes this "most recently active session" rather than a literal
 * last-sign-in. Sessions are TTL-reaped, so when nobody has been in BIMS
 * recently this returns null and the session is stored with no userId.
 */
export async function resolveLastActiveUser(): Promise<IngestActor | null> {
	await connectDB();

	const latest = await Session.findOne().sort({ expiresAt: -1 }).lean() as any;
	if (!latest?.userId) return null;

	const user = await User.findById(latest.userId).select('username').lean() as any;
	if (!user) return null;

	return { _id: String(user._id), username: user.username };
}

/**
 * Read magnet_validation off a device and store a ValidationSession if the data
 * is new. Returns a plain object; the HTTP handlers decide the status code.
 */
export async function ingestMagnetValidation(opts: IngestOptions): Promise<IngestResult> {
	const { spuId, spuUdi, particleDeviceId, lastHash, seedOnly, actor, source } = opts;

	await connectDB();

	try {
		// Check if device is online first (fast call, avoids timeout on offline devices)
		const deviceInfo = await getDevice(particleDeviceId);
		if (!(deviceInfo as any).connected) {
			const lastHeard = (deviceInfo as any).last_heard;
			return {
				status: 'offline',
				error: `Device is offline (last seen: ${lastHeard ? new Date(lastHeard).toLocaleString() : 'never'})`
			};
		}

		const varData = await getVariable(particleDeviceId, 'magnet_validation');
		const rawResult = varData.result;

		if (!rawResult || typeof rawResult !== 'string' || rawResult.trim().length === 0) {
			return { status: 'no_data', hash: null, testCounter: null };
		}

		// Extract test counter from first line (format: #003\t1710268200)
		let testCounter: string | null = null;
		const counterMatch = rawResult.match(/^#(\d+)\t/);
		if (counterMatch) {
			testCounter = counterMatch[1];
		}

		// Use test counter for change detection if available, fall back to hash
		const currentHash = testCounter ?? crypto.createHash('md5').update(rawResult).digest('hex');

		if (currentHash === lastHash) {
			return { status: 'unchanged', hash: currentHash, testCounter };
		}

		// seedOnly mode — just return the current hash, don't store
		if (seedOnly) {
			return { status: 'seeded', hash: currentHash, testCounter };
		}

		// Deduplicate — check if we already stored this exact data
		const existingSession = await ValidationSession.findOne({
			spuId,
			rawData: rawResult
		}).lean();
		if (existingSession) {
			return { status: 'unchanged', hash: currentHash, testCounter };
		}

		// New data detected — parse and save
		const parsed = parseMagValidation(rawResult);

		const criteria = await Integration.findOne({ type: 'mag_criteria' }).lean() as any;
		const minZ = criteria?.minZ ?? 3900;
		const maxZ = criteria?.maxZ ?? 4500;

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
				if (z === null) {
					failureReasons.push(`Well ${well.well} Ch ${ch}: No Z reading`);
				}
			}
		}

		const overallPassed = failureReasons.length === 0;

		// When the test actually ran on the device, as opposed to when this read
		// happened to notice it. See $lib/server/magnetometer-time.
		const pulledAt = new Date();
		const testTime = extractMagTestTime(rawResult);

		// Session-level field rollup. Declared on validationSessionSchema and on
		// spus.validation.magnetometer — without those declarations strict mode
		// would drop it on the floor without complaining.
		const fieldSummary = summarizeField(parsed);

		const sessionId = generateId();
		await ValidationSession.create({
			_id: sessionId,
			type: 'mag',
			status: overallPassed ? 'completed' : 'failed',
			startedAt: pulledAt,
			completedAt: pulledAt,
			testRanAt: testTime?.at ?? null,
			userId: actor?._id ?? null,
			spuUdi: spuUdi,
			spuId: spuId,
			particleDeviceId: particleDeviceId,
			rawData: rawResult,
			magResults: parsed,
			fieldSummary,
			overallPassed,
			failureReasons,
			criteriaUsed: { minZ, maxZ },
			source
		});

		// Roll the result up onto the SPU DHR. Both outcomes are recorded;
		// qcStatus is only promoted on a pass (same rules as the manual read).
		if (spuId) {
			await Spu.updateOne({ _id: spuId }, {
				$set: {
					'validation.magnetometer': {
						status: overallPassed ? 'passed' : 'failed',
						sessionId,
						completedAt: pulledAt,
						testRanAt: testTime?.at ?? null,
						rawData: rawResult,
						results: parsed,
						fieldSummary,
						failureReasons: overallPassed ? [] : failureReasons,
						criteriaUsed: { minZ, maxZ }
					},
					...(overallPassed ? { qcStatus: 'passed' } : {})
				}
			});
			// Evidence drives the evidence state (SPU-INV-12).
			if (actor) {
				await autoEnterValidating(spuId, 'magnetometer', { _id: actor._id, username: actor.username });
			}
		}

		return {
			status: 'new_result',
			hash: currentHash,
			testCounter,
			session: {
				id: sessionId,
				overallPassed,
				failureCount: failureReasons.length,
				wellCount: parsed.length,
				fieldSummary,
				testRanAt: testTime?.at.toISOString() ?? null,
				pulledAt: pulledAt.toISOString(),
				completedAt: pulledAt.toISOString(),
				spuUdi
			}
		};
	} catch (err: any) {
		return {
			status: 'error',
			error: err.message || 'Failed to read from device'
		};
	}
}

interface MagWellRaw {
	well: number;
	error: string | null;
	chA_T: number | null; chA_X: number | null; chA_Y: number | null; chA_Z: number | null;
	chB_T: number | null; chB_X: number | null; chB_Y: number | null; chB_Z: number | null;
	chC_T: number | null; chC_X: number | null; chC_Y: number | null; chC_Z: number | null;
}

/** What actually gets stored in magResults: the parsed components plus the
 *  derived per-channel field magnitudes. */
export type MagWellResult = MagWellRaw & MagWellMagnitudes;

export function parseMagValidation(raw: string): MagWellResult[] {
	// Split on \r\n or \n, trim, skip empty lines
	const lines = raw.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0);
	const results: MagWellRaw[] = [];

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

	// |B| is derived once, here, so every consumer reads a stored value instead of
	// re-deriving it in the browser. See $lib/server/magnetometer-field.
	return withFieldMagnitudes(results.sort((a, b) => a.well - b.well));
}
