import { error } from '@sveltejs/kit';
import { connectDB, OpentronsRobot } from '$lib/server/db';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params }) => {
	await connectDB();
	const robot = await OpentronsRobot.findById(params.robotId).lean() as any;
	if (!robot) error(404, 'Robot not found');

	const dbRecord = (robot.protocols ?? []).find(
		(p: any) => p._id === params.protocolId || p.opentronsProtocolId === params.protocolId
	);

	let robotOffline = true;
	let protocol: any = null;
	let analysis: any = null;

	const otProtocolId = dbRecord?.opentronsProtocolId ?? params.protocolId;

	try {
		const resp = await fetch(
			`http://${robot.ip}:${robot.port ?? 31950}/protocols/${otProtocolId}`,
			{ signal: AbortSignal.timeout(3000) }
		);
		if (resp.ok) {
			robotOffline = false;
			const data = await resp.json();
			protocol = data.data ?? data;

			// Try to get analysis
			const analyses = protocol.analysisSummaries ?? [];
			if (analyses.length > 0) {
				const latestId = analyses[analyses.length - 1].id;
				try {
					const aResp = await fetch(
						`http://${robot.ip}:${robot.port ?? 31950}/protocols/${otProtocolId}/analyses/${latestId}`,
						{ signal: AbortSignal.timeout(3000) }
					);
					if (aResp.ok) {
						analysis = (await aResp.json()).data ?? await aResp.json();
					}
				} catch { /* ignore */ }
			}
		}
	} catch { /* robot offline */ }

	return {
		robotId: params.robotId,
		protocolId: params.protocolId,
		robotName: robot.name ?? '',
		robotOffline,
		protocol,
		dbRecord: dbRecord ? {
			protocolName: dbRecord.protocolName ?? null,
			protocolType: dbRecord.protocolType ?? null,
			analysisStatus: dbRecord.analysisStatus ?? null,
			parametersSchema: dbRecord.parametersSchema ?? null,
			labwareDefinitions: dbRecord.labwareDefinitions ?? null,
			pipettesRequired: dbRecord.pipettesRequired ?? null,
			updatedAt: dbRecord.updatedAt ? new Date(dbRecord.updatedAt).toISOString() : new Date().toISOString()
		} : null,
		analysis: analysis as {
			id: string;
			status: string;
			parameters?: Array<{
				variableName: string;
				displayName: string;
				type: string;
				default: unknown;
				choices?: Array<{ value: string | number; displayName: string }>;
				min?: number;
				max?: number;
			}>;
			labware?: Array<{
				id: string;
				loadName: string;
				namespace: string;
				location: { slotName: string } | { moduleId: string } | null;
				definitionUri: string;
			}>;
			pipettes?: Array<{ id: string; pipetteName: string; mount: string }>;
			liquids?: Array<{ id: string; displayName: string; description?: string }>;
		} | null
	};
};
