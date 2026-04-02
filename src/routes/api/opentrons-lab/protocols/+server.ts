/**
 * GET  /api/opentrons-lab/protocols — List all protocols from MongoDB
 * POST /api/opentrons-lab/protocols — Upload protocol file, store in MongoDB
 */
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { connectDB, OpentronProtocol, generateId } from '$lib/server/db';
import { requirePermission } from '$lib/server/permissions';
import crypto from 'crypto';

export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.user) return json({ error: 'Unauthorized' }, { status: 401 });
	requirePermission(locals.user, 'manufacturing:read');

	await connectDB();
	const protocols = await OpentronProtocol.find({ isActive: true })
		.sort({ updatedAt: -1 })
		.lean();

	return json({ data: JSON.parse(JSON.stringify(protocols)) });
};

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) return json({ error: 'Unauthorized' }, { status: 401 });
	requirePermission(locals.user, 'manufacturing:write');

	await connectDB();

	const formData = await request.formData();
	const file = formData.get('file') as File | null;
	const protocolName = formData.get('protocolName')?.toString();
	const processType = formData.get('processType')?.toString() || 'other';
	const description = formData.get('description')?.toString() || '';
	const tags = formData.get('tags')?.toString();

	if (!file || !protocolName) {
		return json({ error: 'file and protocolName are required' }, { status: 400 });
	}

	const fileContent = await file.text();
	const fileHash = crypto.createHash('sha256').update(fileContent).digest('hex');

	// Check for duplicate by hash
	const existing = await OpentronProtocol.findOne({ fileHash, isActive: true }).lean();
	if (existing) {
		return json({
			error: 'Duplicate protocol file already exists',
			existingId: (existing as any)._id,
		}, { status: 409 });
	}

	const protocol = await OpentronProtocol.create({
		_id: generateId(),
		protocolName,
		description,
		processType,
		fileName: file.name,
		fileHash,
		fileContent,
		tags: tags ? tags.split(',').map(t => t.trim()) : [],
		uploadedBy: locals.user.username,
	});

	return json({ data: JSON.parse(JSON.stringify(protocol)) }, { status: 201 });
};
