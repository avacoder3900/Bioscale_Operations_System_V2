/**
 * POST /api/cv/process-image
 *
 * Triggers server-side LIZA image processing on a previously uploaded image.
 * Proxies to the Python CV worker's /process-image endpoint.
 */
import { json, error } from '@sveltejs/kit';
import { connectDB } from '$lib/server/db/connection.js';
import { CvImage } from '$lib/server/db/models/cv-image.js';
import { processImage } from '$lib/server/services/cv-bridge';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) throw error(401, 'Unauthorized');

	const { imageId, mode, params } = await request.json();
	if (!imageId) return json({ error: 'imageId is required' }, { status: 400 });

	await connectDB();
	const image = await CvImage.findById(imageId).lean() as any;
	if (!image) return json({ error: 'Image not found' }, { status: 404 });

	const ext = image.filePath.split('.').pop() || 'jpg';
	const basePath = image.filePath.replace(`.${ext}`, '');
	const outputKey = `${basePath}_proc.png`;

	try {
		const result = await processImage(
			image.filePath,
			outputKey,
			mode || 'full',
			params
		);

		await CvImage.findByIdAndUpdate(imageId, {
			processedPath: outputKey,
			processingMode: mode || 'full',
			processingParams: params || {
				redCorrection: 0.85,
				greenCorrection: 0.90,
				blueCorrection: 1.0,
				claheStrength: 2.0,
				gamma: 0.85
			},
			processedAt: new Date()
		});

		return json({ data: result });
	} catch (err: any) {
		return json({ error: err.message || 'Processing failed' }, { status: 502 });
	}
};
