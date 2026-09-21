import { fail } from '@sveltejs/kit';
import { requirePermission } from '$lib/server/permissions';
import { connectDB, Spu, CalibrationRecord, AuditLog, generateId } from '$lib/server/db';
import type { PageServerLoad, Actions } from './$types';

// Mirror of firmware constants (brevitest-firmware.h). The calibration output
// is expressed relative to the mag start so retuning well_move[] moves the
// validation sweep and the BCODE together.
const MAG_START = 12800; // STAGE_MICRONS_TO_MAGNETOMETER_START_POSITION
const NUM_WELLS = 5; // MAGNETOMETER_NUMBER_OF_WELLS
const STAGE_POSITION_LIMIT = 45000;
const MOTOR_SLOW_STEP_DELAY = 600;
const CURRENT_WELL_MOVE = [-8000, 8000, 8000, 8000, 8200];

export const load: PageServerLoad = async ({ locals }) => {
	requirePermission(locals.user, 'spu:read');
	await connectDB();

	const spus = await Spu.find(
		{ 'particleLink.particleDeviceId': { $exists: true, $ne: null } },
		{ udi: 1, 'particleLink.particleDeviceId': 1, status: 1 }
	).lean();

	const calibrations = await CalibrationRecord.find({ equipmentType: 'spu-mag-stage' })
		.sort({ calibrationDate: -1 })
		.limit(10)
		.lean();

	return {
		spus: JSON.parse(JSON.stringify(spus)).map((s: any) => ({
			id: s._id,
			udi: s.udi,
			status: s.status,
			particleDeviceId: s.particleLink?.particleDeviceId ?? null
		})),
		calibrations: JSON.parse(JSON.stringify(calibrations)),
		firmware: {
			magStart: MAG_START,
			numWells: NUM_WELLS,
			stageLimit: STAGE_POSITION_LIMIT,
			stepDelay: MOTOR_SLOW_STEP_DELAY,
			currentWellMove: CURRENT_WELL_MOVE
		}
	};
};

export const actions: Actions = {
	save: async ({ request, locals }) => {
		requirePermission(locals.user, 'spu:write');
		const user = locals.user!;
		await connectDB();

		const data = await request.formData();
		const spuId = data.get('spuId')?.toString();
		const notes = data.get('notes')?.toString() ?? '';
		let positions: number[];
		try {
			positions = JSON.parse(data.get('positions')?.toString() ?? '[]');
		} catch {
			return fail(400, { error: 'Invalid positions payload' });
		}

		if (!spuId) return fail(400, { error: 'Select an SPU' });
		if (
			!Array.isArray(positions) ||
			positions.length !== NUM_WELLS ||
			positions.some((p) => !Number.isInteger(p) || p < 0 || p > STAGE_POSITION_LIMIT)
		) {
			return fail(400, {
				error: `Need ${NUM_WELLS} captured integer positions between 0 and ${STAGE_POSITION_LIMIT} µm`
			});
		}
		for (let i = 1; i < positions.length; i++) {
			if (positions[i] <= positions[i - 1]) {
				return fail(400, {
					error: `Position ${i + 1} (${positions[i]} µm) must be further from the limit switch than position ${i} (${positions[i - 1]} µm)`
				});
			}
		}

		const spu = (await Spu.findById(spuId).lean()) as any;
		if (!spu) return fail(404, { error: 'SPU not found' });

		// well_move[i] is the relative move validate_magnets() makes before
		// reading well i; the first entry starts from the mag start position.
		const wellMove = positions.map((p, i) => (i === 0 ? p - MAG_START : p - positions[i - 1]));
		const bcode = wellMove.map((m) => `2,${m},${MOTOR_SLOW_STEP_DELAY}`).join('\n');
		const headerSnippet = `int well_move[${NUM_WELLS}] = { ${wellMove.join(', ')} };`;

		const record = await CalibrationRecord.create({
			_id: generateId(),
			equipmentId: spuId,
			equipmentType: 'spu-mag-stage',
			calibrationDate: new Date(),
			nextCalibrationDue: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
			performedBy: { _id: user._id, username: user.username },
			status: 'pass',
			notes,
			results: {
				spuUdi: spu.udi ?? null,
				particleDeviceId: spu.particleLink?.particleDeviceId ?? null,
				magStart: MAG_START,
				stepDelay: MOTOR_SLOW_STEP_DELAY,
				positions,
				wellMove,
				bcode,
				headerSnippet,
				previousWellMove: CURRENT_WELL_MOVE
			}
		});

		await AuditLog.create({
			_id: generateId(),
			action: 'create',
			resourceType: 'calibration_record',
			resourceId: record._id,
			userId: user._id,
			username: user.username,
			timestamp: new Date(),
			details: { type: 'spu-mag-stage', spuId, spuUdi: spu.udi ?? null, positions, wellMove }
		});

		return { saved: true, recordId: record._id };
	}
};
