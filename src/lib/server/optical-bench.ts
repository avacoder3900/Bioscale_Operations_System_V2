import { Spu, ValidationSession, AuditLog, generateId } from '$lib/server/db';
import { callFunction, getVariable } from '$lib/server/particle';
import { appendSpuJournal } from '$lib/server/spu-journal';

/**
 * Optical bench (2026-09-17 plan): cartridge-free reads. The stage carries the
 * sensors and the lasers are fixed, so at the right stage position each sensor
 * sits directly in its laser's beam.
 *
 *  - laser  — lasers on, all ten AS7341 bands + photodiode per channel
 *  - dark   — same read with the lasers off (ambient / leakage)
 *  - scan   — photodiode + clear vs. stage position, to FIND the laser position
 *
 * Firmware v96 exposes cloud functions `laser_read` / `dark_read` / `laser_scan`
 * (deferred to the device main loop; the function returns the seq the result
 * will carry) and parks the result JSON in the `optical_bench` variable. BIMS
 * calls the function, polls the variable until that seq shows up, and stores
 * the result as a validation session against the unit. Contract:
 * brevitest-device/firmware/Docs/V96_BLANK_SONIC_LASER_HANDOFF.md, Change 6.
 *
 * Every read parameter is FIXED (Jacob, 2026-09-17/18) — nothing on the page
 * chooses them. Position 39500 µm is OPTICAL_BENCH_LASER_POSITION in firmware
 * v96 (found on 0247; the physical stop is between 39500 and 40500 on a fresh
 * home) and OPTICAL_BENCH_POSITION_LIMIT caps any position / scan end there.
 * Gain 8, astep 999, atime 49 are the bench settings Jacob wants; the firmware's
 * own defaults are gain 1 / 999 / 49, so BIMS always sends the full explicit
 * argument string (the firmware's CSV parser stops at an empty field, so a
 * position can't be omitted while passing gain). The scan keeps its start /
 * end / step inputs — those are the one thing the operator actually varies.
 *
 * Shared by the single-unit Go action on /validation/bench and the per-unit
 * "Run on all units" endpoint (/api/validation/bench/run). A fleet run can't
 * loop server-side — one read blocks up to ~36 s against a 60 s function limit —
 * so the page fans out one request per unit and tags each with a batchId
 * (rawData.batchId) so the whole run can be pulled back together.
 */
/** Mirrors OPTICAL_BENCH_LASER_POSITION / OPTICAL_BENCH_POSITION_LIMIT in brevitest-firmware.h. */
export const FIRMWARE_LASER_POSITION_UM = 39500;
export const FIRMWARE_POSITION_LIMIT_UM = 39500;
export const FIRMWARE_MAX_SCAN_POINTS = 12;
/** Fixed bench settings — sent on every call; the firmware's own defaults are gain 1 / astep 999 / atime 49. */
export const BENCH = { posUm: FIRMWARE_LASER_POSITION_UM, gain: 8, astep: 999, atime: 49 } as const;
export const BENCH_TYPES = ['laser', 'dark', 'laser_scan'] as const;
export type BenchType = (typeof BENCH_TYPES)[number];
const FN: Record<BenchType, string> = { laser: 'laser_read', dark: 'dark_read', laser_scan: 'laser_scan' };
const BANDS = ['f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7', 'f8', 'clear', 'nir'] as const;
const POLL_EVERY_MS = 1500;
const POLL_MAX = 24; // 36 s — a re-home + move + three reads is well under that

export interface BenchRequest {
	spuId: string;
	type: BenchType;
	start: number;
	end: number;
	stepUm: number;
	/** Set by a fleet run; failed attempts are then stored too so the batch is complete. */
	batchId?: string | null;
}
export type BenchOutcome =
	| { ok: true; type: BenchType; sessionId: string; spuUdi: string; result: any }
	| { ok: false; status: number; error: string; spuUdi?: string };

export function parseBenchType(raw: string | null | undefined): BenchType {
	return (BENCH_TYPES as readonly string[]).includes(raw ?? '') ? (raw as BenchType) : 'laser';
}

function describeReturn(v: number): string | null {
	if (v === -1) return 'The unit is busy (not idle). Wait for it to finish and try again.';
	if (v === -2) return 'A cartridge is inserted. The bench reads need an empty slot.';
	if (v === -3) return `The unit rejected the arguments (scan end above ${FIRMWARE_POSITION_LIMIT_UM} µm, more than ${FIRMWARE_MAX_SCAN_POINTS} scan points, or gain/astep/atime out of range).`;
	if (v < 0) return `The unit returned ${v}.`;
	return null;
}

export function validateScan(type: BenchType, start: number, end: number, stepUm: number): string | null {
	if (type !== 'laser_scan') return null;
	if (stepUm <= 0 || start < 0 || end < start) return 'Scan needs start ≥ 0, end ≥ start and a positive step.';
	if (end > FIRMWARE_POSITION_LIMIT_UM) return `Scan end cannot exceed ${FIRMWARE_POSITION_LIMIT_UM} µm — the physical stop is just past it and the firmware refuses anything higher.`;
	if (Math.floor((end - start) / stepUm) + 1 > FIRMWARE_MAX_SCAN_POINTS) return `At most ${FIRMWARE_MAX_SCAN_POINTS} scan points per channel — widen the step.`;
	return null;
}

/**
 * Record a fleet-run attempt that produced no reading (offline, busy, timeout…)
 * as a failed session, so the batch view lists every unit it covered.
 */
export async function recordBenchFailure(
	req: BenchRequest,
	spu: { udi?: string; particleLink?: { particleDeviceId?: string } } | null,
	error: string,
	who: { _id: string; username: string }
): Promise<void> {
	if (!req.batchId) return;
	const now = new Date();
	const sessionId = generateId();
	await ValidationSession.create({
		_id: sessionId,
		type: req.type,
		spuId: req.spuId,
		spuUdi: spu?.udi ?? null,
		particleDeviceId: spu?.particleLink?.particleDeviceId ?? null,
		status: 'failed',
		startedAt: now,
		completedAt: now,
		userId: who._id,
		rawData: { batchId: req.batchId, error, requested: { type: req.type, start: req.start, end: req.end, stepUm: req.stepUm } }
	});
	await AuditLog.create({
		_id: generateId(),
		tableName: 'validation_sessions',
		recordId: sessionId,
		action: 'optical_bench_read_failed',
		newData: { spuId: req.spuId, spuUdi: spu?.udi ?? null, type: req.type, batchId: req.batchId, error },
		changedBy: who.username,
		changedAt: now
	});
}

/** Trigger one bench read on one unit, wait for the result, and store it. */
export async function runBenchRead(req: BenchRequest, who: { _id: string; username: string }): Promise<BenchOutcome> {
	const { spuId, type, start, end, stepUm } = req;
	// Position, gain, astep and atime are fixed — see the header comment. They are
	// kept in rawData so history rows and the journal line say what was used.
	const { posUm: pos, gain, astep, atime } = BENCH;

	if (!spuId) return { ok: false, status: 400, error: 'Pick a unit' };
	const scanErr = validateScan(type, start, end, stepUm);
	if (scanErr) return { ok: false, status: 400, error: scanErr };
	const spu = (await Spu.findById(spuId).select('udi particleLink.particleDeviceId').lean()) as any;

	const failWith = async (status: number, error: string): Promise<BenchOutcome> => {
		await recordBenchFailure(req, spu, error, who);
		return { ok: false, status, error, spuUdi: spu?.udi };
	};

	if (!spu?.particleLink?.particleDeviceId) return failWith(400, 'That unit has no Particle device linked');
	const deviceId = spu.particleLink.particleDeviceId as string;

	// Always explicit: gain 8 is not the firmware default, and the CSV parser
	// cannot skip the position field.
	const arg =
		type === 'laser_scan'
			? [start, end, stepUm, gain, astep, atime].join(',')
			: [pos, gain, astep, atime].join(',');

	// 1. Trigger. The function returns the seq the result will carry.
	let seq: number;
	try {
		const r = await callFunction(deviceId, FN[type], arg);
		seq = Number(r.return_value);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		if (/not found/i.test(msg)) {
			return failWith(400, `The unit has no "${FN[type]}" function — it needs firmware v96.`);
		}
		return failWith(502, `Could not reach the unit: ${msg}`);
	}
	const why = describeReturn(seq);
	if (why) return failWith(400, why);

	// 2. Poll the variable until that seq shows up (or the device reports an error).
	let result: any = null;
	for (let i = 0; i < POLL_MAX; i++) {
		await new Promise((r) => setTimeout(r, POLL_EVERY_MS));
		try {
			const v = await getVariable(deviceId, 'optical_bench');
			const raw = typeof v?.result === 'string' ? v.result : '';
			if (!raw) continue;
			const parsed = JSON.parse(raw);
			if (Number(parsed?.seq) === seq) {
				result = parsed;
				break;
			}
		} catch {
			// transient — keep polling
		}
	}
	if (!result) return failWith(504, `The unit accepted the request (seq ${seq}) but no result arrived within ${(POLL_MAX * POLL_EVERY_MS) / 1000} s. Check the device log.`);
	if (result.error) return failWith(400, `The unit reported: ${result.error}`);

	// 3. Store it against the unit as validation data.
	const now = new Date();
	const sessionId = generateId();
	const rawData = {
		...result,
		requested: { type, pos, gain, astep, atime, start, end, stepUm },
		bands: BANDS,
		...(req.batchId ? { batchId: req.batchId } : {})
	};
	await ValidationSession.create({
		_id: sessionId,
		type,
		spuId,
		spuUdi: spu.udi,
		particleDeviceId: deviceId,
		status: 'completed',
		startedAt: now,
		completedAt: now,
		userId: who._id,
		rawData,
		results: [{ _id: generateId(), testType: type, rawData: result, processedData: null, passed: null, createdAt: now }]
	});
	await AuditLog.create({
		_id: generateId(),
		tableName: 'validation_sessions',
		recordId: sessionId,
		action: 'optical_bench_read',
		newData: { spuId, spuUdi: spu.udi, type, seq, arg, ...(req.batchId ? { batchId: req.batchId } : {}) },
		changedBy: who.username,
		changedAt: now
	});
	const summary =
		type === 'laser_scan'
			? `Laser position scan ${start}–${end} µm (step ${stepUm})`
			: `${type === 'dark' ? 'Dark read' : 'Laser-into-sensor read'} at ${result.pos ?? pos} µm, gain ${result.gain ?? gain}` +
				(Array.isArray(result.ch) ? ` — pd A/B/C ${result.ch.map((c: any) => c.pd ?? '—').join('/')}` : '');
	await appendSpuJournal(spuId, `Optical bench: ${summary}${req.batchId ? ` (fleet run ${req.batchId})` : ''}`, who, {
		source: 'validation',
		refKind: 'validation_session',
		refId: sessionId,
		refLabel: 'Optical bench'
	});

	return { ok: true, type, sessionId, spuUdi: spu.udi, result };
}
