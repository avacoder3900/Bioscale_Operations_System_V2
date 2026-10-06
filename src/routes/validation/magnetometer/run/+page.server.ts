import { fail, redirect } from '@sveltejs/kit';
import { requirePermission } from '$lib/server/permissions';
import { connectDB, ValidationSession, Spu, Integration, AuditLog, generateId } from '$lib/server/db';
import { getVariable, callFunction, getDevice } from '$lib/server/particle';
import { extractMagTestTime, pullDelaySeconds } from '$lib/server/magnetometer-time';
import { withFieldMagnitudes, summarizeField, type MagWellMagnitudes } from '$lib/server/magnetometer-field';
import { autoEnterValidating } from '$lib/server/spu-auto-validate';
import type { Actions, PageServerLoad } from './$types';

/**
 * Argument for the firmware `run_sweep` cloud function, whose arg is
 * "y0,y1,dy,n,settle" (microns, microns, microns, samples per position, ms).
 *
 * DELIBERATELY EMPTY: an empty arg makes each of the five fields fall back to the
 * firmware's own MAGNETOMETER_SWEEP_DEFAULT_* values independently. Today those
 * are 1000 / 40000 / 200 / 8 / 250 — 196 stage positions, roughly a 19 minute run
 * — so sending "" and sending that explicit string are identical.
 *
 * They stop being identical the moment the firmware retunes a default. Pinning the
 * numbers here would create a second source of truth that silently wins, and BIMS
 * would keep running the OLD sweep against new firmware while appearing correct.
 * Since the version gate below already guarantees v98+, deferring to the device
 * means "the full sweep as this firmware defines it", which is what is wanted.
 *
 * The device echoes the real clamped/quantised values in its run_sweep_result
 * event, so the authoritative record of what actually ran comes from the device.
 */
const SWEEP_FULL_PARAMS = '';

/** What to show a human in errors and audit entries, since the arg itself is empty. */
const SWEEP_PARAMS_LABEL = 'firmware defaults (full sweep)';

/** First firmware exposing `run_sweep` as a cloud function. Below this the sweep
 *  exists only as serial command 77 and BIMS cannot start it at all. */
const SWEEP_MIN_FIRMWARE = 98;

/** DeviceMode::IDLE. The enum's 0-10 numbering is deliberately stable — see the
 *  comment on VALIDATING_THERMO in DeviceState.h, which was appended after
 *  ERROR_STATE precisely so get_state/force_state ordinals never shifted. */
const DEVICE_MODE_IDLE = 0;

/** Roughly how long the deferred on-device sweep runs. Shown to operators. */
const SWEEP_DURATION_MINUTES = 19;

export const load: PageServerLoad = async ({ locals }) => {
	requirePermission(locals.user, 'spu:read');
	await connectDB();

	// Get all SPUs with particle links. Retired units are excluded outright, the
	// same way the thermocouple picker does it — they are not validated.
	const spus = await Spu.find(
		{
			'particleLink.particleDeviceId': { $exists: true, $ne: null },
			status: { $ne: 'retired' }
		},
		{ udi: 1, 'particleLink.particleDeviceId': 1, status: 1, 'validation.magnetometer.status': 1 }
	).sort({ udi: 1 }).lean() as any[];

	// SPUs that actually have magnetometer runs on record. Deliberately NOT derived
	// from `spus` above: that list is filtered to units with a live Particle link so
	// a test can be triggered, whereas a unit can hold historical runs long after its
	// device link was cleared. The export picker must still offer those.
	const runAgg = await ValidationSession.aggregate([
		{ $match: { type: 'mag', spuId: { $ne: null } } },
		{
			$group: {
				_id: '$spuId',
				runCount: { $sum: 1 },
				lastRunAt: { $max: { $ifNull: ['$testRanAt', { $ifNull: ['$completedAt', '$createdAt'] }] } },
				udi: { $last: '$spuUdi' }
			}
		}
	]);

	const exportSpuIds = runAgg.map((r: any) => r._id);
	const exportSpuDocs = exportSpuIds.length
		? ((await Spu.find({ _id: { $in: exportSpuIds } }, { udi: 1, status: 1 }).lean()) as any[])
		: [];
	const exportSpuById = new Map(exportSpuDocs.map((s: any) => [s._id, s]));

	// Get criteria
	const criteria = await Integration.findOne({ type: 'mag_criteria' }).lean() as any;

	return {
		spus: spus.map((s: any) => ({
			id: s._id,
			udi: s.udi,
			particleDeviceId: s.particleLink?.particleDeviceId ?? null,
			status: s.status,
			// Gate for the sweep: a sweep characterises a unit against its recorded
			// run, so 'pending' (or a missing field on older SPUs) means none yet.
			magStatus: s.validation?.magnetometer?.status ?? 'pending'
		})),
		exportableSpus: runAgg
			.map((r: any) => ({
				id: r._id,
				udi: exportSpuById.get(r._id)?.udi ?? r.udi ?? r._id,
				status: exportSpuById.get(r._id)?.status ?? 'unknown',
				runCount: r.runCount,
				lastRunAt: r.lastRunAt ? new Date(r.lastRunAt).toISOString() : null
			}))
			.sort((a: any, b: any) => a.udi.localeCompare(b.udi)),
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
		// This action WRITES to the SPU (validation.magnetometer, and qcStatus on a
		// pass), so it must refuse a finalized unit like every other sacred mutation.
		// Without this the sacred middleware still blocks the write, but it surfaces as
		// an opaque caught exception instead of a clear message.
		if (spu.finalizedAt) return fail(400, { error: 'Cannot modify finalized SPU. Use corrections.' });

		// Read the current magnet_validation variable (from a previous run_test)
		try {
			// Check device is online first to avoid wasting time on offline devices
			const deviceInfo = await getDevice(spu.particleLink.particleDeviceId);
			if (!deviceInfo.online) {
				return fail(400, { error: `Device is offline (last seen: ${deviceInfo.last_heard ? new Date(deviceInfo.last_heard).toLocaleString() : 'never'})` });
			}

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

			// When the test actually RAN, per the device. `magnet_validation` is a
			// variable holding the result of a previous run_test, so the time we read
			// it is not the time it was measured — and a stale variable is a known
			// failure mode. Null when the payload carries no timestamp.
			const pulledAt = new Date();
			const testTime = extractMagTestTime(rawResult);

			// Session-level field rollup — declared on both schemas, otherwise
			// Mongoose strict mode drops it without a word.
			const fieldSummary = summarizeField(parsed);

			const sessionId = generateId();
			await ValidationSession.create({
				_id: sessionId,
				type: 'mag',
				status: overallPassed ? 'completed' : 'failed',
				startedAt: pulledAt,
				completedAt: pulledAt,
				testRanAt: testTime?.at ?? null,
				userId: locals.user!._id,
				spuUdi: spu.udi,
				spuId: spu._id,
				particleDeviceId: spu.particleLink.particleDeviceId,
				rawData: rawResult,
				magResults: parsed,
				fieldSummary,
				overallPassed,
				failureReasons,
				criteriaUsed: { minZ, maxZ }
			});

			// Update the SPU DHR rollup on BOTH outcomes — a failed test is part of
			// the unit's record too (failures used to stay 'pending' forever).
			// qcStatus is only promoted on a pass.
			const magStatus = overallPassed ? 'passed' : 'failed';
			await Spu.updateOne({ _id: spuId }, {
				$set: {
					'validation.magnetometer': {
						status: magStatus,
						sessionId,
						// completedAt keeps its existing meaning (when BIMS recorded
						// this) so the DHR field is not silently redefined; testRanAt
						// is the additive, accurate one.
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
			await autoEnterValidating(spuId, 'magnetometer', { _id: locals.user!._id, username: locals.user!.username });

			// Create audit log entry
			await AuditLog.create({
				_id: generateId(),
				tableName: 'spus',
				recordId: spuId,
				entityId: spuId,
				action: 'UPDATE',
				oldData: null,
				newData: {
					validationType: 'magnetometer',
					status: magStatus,
					sessionId,
					overallPassed,
					failureReasons: failureReasons.length > 0 ? failureReasons : undefined,
					criteriaUsed: { minZ, maxZ },
					fieldSummary
				},
				changedAt: new Date(),
				changedBy: locals.user!._id,
				reason: `Magnetometer validation: ${magStatus.toUpperCase()}${failureReasons.length > 0 ? ' — ' + failureReasons.join('; ') : ''}`
			});

			return {
				success: true,
				sessionId,
				spuUdi: spu.udi,
				overallPassed,
				failureReasons,
				criteriaUsed: { minZ, maxZ },
				magResults: parsed,
				fieldSummary,
				rawData: rawResult,
				// The time the TEST ran — this is what the page shows. Null when the
				// payload has no timestamp, in which case the UI says so rather than
				// falling back to the pull time.
				testRanAt: testTime?.at.toISOString() ?? null,
				testTimeSource: testTime?.source ?? null,
				pulledAt: pulledAt.toISOString(),
				pullDelaySeconds: pullDelaySeconds(testTime?.at ?? null, pulledAt),
				completedAt: pulledAt.toISOString()
			};
		} catch (err: any) {
			return fail(400, { error: `Failed: ${err instanceof Error ? err.message : String(err)}` });
		}
	},

	/**
	 * Arm a magnetometer stage sweep on the device.
	 *
	 * This ONLY starts the run. The firmware defers the sweep and the cloud call
	 * returns immediately, so there is nothing to await and no ValidationSession to
	 * create here — rows are streamed over serial and land later via the mag-sweep
	 * ingest endpoint, which creates the `type: 'mag_sweep'` session.
	 *
	 * A sweep is a characterisation run, NOT a pass/fail gate: it must never write
	 * `qcStatus` or `validation.magnetometer.status`. The regular test owns those.
	 */
	runSweep: async ({ request, locals }) => {
		requirePermission(locals.user, 'spu:write');
		await connectDB();

		const form = await request.formData();
		const spuId = form.get('spuId')?.toString();
		if (!spuId) return fail(400, { error: 'Select an SPU' });

		const spu = await Spu.findById(spuId).lean() as any;
		if (!spu) return fail(400, { error: 'SPU not found' });
		if (!spu.particleLink?.particleDeviceId) return fail(400, { error: 'SPU has no Particle device linked' });
		if (spu.finalizedAt) return fail(400, { error: 'Cannot modify finalized SPU. Use corrections.' });

		const deviceId = spu.particleLink.particleDeviceId;

		try {
			// `run_sweep` does not exist before firmware v98 — the sweep was serial-only
			// (command 77) until then. Calling it on an older device fails deep inside the
			// Particle API with an opaque error, so check the reported version first and
			// say plainly what is wrong. GET /v1/devices/:id carries firmware_version
			// (this is PRODUCT_VERSION, which this firmware keeps in step with
			// FIRMWARE_VERSION); there is no cloud variable for it.
			const info = await getDevice(deviceId);
			if (!info.connected) {
				return fail(400, {
					error: `Device is offline (last seen ${info.last_heard ? new Date(info.last_heard).toLocaleString() : 'never'}). It must be online to start a sweep.`
				});
			}
			// Coerce: the API has returned this as a number, but Particle is not
			// consistent about it across device types. An unparseable value is allowed
			// through rather than blocking a sweep on a version we simply could not read.
			const fw = Number(info.firmware_version);
			if (Number.isFinite(fw) && fw < SWEEP_MIN_FIRMWARE) {
				return fail(400, {
					error: `SPU ${spu.udi} is on firmware v${fw}. The sweep needs v${SWEEP_MIN_FIRMWARE} or later — below that it is a serial-only bench command (command 77) and cannot be started from BIMS.`
				});
			}

			// The deferred sweep is only picked up from loop()'s IDLE branch. If the
			// device is in any other mode, run_sweep still returns 1 (accepted and
			// queued) and nothing ever runs — BIMS would then write an immutable audit
			// entry asserting a 19-minute run that never happened. The return-value
			// guard below structurally cannot catch that, because the call genuinely
			// succeeded. Checking the mode first is the only place it can be caught.
			const stateRes = await callFunction(deviceId, 'get_state', '');
			const mode = typeof stateRes?.return_value === 'number' ? stateRes.return_value : null;
			if (mode !== DEVICE_MODE_IDLE) {
				return fail(400, {
					error: `SPU ${spu.udi} is not idle (device mode ${mode ?? 'unreadable'}). A sweep is only picked up from the idle loop — finish or clear the current operation first, then retry.`
				});
			}

			const res = await callFunction(deviceId, 'run_sweep', SWEEP_FULL_PARAMS);
			const returnValue = typeof res?.return_value === 'number' ? res.return_value : null;

			// Firmware contract: 1 = accepted and queued, <0 = rejected, 0 is banned.
			// Fail CLOSED on anything that is not strictly positive — zero, null and a
			// non-numeric return all mean "did not start". The asymmetry is deliberate:
			// a false negative costs the operator one retry, whereas a false positive
			// writes an immutable audit record asserting a 19-minute hardware run that
			// never happened. (0 is banned precisely because upload_session_log(), the
			// function run_sweep is modelled on, returns 0 for a non-start condition.)
			if (returnValue === null || returnValue <= 0) {
				return fail(400, {
					error: `Sweep did not start (run_sweep returned ${returnValue === null ? 'a non-numeric value' : returnValue}). Parameters sent: ${SWEEP_PARAMS_LABEL}`
				});
			}

			// Audited against the SPU because that is the unit the sweep characterises,
			// even though no field on the SPU document changes.
			await AuditLog.create({
				_id: generateId(),
				tableName: 'spus',
				recordId: spuId,
				entityId: spuId,
				action: 'UPDATE',
				oldData: null,
				newData: {
					validationType: 'magnetometer_sweep',
					event: 'sweep_started',
					particleDeviceId: deviceId,
					sweepParams: SWEEP_PARAMS_LABEL,
					returnValue
				},
				changedAt: new Date(),
				changedBy: locals.user!._id,
				reason: `Magnetometer stage sweep started on device ${deviceId} (params ${SWEEP_PARAMS_LABEL}). Characterisation run only — no SPU field changed, no pass/fail recorded.`
			});

			return {
				sweepStarted: true,
				sweepParams: SWEEP_PARAMS_LABEL,
				sweepMinutes: SWEEP_DURATION_MINUTES,
				sweepReturnValue: returnValue,
				sweepUdi: spu.udi,
				// SERVER clock, deliberately. The progress poller passes this back as
				// `since`, and the endpoint compares it against ValidationSession.createdAt
				// — also a server timestamp. Letting the browser supply it would compare
				// two different clocks: skew fast and the landed session never satisfies
				// createdAt > since, so the poll spins until it reports stale; skew slow
				// and it can match a PREVIOUS sweep, which is the precise confusion
				// `since` exists to prevent.
				sweepQueuedAt: new Date().toISOString()
			};
		} catch (err: any) {
			return fail(400, { error: `Failed to start sweep: ${err instanceof Error ? err.message : String(err)}` });
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

interface MagWellRaw {
	well: number;
	chA_T: number | null; chA_X: number | null; chA_Y: number | null; chA_Z: number | null;
	chB_T: number | null; chB_X: number | null; chB_Y: number | null; chB_Z: number | null;
	chC_T: number | null; chC_X: number | null; chC_Y: number | null; chC_Z: number | null;
}

/** Same stored shape as the poll endpoint: components plus derived |B|. */
type MagWellResult = MagWellRaw & MagWellMagnitudes;

// NOTE: this parser is deliberately NOT merged with the poll endpoint's. They
// disagree on more than formatting — the poll one flags per-well error text,
// range-checks the well number and pads the run out to 5 wells, this one does
// none of that. Only the magnitude derivation is shared, so the two paths write
// identical field keys without silently changing what either one parses.
function parseMagValidation(raw: string): MagWellResult[] {
	const lines = raw.split('\n').map(l => l.trim()).filter(l => l.length > 0);
	const results: MagWellRaw[] = [];

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

	// |B| derived once here so it is stored, not recomputed in the browser.
	return withFieldMagnitudes(results);
}

export const config = { maxDuration: 60 };
