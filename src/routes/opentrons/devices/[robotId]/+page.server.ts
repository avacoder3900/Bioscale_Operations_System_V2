import { error, redirect } from '@sveltejs/kit';
import { connectDB, OpentronsRobot } from '$lib/server/db';
import { requirePermission } from '$lib/server/permissions';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params, locals }) => {
	if (!locals.user) redirect(302, '/login');
	requirePermission(locals.user, 'manufacturing:read');
	await connectDB();
	const robot = await OpentronsRobot.findById(params.robotId).lean() as any;
	if (!robot) error(404, 'Robot not found');

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
			lastHealthOk: robot.lastHealthOk ?? false,
			lastHealthAt: robot.lastHealthAt ? new Date(robot.lastHealthAt).toISOString() : null,
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

