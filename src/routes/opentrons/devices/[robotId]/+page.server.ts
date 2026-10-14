import { error, redirect } from '@sveltejs/kit';
import { connectDB, OpentronsRobot } from '$lib/server/db';
import { requirePermission } from '$lib/server/permissions';
import { getRobotsHealth, heartbeatFields } from '$lib/server/opentrons/health';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params, locals }) => {
	if (!locals.user) redirect(302, '/login');
	requirePermission(locals.user, 'manufacturing:read');
	await connectDB();
	const robot = await OpentronsRobot.findById(params.robotId).lean() as any;
	if (!robot) error(404, 'Robot not found');
	const health = await getRobotsHealth([{ _id: String(robot._id), name: robot.name }]).catch(() => ({}) as Record<string, any>);
	const hb = heartbeatFields(health[String(robot._id)]);

	// OT2-TAILNET-5 S7: live robot data (health, pipettes, runs) is read in the
	// browser over the robot session (+page.ts) — Vercel can't reach the robot.
	// This load returns the Mongo record only; the live fields start empty.
	const calibration: {
		status: { deckCalibration?: { status: string } | null } | null;
		pipetteOffsets: Array<{ mount: string; offset: number[]; status: string }>;
		labware: Array<{ labware: { loadName: string; parent: string }; offset: number[] }>;
	} = { status: null, pipetteOffsets: [], labware: [] };

	return {
		robot: {
			robotId: robot._id,
			name: robot.name ?? '',
			ip: robot.ip ?? '',
			port: robot.port ?? 31950,
			robotSide: robot.robotSide ?? null,
			robotModel: robot.robotModel ?? 'OT-2',
			robotSerial: robot.robotSerial ?? null,
			isActive: robot.isActive ?? true,
			// Bridge heartbeat (the robot record's lastHealthOk is a dead field).
			...hb,
			firmwareVersion: robot.firmwareVersion ?? null,
			apiVersion: robot.apiVersion ?? null,
			source: robot.source ?? 'manual'
		},
		robotOffline: true,
		info: null as any,
		calibration,
		recentRuns: null as any[] | null
	};
};

