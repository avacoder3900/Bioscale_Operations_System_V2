/**
 * POST /api/opentrons-lab/protocols/:id/deploy
 * Body: { robotId: string }
 * Uploads protocol to robot, records deployment, polls for analysis.
 */
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { connectDB, OpentronProtocol, OpentronsRobot, generateId } from '$lib/server/db';
import { requirePermission } from '$lib/server/permissions';
import { robotBaseUrl } from '$lib/server/opentrons/proxy';

const ANALYSIS_POLL_INTERVAL = 2000;
const ANALYSIS_POLL_MAX = 30_000;

export const POST: RequestHandler = async ({ params, request, locals }) => {
	if (!locals.user) return json({ error: 'Unauthorized' }, { status: 401 });
	requirePermission(locals.user, 'manufacturing:write');

	await connectDB();

	const { robotId } = await request.json();
	if (!robotId) return json({ error: 'robotId is required' }, { status: 400 });

	const protocol = await OpentronProtocol.findById(params.protocolId);
	if (!protocol) return json({ error: 'Protocol not found' }, { status: 404 });
	if (!protocol.fileContent) return json({ error: 'Protocol has no file content' }, { status: 400 });

	const robot = await OpentronsRobot.findById(robotId).lean() as any;
	if (!robot) return json({ error: 'Robot not found' }, { status: 404 });

	const baseUrl = robotBaseUrl({ ip: robot.ip, port: robot.port ?? 31950 });

	// Upload protocol to robot via multipart
	const blob = new Blob([protocol.fileContent], { type: 'text/x-python' });
	const formData = new FormData();
	formData.append('files', blob, protocol.fileName || 'protocol.py');

	let uploadRes: Response;
	try {
		uploadRes = await fetch(`${baseUrl}/protocols`, {
			method: 'POST',
			headers: { 'opentrons-version': '3' },
			body: formData,
		});
	} catch (e) {
		return json({ error: `Robot unreachable: ${(e as Error).message}` }, { status: 502 });
	}

	if (!uploadRes.ok) {
		const err = await uploadRes.json().catch(() => ({}));
		return json({ error: 'Upload to robot failed', details: err }, { status: uploadRes.status });
	}

	const uploadData = (await uploadRes.json()).data;
	const opentronsProtocolId = uploadData.id;

	// Poll for analysis completion
	let analysisStatus: 'pending' | 'completed' | 'failed' = 'pending';
	let analysisErrors: string[] = [];
	const pollStart = Date.now();

	while (Date.now() - pollStart < ANALYSIS_POLL_MAX) {
		await new Promise(r => setTimeout(r, ANALYSIS_POLL_INTERVAL));
		try {
			const analysisRes = await fetch(`${baseUrl}/protocols/${opentronsProtocolId}/analyses`, {
				headers: { 'opentrons-version': '3' },
			});
			if (analysisRes.ok) {
				const analysisData = await analysisRes.json();
				const analyses = analysisData.data ?? [];
				if (analyses.length > 0) {
					const latest = analyses[analyses.length - 1];
					if (latest.status === 'completed') {
						analysisStatus = 'completed';

						// Extract labware and pipette requirements
						if (latest.result) {
							const labware = (latest.result.labware ?? []).map((lw: any) => ({
								loadName: lw.loadName,
								displayName: lw.displayName ?? lw.loadName,
								slot: lw.location?.slotName,
								isCustom: lw.namespace !== 'opentrons',
							}));
							const pipettes = (latest.result.pipettes ?? []).map((p: any) => ({
								pipetteName: p.pipetteName,
								mount: p.mount,
							}));
							const params = latest.result.runTimeParameters ?? null;

							await OpentronProtocol.updateOne(
								{ _id: protocol._id },
								{
									$set: {
										labwareRequired: labware,
										pipettesRequired: pipettes,
										parametersSchema: params,
									},
								}
							);
						}
						break;
					} else if (latest.status === 'failed' || latest.errors?.length) {
						analysisStatus = 'failed';
						analysisErrors = (latest.errors ?? []).map((e: any) => e.detail ?? e.errorType ?? 'Unknown');
						break;
					}
				}
			}
		} catch { /* retry */ }
	}

	// Record deployment
	const deployment = {
		_id: generateId(),
		robotId,
		robotName: robot.name,
		opentronsProtocolId,
		analysisStatus,
		analysisErrors,
		deployedAt: new Date(),
		deployedBy: locals.user.username,
	};

	await OpentronProtocol.updateOne(
		{ _id: protocol._id },
		{ $push: { deployments: deployment } }
	);

	return json({
		data: {
			deploymentId: deployment._id,
			opentronsProtocolId,
			analysisStatus,
			analysisErrors,
		},
	}, { status: 201 });
};
