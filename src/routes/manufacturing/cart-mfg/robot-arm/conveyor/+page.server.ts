/**
 * Robot Arm — Conveyor: bench test of the wax-fill cooling belt on the arm
 * Pi's BCM 22 (physical pin 15). Temporary tab: the controls are expected to
 * move into Wax fill, while the Pi side (services/robot-arm/src/server/
 * conveyor.py) stays.
 *
 * The Pi runs a pulse in the background and answers at once, so a pulse may
 * be longer than this function's 30 s budget. The page re-runs this load
 * (depends 'robot-arm:conveyor') while the belt is running to follow it.
 */
import { fail, redirect } from '@sveltejs/kit';
import { connectDB } from '$lib/server/db/connection';
import { AuditLog, generateId } from '$lib/server/db';
import { requirePermission } from '$lib/server/permissions';
import { robotArm, type ConveyorStatus } from '$lib/server/robot-arm-client';
import type { Actions, PageServerLoad } from './$types';

const ARM_DEVICE_ID = 'robot-arm-pi';
// Mirrors conveyor.py; the Pi is the enforcement point.
const PULSE_MIN_MS = 10;
const PULSE_MAX_MS = 600000;
const DELAY_MAX_MS = 600000;

function parseMs(raw: FormDataEntryValue | null, min: number, max: number): number | null {
	const txt = raw?.toString().trim();
	const n = txt ? Number(txt) : NaN;
	if (!Number.isInteger(n) || n < min || n > max) return null;
	return n;
}

function conveyorMessage(err: unknown): string {
	const msg = (err as Error).message ?? 'unknown error';
	if (msg.includes('robot-arm 404')) {
		return 'The arm Pi does not have the conveyor endpoints yet - install conveyor.py on the Pi and restart the robot-arm service.';
	}
	if (msg.includes('robot-arm 409')) return 'A conveyor pulse is already in progress.';
	return msg;
}

async function audit(
	user: { _id: string; username: string },
	action: string,
	details: Record<string, unknown>
) {
	await connectDB();
	await AuditLog.create({
		_id: generateId(),
		tableName: 'robot_arm_gpio',
		recordId: ARM_DEVICE_ID,
		action,
		newData: { ...details, userId: user._id },
		changedBy: user.username
	});
}

export const load: PageServerLoad = async ({ locals, depends }) => {
	if (!locals.user) redirect(302, '/login');
	requirePermission(locals.user, 'manufacturing:read');
	depends('robot-arm:conveyor');

	let status: ConveyorStatus | null = null;
	let statusError: string | null = null;
	try {
		status = await robotArm.conveyorStatus();
	} catch (err) {
		statusError = conveyorMessage(err);
	}
	return { status, statusError, pulseMaxMs: PULSE_MAX_MS, delayMaxMs: DELAY_MAX_MS };
};

export const actions: Actions = {
	pulse: async ({ request, locals }) => {
		if (!locals.user) return fail(401, { error: 'Unauthorized' });
		requirePermission(locals.user, 'manufacturing:write');
		const data = await request.formData();
		const ms = parseMs(data.get('pulse_ms'), PULSE_MIN_MS, PULSE_MAX_MS);
		const delay = parseMs(data.get('delay_ms') || '0', 0, DELAY_MAX_MS);
		if (ms === null) return fail(400, { error: `Pulse must be ${PULSE_MIN_MS}-${PULSE_MAX_MS} ms` });
		if (delay === null) return fail(400, { error: `Delay must be 0-${DELAY_MAX_MS} ms` });
		try {
			const status = await robotArm.conveyorPulse({ ms, delay_ms: delay });
			await audit(locals.user, 'robot_arm.conveyor.pulse', {
				pin: status.pin,
				ms,
				delay_ms: delay,
				simulated: status.simulated
			});
			return { status };
		} catch (err) {
			const msg = (err as Error).message ?? '';
			return fail(msg.includes('robot-arm 409') ? 409 : 502, { error: conveyorMessage(err) });
		}
	},

	// Always allowed, even with nothing running: a stop must never be refused.
	stop: async ({ locals }) => {
		if (!locals.user) return fail(401, { error: 'Unauthorized' });
		requirePermission(locals.user, 'manufacturing:write');
		try {
			const status = await robotArm.conveyorStop();
			await audit(locals.user, 'robot_arm.conveyor.stop', {
				pin: status.pin,
				was_running: status.stopped ?? null
			});
			return { status };
		} catch (err) {
			return fail(502, { error: conveyorMessage(err) });
		}
	},

	// One write: drive BCM 22 low. Touches no pulse state on the Pi.
	forceOff: async ({ locals }) => {
		if (!locals.user) return fail(401, { error: 'Unauthorized' });
		requirePermission(locals.user, 'manufacturing:write');
		try {
			const status = await robotArm.conveyorForceOff();
			await audit(locals.user, 'robot_arm.conveyor.force_off', { pin: status.pin });
			return { status };
		} catch (err) {
			return fail(502, { error: conveyorMessage(err) });
		}
	}
};
