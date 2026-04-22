import { json, error } from '@sveltejs/kit';
import { connectDB } from '$lib/server/db/connection.js';
import { CvImage } from '$lib/server/db/models/cv-image.js';
import { CvProject } from '$lib/server/db/models/cv-project.js';
import { CartridgeRecord } from '$lib/server/db/models/cartridge-record.js';
import { generateId } from '$lib/server/db/utils.js';
import { getR2Url } from '$lib/server/services/r2';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) throw error(401, 'Unauthorized');
	await connectDB();

	const { projectId, key, filename, contentType, fileSize, cartridgeTag } = await request.json();
	if (!projectId || !key || !filename) {
		return json({ error: 'projectId, key, and filename are required' }, { status: 400 });
	}

	const project = await CvProject.findById(projectId);
	if (!project) return json({ error: 'Project not found' }, { status: 404 });

	const publicUrl = getR2Url(key);

	const imageData: Record<string, any> = {
		_id: generateId(),
		projectId,
		filename,
		filePath: key,
		fileSizeBytes: fileSize || 0,
		capturedAt: new Date(),
		imageUrl: publicUrl
	};

	if (cartridgeTag) {
		imageData.cartridgeTag = cartridgeTag;
	}

	const image = await CvImage.create(imageData);

	await CvProject.findByIdAndUpdate(projectId, { $inc: { imageCount: 1 } });

	// Push photo reference to cartridge record (stores only the ref, not the image)
	if (cartridgeTag?.cartridgeRecordId) {
		await CartridgeRecord.updateOne(
			{ _id: cartridgeTag.cartridgeRecordId },
			{ $push: { photos: {
				imageId: image._id,
				phase: cartridgeTag.phase || null,
				capturedAt: image.capturedAt,
				r2Key: key,
				r2Url: publicUrl
			}}}
		);
	}

	return json({ data: JSON.parse(JSON.stringify(image)) }, { status: 201 });
};
