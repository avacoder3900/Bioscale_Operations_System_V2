/**
 * Protocol management — List / Upload.
 * GET  /api/opentrons-lab/robots/:id/protocols
 * POST /api/opentrons-lab/robots/:id/protocols   (multipart: protocolFile)
 *
 * Upload is transport-agnostic (OT2-BRIDGE-3): bridged on Vercel (cloud →
 * daemon → robot), direct on the lab LAN. On success the protocol is upserted
 * into OpentronsRobot.protocols[] — the array the wax/reagent Start Run panels
 * read — tagged with a processType derived from the filename.
 */

import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requirePermission } from '$lib/server/permissions';
import { getRobot, robotBaseUrl, robotUploadProtocol } from '$lib/server/opentrons/proxy';
import { connectDB, OpentronsRobot, AuditLog, generateId } from '$lib/server/db';

// The bridged upload + on-robot analysis round-trip can exceed the 30s default.
export const config = { maxDuration: 120 };

function deriveProtocolType(fileName: string): 'wax-filling' | 'reagent-filling' | 'other' {
	const f = fileName.toLowerCase();
	if (f.includes('wax')) return 'wax-filling';
	if (f.includes('reagent')) return 'reagent-filling';
	return 'other';
}

export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) error(401, 'Not authenticated');
	requirePermission(locals.user, 'manufacturing:read');

	const robot = await getRobot(params.id);
	if (!robot) error(404, 'Robot not found');

	try {
		const res = await fetch(`${robotBaseUrl(robot)}/protocols`, {
			headers: { 'opentrons-version': '3' }
		});
		const data = await res.json();
		return json(data);
	} catch (e) {
		console.error('[API] list protocols error:', e instanceof Error ? e.message : e);
		error(502, 'Failed to reach robot');
	}
};

export const POST: RequestHandler = async ({ params, locals, request }) => {
	if (!locals.user) error(401, 'Not authenticated');
	requirePermission(locals.user, 'manufacturing:write');

	await connectDB();
	const robot = await getRobot(params.id);
	if (!robot) error(404, 'Robot not found');

	const formData = await request.formData();
	const file = formData.get('protocolFile') as File | null;
	if (!file) error(400, 'protocolFile is required');

	const fileName = file.name;
	const bytes = new Uint8Array(await file.arrayBuffer());

	let uploaded;
	try {
		uploaded = await robotUploadProtocol(robot, fileName, bytes);
	} catch (e) {
		if ((e as any)?.status) throw e;
		console.error('[API] upload protocol error:', e instanceof Error ? e.message : e);
		error(502, e instanceof Error ? e.message : 'Failed to upload protocol');
	}

	const protocolType = deriveProtocolType(fileName);
	const entry = {
		_id: generateId(),
		opentronsProtocolId: uploaded.opentronsProtocolId,
		protocolName: fileName,
		protocolType,
		parametersSchema: uploaded.parametersSchema ?? null,
		analysisStatus: uploaded.analysisStatus,
		labwareDefinitions: uploaded.labwareDefinitions ?? null,
		pipettesRequired: uploaded.pipettesRequired ?? null,
		uploadedBy: locals.user.username,
		createdAt: new Date(),
		updatedAt: new Date()
	};

	// Upsert into the robot's embedded protocols[] — replace any prior entry with
	// the same robot-assigned protocol id, then push the fresh one.
	await OpentronsRobot.updateOne(
		{ _id: params.id },
		{ $pull: { protocols: { opentronsProtocolId: uploaded.opentronsProtocolId } } }
	);
	await OpentronsRobot.updateOne(
		{ _id: params.id },
		{ $push: { protocols: entry } }
	);

	await AuditLog.create({
		_id: generateId(),
		action: 'upload',
		resourceType: 'opentrons_protocol',
		resourceId: uploaded.opentronsProtocolId,
		userId: locals.user._id,
		username: locals.user.username,
		timestamp: new Date(),
		details: { robotId: params.id, protocolName: fileName, protocolType, analysisStatus: uploaded.analysisStatus }
	});

	return json({
		data: {
			opentronsProtocolId: uploaded.opentronsProtocolId,
			protocolName: fileName,
			protocolType,
			analysisStatus: uploaded.analysisStatus
		}
	}, { status: 201 });
};
