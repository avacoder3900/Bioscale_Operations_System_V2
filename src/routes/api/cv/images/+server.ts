import { json, error } from '@sveltejs/kit';
import { connectDB } from '$lib/server/db/connection.js';
import { CvImage } from '$lib/server/db/models/cv-image.js';
import { CvProject } from '$lib/server/db/models/cv-project.js';
import { generateId } from '$lib/server/db/utils.js';
import { uploadToR2, generateThumbnail, getR2Url } from '$lib/server/services/r2';
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

		if (!file) return json({ error: 'file is required' }, { status: 400 });
		if (!projectId) return json({ error: 'projectId is required' }, { status: 400 });

		const project = await CvProject.findById(projectId);
		if (!project) return json({ error: 'Project not found' }, { status: 404 });

		const buffer = Buffer.from(await file.arrayBuffer());
		const id = generateId();
		const ext = file.name.split('.').pop() || 'jpg';
		const key = `cv/${projectId}/${id}.${ext}`;
		const thumbKey = `cv/${projectId}/thumbs/${id}.jpg`;

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

		const image = await CvImage.create({
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
		});

		await CvProject.findByIdAndUpdate(projectId, { $inc: { imageCount: 1 } });

		return json({ data: JSON.parse(JSON.stringify(image)) }, { status: 201 });
	} catch (err: any) {
		return json({ error: err.message }, { status: 500 });
	}
};
