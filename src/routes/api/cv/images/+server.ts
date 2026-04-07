import { json, error } from '@sveltejs/kit';
import { connectDB } from '$lib/server/db/connection.js';
import { CvImage } from '$lib/server/db/models/cv-image.js';
import { CvProject } from '$lib/server/db/models/cv-project.js';
import { generateId } from '$lib/server/db/utils.js';
import { uploadToR2, generateThumbnail, getR2Url } from '$lib/server/services/r2';
import { buildDhrKey } from '$lib/server/r2.js';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) throw error(401, 'Unauthorized');
	await connectDB();

	try {
		const formData = await request.formData();
		const file = formData.get('file') as File | null;
		const projectId = formData.get('projectId')?.toString();
		const sampleId = formData.get('sampleId')?.toString();
		const cameraIndex = formData.get('cameraIndex')?.toString();
		const cartridgeRecordId = formData.get('cartridgeRecordId')?.toString();
		const phase = formData.get('phase')?.toString();

		if (!file) return json({ error: 'file is required' }, { status: 400 });
		if (!projectId) return json({ error: 'projectId is required' }, { status: 400 });

		const project = await CvProject.findById(projectId);
		if (!project) return json({ error: 'Project not found' }, { status: 404 });

		const buffer = Buffer.from(await file.arrayBuffer());
		const id = generateId();
		const ext = file.name.split('.').pop() || 'jpg';

		// Use DHR folder structure if cartridge ID is provided
		let key: string;
		let thumbKey: string;
		if (cartridgeRecordId) {
			key = buildDhrKey(projectId, cartridgeRecordId, phase || 'untagged', `${id}.${ext}`);
			thumbKey = `cv/${projectId}/dhr/${cartridgeRecordId}/${phase || 'untagged'}/thumbs/${id}.jpg`;
		} else {
			key = `cv/${projectId}/${id}.${ext}`;
			thumbKey = `cv/${projectId}/thumbs/${id}.jpg`;
		}

		// Upload original
		const imageUrl = await uploadToR2(buffer, key, file.type || 'image/jpeg');

		// Generate and upload thumbnail
		let thumbnailPath: string | undefined;
		try {
			const thumbBuffer = await generateThumbnail(buffer);
			await uploadToR2(thumbBuffer, thumbKey, 'image/jpeg');
			thumbnailPath = thumbKey;
		} catch {
			// thumbnail generation is best-effort
		}

		const imageData: Record<string, any> = {
			_id: id,
			sampleId: sampleId || undefined,
			projectId,
			filename: file.name,
			filePath: key,
			thumbnailPath,
			fileSizeBytes: buffer.length,
			cameraIndex: cameraIndex ? parseInt(cameraIndex) : undefined,
			capturedAt: new Date(),
			imageUrl
		};

		// Tag with cartridge if provided
		if (cartridgeRecordId) {
			imageData.cartridgeTag = {
				cartridgeRecordId,
				phase: phase || 'untagged'
			};
		}

		const image = await CvImage.create(imageData);

		await CvProject.findByIdAndUpdate(projectId, { $inc: { imageCount: 1 } });

		// Push photo ref to cartridge record if tagged
		if (cartridgeRecordId) {
			const { CartridgeRecord } = await import('$lib/server/db/models/cartridge-record.js');
			await CartridgeRecord.updateOne(
				{ _id: cartridgeRecordId },
				{ $push: { photos: {
					imageId: id,
					r2Key: key,
					phase: phase || 'untagged',
					capturedAt: image.capturedAt
				}}}
			);
		}

		return json({ data: JSON.parse(JSON.stringify(image)) }, { status: 201 });
	} catch (err: any) {
		console.error('[CV Image Upload Error]', err);
		return json({ error: err.message }, { status: 500 });
	}
};
