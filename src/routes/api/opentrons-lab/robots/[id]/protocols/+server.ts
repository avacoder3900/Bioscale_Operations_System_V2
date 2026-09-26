/**
 * Protocol management — List / Upload.
 * GET  /api/opentrons-lab/robots/:id/protocols
 * POST /api/opentrons-lab/robots/:id/protocols   (multipart: protocolFile)
 *
 * Upload is transport-agnostic (OT2-BRIDGE-3): bridged on Vercel (cloud →
 * daemon → robot), direct on the lab LAN. On success the protocol is upserted
 * into OpentronsRobot.protocols[] — the array the wax/reagent Start Run panels
 * read — tagged with a processType derived from the filename.
 *
 * OT2-TAILNET-5 S4 — the same upload in two halves for the tailnet line:
 *   POST {phase:'prepare', fileName, fileB64}  → {bundle}  (the .py + the BIMS
 *        labware it loads; the browser then runs 'run.uploadProtocol' directly)
 *   POST {phase:'confirm', fileName, uploaded} → the same record + AuditLog
 * The multipart POST (queue line) is unchanged.
 */

import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requirePermission } from '$lib/server/permissions';
import { getRobot, robotGet, robotUploadProtocol, assembleProtocolUpload } from '$lib/server/opentrons/proxy';
import { connectDB, OpentronsRobot, AuditLog, generateId } from '$lib/server/db';
import { validUploadedResult, type UploadedProtocolResult } from '$lib/opentrons/ot2-protocol';

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
		// robotGet, not a raw fetch of the robot IP: over the queue on Vercel,
		// direct on the lab LAN (a raw IP fetch can't work from Vercel).
		const res = await robotGet(robot, '/protocols');
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

	// Tailnet line (JSON): the prepare / confirm halves around the browser's upload.
	if ((request.headers.get('content-type') ?? '').includes('application/json')) {
		const body = (await request.json().catch(() => ({}))) as any;
		const fileName = typeof body?.fileName === 'string' ? body.fileName.trim() : '';
		if (!fileName || fileName.length > 255) error(400, 'fileName is required');
		if (body?.phase === 'prepare') {
			if (typeof body.fileB64 !== 'string' || !body.fileB64) error(400, 'fileB64 is required');
			try {
				const bytes = new Uint8Array(Buffer.from(body.fileB64, 'base64'));
				return json({ bundle: await assembleProtocolUpload(robot, fileName, bytes) });
			} catch (e) {
				console.error('[API] upload protocol prepare error:', e instanceof Error ? e.message : e);
				error(502, e instanceof Error ? e.message : 'Failed to prepare protocol upload');
			}
		}
		if (body?.phase === 'confirm') {
			const uploaded = validUploadedResult(body.uploaded);
			if (!uploaded) error(400, 'upload result is malformed');
			return recordUpload(params.id, fileName, uploaded, locals.user, 'tailnet');
		}
		error(400, "phase must be 'prepare' or 'confirm'");
	}

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

	return recordUpload(params.id, fileName, uploaded, locals.user, 'queue');
};

/** The BIMS half of an upload: upsert the robot's protocols[] entry + AuditLog. */
async function recordUpload(
	robotId: string,
	fileName: string,
	uploaded: UploadedProtocolResult,
	user: { _id: string; username: string },
	line: 'queue' | 'tailnet'
): Promise<Response> {
	await connectDB();
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
		uploadedBy: user.username,
		createdAt: new Date(),
		updatedAt: new Date()
	};

	// Upsert into the robot's embedded protocols[] — replace any prior entry with
	// the same robot-assigned protocol id, then push the fresh one.
	await OpentronsRobot.updateOne(
		{ _id: robotId },
		{ $pull: { protocols: { opentronsProtocolId: uploaded.opentronsProtocolId } } }
	);
	await OpentronsRobot.updateOne(
		{ _id: robotId },
		{ $push: { protocols: entry } }
	);

	await AuditLog.create({
		_id: generateId(),
		action: 'upload',
		resourceType: 'opentrons_protocol',
		resourceId: uploaded.opentronsProtocolId,
		userId: user._id,
		username: user.username,
		timestamp: new Date(),
		details: { robotId, protocolName: fileName, protocolType, analysisStatus: uploaded.analysisStatus, line }
	});

	return json({
		data: {
			opentronsProtocolId: uploaded.opentronsProtocolId,
			protocolName: fileName,
			protocolType,
			analysisStatus: uploaded.analysisStatus
		}
	}, { status: 201 });
}
