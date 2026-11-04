/**
 * Conveyor belt on the arm Pi's BCM 22 (physical pin 15): load + form actions
 * shared by every page that shows ConveyorPanel (Teach, Maintenance →
 * Conveyor). The Pi side is services/robot-arm/src/server/conveyor.py; it runs
 * a pulse in the background and answers at once, so a pulse may outlast the
 * 30 s request budget and the panel polls `conveyorStatus` to follow it.
 *
 * Action names carry a `conveyor` prefix so they can be spread into a page's
 * own actions object without colliding.
 */
import { error, fail, type RequestEvent } from '@sveltejs/kit';
import { connectDB } from '$lib/server/db/connection';
import { AuditLog, generateId } from '$lib/server/db';
import { ArmWaxFillSettings } from '$lib/server/db/models';
import { requirePermission } from '$lib/server/permissions';
import { robotArm, type ConveyorStatus } from '$lib/server/robot-arm-client';

const ARM_DEVICE_ID = 'robot-arm-pi';
// Mirrors conveyor.py; the Pi is the enforcement point.
const PULSE_MIN_MS = 10;
const PULSE_MAX_MS = 600000;
const DELAY_MAX_MS = 600000;
// Used until someone saves a default (stored on ArmWaxFillSettings).
const DEFAULT_PULSE_MS = 600;

export interface ConveyorView {
	status: ConveyorStatus | null;
	statusError: string | null;
	defaultPulseMs: number;
	pulseMaxMs: number;
	delayMaxMs: number;
}

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

async function readStatus(): Promise<{ status: ConveyorStatus | null; statusError: string | null }> {
	try {
		return { status: await robotArm.conveyorStatus(), statusError: null };
	} catch (err) {
		return { status: null, statusError: conveyorMessage(err) };
	}
}

/** Never throws for a down Pi: the panel shows the error instead. */
export async function loadConveyor(): Promise<ConveyorView> {
	const [st, settings] = await Promise.all([
		readStatus(),
		connectDB().then(
			() =>
				ArmWaxFillSettings.findById('default').select('conveyorPulseMs').lean() as Promise<{
					conveyorPulseMs?: number;
				} | null>
		)
	]);
	return {
		...st,
		defaultPulseMs: settings?.conveyorPulseMs ?? DEFAULT_PULSE_MS,
		pulseMaxMs: PULSE_MAX_MS,
		delayMaxMs: DELAY_MAX_MS
	};
}

function requireWriter(locals: App.Locals) {
	if (!locals.user) error(401, 'Unauthorized');
	requirePermission(locals.user, 'manufacturing:write');
	return locals.user;
}

export const conveyorActions = {
	conveyorStatus: async ({ locals }: RequestEvent) => {
		if (!locals.user) return fail(401, { error: 'Unauthorized' });
		requirePermission(locals.user, 'manufacturing:read');
		return readStatus();
	},

	conveyorPulse: async ({ request, locals }: RequestEvent) => {
		const user = requireWriter(locals);
		const data = await request.formData();
		const ms = parseMs(data.get('pulse_ms'), PULSE_MIN_MS, PULSE_MAX_MS);
		const delay = parseMs(data.get('delay_ms') || '0', 0, DELAY_MAX_MS);
		if (ms === null) return fail(400, { error: `Pulse must be ${PULSE_MIN_MS}-${PULSE_MAX_MS} ms` });
		if (delay === null) return fail(400, { error: `Delay must be 0-${DELAY_MAX_MS} ms` });
		try {
			const status = await robotArm.conveyorPulse({ ms, delay_ms: delay });
			await audit(user, 'robot_arm.conveyor.pulse', {
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
	conveyorStop: async ({ locals }: RequestEvent) => {
		const user = requireWriter(locals);
		try {
			const status = await robotArm.conveyorStop();
			await audit(user, 'robot_arm.conveyor.stop', {
				pin: status.pin,
				was_running: status.stopped ?? null
			});
			return { status };
		} catch (err) {
			return fail(502, { error: conveyorMessage(err) });
		}
	},

	// Shared default pulse, for everyone: only written when Save is pressed.
	conveyorSaveDefault: async ({ request, locals }: RequestEvent) => {
		const user = requireWriter(locals);
		const data = await request.formData();
		const ms = parseMs(data.get('default_ms'), PULSE_MIN_MS, PULSE_MAX_MS);
		if (ms === null) return fail(400, { error: `Default must be ${PULSE_MIN_MS}-${PULSE_MAX_MS} ms` });
		await connectDB();
		const before = (await ArmWaxFillSettings.findById('default').select('conveyorPulseMs').lean()) as {
			conveyorPulseMs?: number;
		} | null;
		await ArmWaxFillSettings.updateOne(
			{ _id: 'default' },
			{
				$set: {
					conveyorPulseMs: ms,
					conveyorPulseChangedBy: { _id: user._id, username: user.username }
				}
			},
			{ upsert: true }
		);
		await AuditLog.create({
			_id: generateId(),
			tableName: 'arm_wax_fill_settings',
			recordId: 'default',
			action: 'robot_arm.conveyor.default',
			oldData: { conveyorPulseMs: before?.conveyorPulseMs ?? DEFAULT_PULSE_MS },
			newData: { conveyorPulseMs: ms, userId: user._id },
			changedBy: user.username
		});
		return { savedDefaultMs: ms };
	},

	// One write: drive BCM 22 low. Touches no pulse state on the Pi.
	conveyorForceOff: async ({ locals }: RequestEvent) => {
		const user = requireWriter(locals);
		try {
			const status = await robotArm.conveyorForceOff();
			await audit(user, 'robot_arm.conveyor.force_off', { pin: status.pin });
			return { status };
		} catch (err) {
			return fail(502, { error: conveyorMessage(err) });
		}
	}
};
