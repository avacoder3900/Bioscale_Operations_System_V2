/**
 * POST /api/opentrons-lab/protocols/:id/deploy
 * Body: { robotId: string, phase?: 'prepare' | 'confirm', uploaded? }
 * Uploads a stored protocol to a robot, waits for its analysis, records the deployment.
 *
 * OT2-TAILNET-5 S4 — prepare → robot half → confirm:
 *   prepare  the stored .py as an upload bundle (DB only)
 *   robot    the shared 'run.uploadProtocol' verb ($lib/opentrons/ot2-protocol):
 *            multipart POST /protocols + the analysis wait
 *   confirm  OpentronProtocol requirements + the deployments[] entry
 * With no `phase` the route runs all three over the server line (the queue on
 * Vercel, the LAN in dev) — it used to fetch the robot IP directly, which can't
 * work from Vercel. A browser on the tailnet sends phase 'prepare', runs the
 * verb over its session, then sends phase 'confirm' with the result.
 */
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { connectDB, OpentronProtocol, OpentronsRobot, AuditLog, generateId } from '$lib/server/db';
import { requirePermission } from '$lib/server/permissions';
import { getRobot } from '$lib/server/opentrons/proxy';
import { serverTransport } from '$lib/server/opentrons/transport';
import {
	runVerb,
	validUploadedResult,
	type ProtocolUploadBundle,
	type UploadedProtocolResult
} from '$lib/opentrons/ot2-protocol';

// Over the queue the upload + on-robot analysis round trip takes up to ~110 s.
export const config = { maxDuration: 120 };

export const POST: RequestHandler = async ({ params, request, locals }) => {
	if (!locals.user) return json({ error: 'Unauthorized' }, { status: 401 });
	requirePermission(locals.user, 'manufacturing:write');

	await connectDB();

	const body = (await request.json().catch(() => ({}))) as any;
	const robotId = body?.robotId;
	const phase = body?.phase as 'prepare' | 'confirm' | undefined;
	if (!robotId) return json({ error: 'robotId is required' }, { status: 400 });

	const protocol = (await OpentronProtocol.findById(params.protocolId).lean()) as any;
	if (!protocol) return json({ error: 'Protocol not found' }, { status: 404 });
	if (!protocol.fileContent) return json({ error: 'Protocol has no file content' }, { status: 400 });

	const robot = (await OpentronsRobot.findById(robotId).lean()) as any;
	if (!robot) return json({ error: 'Robot not found' }, { status: 404 });

	// The .py alone, as the deploy always sent it (no labware bundle).
	const bundle: ProtocolUploadBundle = {
		fileName: protocol.fileName || 'protocol.py',
		fileContent: protocol.fileContent,
		labware: []
	};

	if (phase === 'prepare') return json({ bundle });

	if (phase === 'confirm') {
		const uploaded = validUploadedResult(body?.uploaded);
		if (!uploaded) return json({ error: 'upload result is malformed' }, { status: 400 });
		return recordDeployment(protocol, robotId, robot, uploaded, locals.user.username, 'tailnet');
	}

	const serverRobot = await getRobot(robotId);
	if (!serverRobot) return json({ error: 'Robot not found' }, { status: 404 });
	const r = await runVerb(serverTransport(serverRobot), 'run.uploadProtocol', bundle as unknown as Record<string, unknown>);
	if (r.status !== 200) {
		return json({ error: `Upload to robot failed: ${(r.body as any)?.message ?? 'unknown'}` }, { status: 502 });
	}
	return recordDeployment(protocol, robotId, robot, r.body as UploadedProtocolResult, locals.user.username, 'queue');
};

/** The BIMS half: requirements from the analysis + the deployments[] entry. */
async function recordDeployment(
	protocol: any,
	robotId: string,
	robot: any,
	uploaded: UploadedProtocolResult,
	username: string,
	line: 'queue' | 'tailnet'
): Promise<Response> {
	const analysisStatus = uploaded.analysisStatus === 'completed' || uploaded.analysisStatus === 'failed' ? uploaded.analysisStatus : 'pending';
	const analysisErrors = uploaded.analysisErrors ?? [];

	if (analysisStatus === 'completed') {
		// Extract labware and pipette requirements (same projection as before).
		const labware = ((uploaded.labwareDefinitions ?? []) as any[]).map((lw: any) => ({
			loadName: lw.loadName,
			displayName: lw.displayName ?? lw.loadName,
			slot: lw.location?.slotName,
			isCustom: lw.namespace !== 'opentrons'
		}));
		const pipettes = ((uploaded.pipettesRequired ?? []) as any[]).map((p: any) => ({
			pipetteName: p.pipetteName,
			mount: p.mount
		}));
		await OpentronProtocol.updateOne(
			{ _id: protocol._id },
			{
				$set: {
					labwareRequired: labware,
					pipettesRequired: pipettes,
					parametersSchema: uploaded.parametersSchema ?? null
				}
			}
		);
	}

	// Record deployment (the protocol's own history) + an AuditLog row with the line.
	const deployment = {
		_id: generateId(),
		robotId,
		robotName: robot.name,
		opentronsProtocolId: uploaded.opentronsProtocolId,
		analysisStatus,
		analysisErrors,
		deployedAt: new Date(),
		deployedBy: username
	};

	await OpentronProtocol.updateOne({ _id: protocol._id }, { $push: { deployments: deployment } });
	await AuditLog.create({
		_id: generateId(),
		tableName: 'opentrons_protocols',
		recordId: String(protocol._id),
		action: 'deploy',
		newData: { robotId, opentronsProtocolId: uploaded.opentronsProtocolId, analysisStatus, line },
		changedAt: new Date(),
		changedBy: username
	});

	return json(
		{
			data: {
				deploymentId: deployment._id,
				opentronsProtocolId: uploaded.opentronsProtocolId,
				analysisStatus,
				analysisErrors
			}
		},
		{ status: 201 }
	);
}
