/**
 * POST /api/cv/capture-ingest
 *
 * Agent-keyed multipart upload from the Python capture scripts (camera_capture.py).
 * Uploads the image to R2, creates a CvImage doc with cartridgeTag, and
 * mirrors the link onto CartridgeRecord.photos[] when the cartridge exists.
 *
 * This is the bench/Python equivalent of the browser presign+record flow; both
 * end up writing the same shape so DHR/search/lookup-cartridge resolve photos
 * consistently.
 */
import { json, error } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { connectDB } from '$lib/server/db/connection.js';
import { CvImage } from '$lib/server/db/models/cv-image.js';
import { CvProject } from '$lib/server/db/models/cv-project.js';
import { CartridgeRecord } from '$lib/server/db/models/cartridge-record.js';
import { AuditLog } from '$lib/server/db/models/audit-log.js';
import { generateId } from '$lib/server/db/utils.js';
import { uploadToR2, getR2Url, buildCvNamedKey } from '$lib/server/services/r2';
import { requireAgentApiKey } from '$lib/server/api-auth';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ request }) => {
	requireAgentApiKey(request);
	await connectDB();

	const formData = await request.formData();
	const file = formData.get('file') as File | null;
	const qrCode = formData.get('qrCode')?.toString().trim();
	const phase = formData.get('phase')?.toString().trim() || 'wax_filled';
	const cameraIndexRaw = formData.get('cameraIndex')?.toString();
	const processingMode = formData.get('processingMode')?.toString() as 'full' | 'raw' | undefined;
	const projectIdInput = formData.get('projectId')?.toString().trim();

	if (!file) return json({ error: 'file is required' }, { status: 400 });
	if (!qrCode) return json({ error: 'qrCode is required' }, { status: 400 });

	const projectId = projectIdInput || env.CV_DEFAULT_PROJECT_ID;
	if (!projectId) {
		return json({ error: 'projectId is required (or set CV_DEFAULT_PROJECT_ID)' }, { status: 400 });
	}

	const project = await CvProject.findById(projectId).lean() as any;
	if (!project) return json({ error: 'Project not found' }, { status: 404 });

	const buffer = Buffer.from(await file.arrayBuffer());
	const id = generateId();
	const filename = file.name || `cartridge_${qrCode}_${id}.png`;
	const key = buildCvNamedKey(project.name, id, filename);
	const contentType = file.type || 'image/png';

	await uploadToR2(buffer, key, contentType);
	const publicUrl = getR2Url(key);

	const capturedAt = new Date();
	const image = await CvImage.create({
		_id: id,
		projectId,
		filename,
		filePath: key,
		fileSizeBytes: buffer.length,
		cameraIndex: cameraIndexRaw ? Number.parseInt(cameraIndexRaw, 10) : undefined,
		capturedAt,
		imageUrl: publicUrl,
		processingMode: processingMode === 'raw' || processingMode === 'full' ? processingMode : undefined,
		cartridgeTag: { cartridgeRecordId: qrCode, phase }
	});

	await CvProject.findByIdAndUpdate(projectId, { $inc: { imageCount: 1 } });

	const cartridge = await CartridgeRecord.findById(qrCode).select('_id').lean();
	if (cartridge) {
		await CartridgeRecord.updateOne(
			{ _id: qrCode },
			{ $push: { photos: { imageId: id, phase, capturedAt, r2Key: key, r2Url: publicUrl } } }
		);
	}

	await AuditLog.create({
		_id: generateId(),
		tableName: 'cv_images',
		recordId: id,
		action: 'INSERT',
		newData: { source: 'capture-ingest', cartridgeRecordId: qrCode, phase, key, processingMode },
		changedAt: capturedAt,
		changedBy: 'cv-capture-agent',
		reason: 'capture-ingest'
	});

	return json({
		imageId: id,
		key,
		cartridgeRecordId: cartridge ? qrCode : null,
		cartridgeLinked: !!cartridge,
		phase
	}, { status: 201 });
};
