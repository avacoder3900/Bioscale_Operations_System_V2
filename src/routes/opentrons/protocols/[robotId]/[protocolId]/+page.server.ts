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

	const dbRecord = (robot.protocols ?? []).find(
		(p: any) => p._id === params.protocolId || p.opentronsProtocolId === params.protocolId
	);

	// OT2-TAILNET-5 S7: the robot's protocol + analysis are read in the browser
	// (+page.ts) over the robot session. This load returns Mongo data only.
	const otProtocolId = dbRecord?.opentronsProtocolId ?? params.protocolId;

	return {
		robotId: params.robotId,
		protocolId: params.protocolId,
		robotName: robot.name ?? '',
		otProtocolId: String(otProtocolId),
		robotOffline: true,
		protocol: null as any,
		dbRecord: dbRecord ? {
			protocolName: dbRecord.protocolName ?? null,
			protocolType: dbRecord.protocolType ?? null,
			analysisStatus: dbRecord.analysisStatus ?? null,
			parametersSchema: dbRecord.parametersSchema ?? null,
			labwareDefinitions: dbRecord.labwareDefinitions ?? null,
			pipettesRequired: dbRecord.pipettesRequired ?? null,
			updatedAt: dbRecord.updatedAt ? new Date(dbRecord.updatedAt).toISOString() : new Date().toISOString()
		} : null,
		analysis: null as {
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

