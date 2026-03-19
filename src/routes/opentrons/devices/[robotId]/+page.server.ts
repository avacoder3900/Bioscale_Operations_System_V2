import { error } from '@sveltejs/kit';
import { connectDB, OpentronsRobot } from '$lib/server/db';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params }) => {
	await connectDB();
	const robot = await OpentronsRobot.findById(params.robotId).lean() as any;
	if (!robot) error(404, 'Robot not found');

	// Try to get live data from robot — stub if unavailable
	let robotOffline = true;
	let info: any = null;
	let calibration: {
		status: { deckCalibration?: { status: string } | null } | null;
		pipetteOffsets: Array<{ mount: string; offset: number[]; status: string }>;
		labware: Array<{ labware: { loadName: string; parent: string }; offset: number[] }>;
	} = { status: null, pipetteOffsets: [], labware: [] };
	let recentRuns: any[] | null = null;

	try {
		const resp = await fetch(`http://${robot.ip}:${robot.port ?? 31950}/health`, {
			signal: AbortSignal.timeout(3000)
		});
		if (resp.ok) {
			robotOffline = false;
			const health = await resp.json();
			info = {
				health: {
					name: health.name ?? robot.name,
					api_version: health.api_version ?? null,
					fw_version: health.fw_version ?? null,
					system_version: health.system_version ?? null,
					robot_serial: health.robot_serial ?? null,
					robot_model: health.robot_model ?? null
				},
				pipettes: [],
				modules: []
			};

			// Try to get pipettes
			try {
				const pipResp = await fetch(`http://${robot.ip}:${robot.port ?? 31950}/pipettes`, {
					signal: AbortSignal.timeout(3000)
				});
				if (pipResp.ok) {
					const pipData = await pipResp.json();
					info.pipettes = Object.entries(pipData).map(([mount, data]: any) => ({
						mount, ...data
					}));
				}
			} catch { /* ignore */ }

			// Try to get recent runs
			try {
				const runResp = await fetch(`http://${robot.ip}:${robot.port ?? 31950}/runs?pageLength=10`, {
					signal: AbortSignal.timeout(3000)
				});
				if (runResp.ok) {
					const runData = await runResp.json();
					recentRuns = (runData.data ?? []).map((r: any) => ({
						id: r.id,
						status: r.status ?? 'unknown',
						protocolId: r.protocolId ?? null,
						createdAt: r.createdAt ?? null,
						completedAt: r.completedAt ?? null
					}));
				}
			} catch { /* ignore */ }
		}
	} catch { /* robot offline */ }

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
		robotOffline,
		info,
		calibration,
		recentRuns
	};
};

export const config = { maxDuration: 60 };
