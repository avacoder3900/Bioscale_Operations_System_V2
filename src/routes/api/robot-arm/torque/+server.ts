/**
 * Follower torque, for the camera card on every Robot Arm tab.
 *
 *   GET  → { torqueOn: true | false | null, servos: [{ id, torque }] }
 *   POST { enable: boolean }
 *        → { torqueOn, mode: 'off' | 'hold' | 'plain', warning: string | null }
 *
 * Turning torque ON goes through the Pi's hold route (goal := present,
 * then torque on) so the arm stays where it is. If that route is not
 * installed yet, a plain torque-on is sent and the response warns that
 * the servos drive to their last goal. Refused (409) while a session owns
 * the arm: a session controls torque itself.
 */
import { error, json } from '@sveltejs/kit';
import { AuditLog, generateId } from '$lib/server/db';
import { requirePermission } from '$lib/server/permissions';
import { robotArm } from '$lib/server/robot-arm-client';
import type { RequestHandler } from './$types';

async function readTorque(): Promise<{ torqueOn: boolean | null; servos: { id: number; torque: boolean | null }[] }> {
	const servos = await robotArm.listServos();
	const rows = (Array.isArray(servos) ? servos : []).filter((s) => s && Number.isFinite(s.id)).map((s) => ({ id: s.id, torque: typeof s.torque === 'boolean' ? s.torque : null }));
	const known = rows.map((r) => r.torque).filter((t): t is boolean => t !== null);
	// All on → true, all off → false, mixed or unreported → null.
	const torqueOn = !known.length ? null : known.every(Boolean) ? true : known.every((t) => !t) ? false : null;
	return { torqueOn, servos: rows };
}

export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.user) error(401, 'Not authenticated');
	requirePermission(locals.user, 'manufacturing:read');
	try {
		return json(await readTorque(), { headers: { 'Cache-Control': 'no-store' } });
	} catch (err) {
		console.error('[arm-torque] read failed:', err instanceof Error ? err.message : err);
		error(502, 'Could not read the servos');
	}
};

export const POST: RequestHandler = async ({ locals, request }) => {
	if (!locals.user) error(401, 'Not authenticated');
	requirePermission(locals.user, 'manufacturing:write');
	const body = await request.json().catch(() => null);
	if (typeof body?.enable !== 'boolean') error(400, 'enable must be true or false');
	const enable: boolean = body.enable;

	let active;
	try {
		active = (await robotArm.getActive()).active;
	} catch (err) {
		error(502, `Cannot reach the arm: ${err instanceof Error ? err.message : String(err)}`);
	}
	if (active) error(409, `A ${active.kind} session is using the arm — stop it first.`);

	let mode: 'off' | 'hold' | 'plain' = 'off';
	let warning: string | null = null;
	try {
		if (!enable) {
			await robotArm.setTorque(false);
		} else {
			try {
				await robotArm.holdServos();
				mode = 'hold';
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				if (!/robot-arm 404/.test(msg)) throw err;
				await robotArm.setTorque(true);
				mode = 'plain';
				warning = 'The Pi has no hold route (scripts/install_hold_router.py), so torque was switched on plainly — each servo drives to its last commanded position.';
			}
		}
	} catch (err) {
		error(502, `Torque ${enable ? 'on' : 'off'} failed: ${err instanceof Error ? err.message : String(err)}`);
	}

	await AuditLog.create({
		_id: generateId(),
		tableName: 'robot_arm_servos',
		recordId: 'follower',
		action: enable ? 'robot_arm.torque.on' : 'robot_arm.torque.off',
		newData: { userId: locals.user._id, enable, mode, warning },
		changedBy: locals.user.username,
		changedAt: new Date()
	});

	let torqueOn: boolean | null = enable;
	try {
		torqueOn = (await readTorque()).torqueOn;
	} catch {
		/* the write succeeded; report the intent */
	}
	return json({ torqueOn, mode, warning }, { headers: { 'Cache-Control': 'no-store' } });
};
