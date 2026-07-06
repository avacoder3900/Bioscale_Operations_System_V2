/**
 * GET /api/cv/projects/[id]/images — the project's photo pool.
 *
 * A project owns no images. Its pool is derived: every cartridge_records
 * photos[] entry whose phase is in the project's phases[]. Optional ?qcLabel=
 * (approved | rejected | unlabeled) narrows by human QC verdict.
 */
import { json, error } from '@sveltejs/kit';
import { connectDB } from '$lib/server/db/connection.js';
import { CvProject } from '$lib/server/db/models/cv-project.js';
import { CartridgeRecord } from '$lib/server/db/models/cartridge-record.js';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ params, url, locals }) => {
	if (!locals.user) throw error(401, 'Unauthorized');
	await connectDB();

	const project = await CvProject.findById(params.id).select('phases').lean() as any;
	if (!project) return json({ error: 'Project not found' }, { status: 404 });

	const phases: string[] = Array.isArray(project.phases) ? project.phases : [];
	if (phases.length === 0) return json({ data: [], total: 0 });

	const qcLabel = url.searchParams.get('qcLabel');
	const limit = Math.min(parseInt(url.searchParams.get('limit') || '200'), 500);

	// Photo-entry match: always scope to the project's phases. qcLabel filter:
	// 'unlabeled' → qcLabel is null/absent; 'approved'/'rejected' → exact match.
	const photoMatch: Record<string, unknown> = { 'photos.phase': { $in: phases } };
	if (qcLabel === 'approved' || qcLabel === 'rejected') {
		photoMatch['photos.qcLabel'] = qcLabel;
	} else if (qcLabel === 'unlabeled') {
		photoMatch['photos.qcLabel'] = null;
	}

	const rows = await CartridgeRecord.aggregate([
		{ $match: { 'photos.phase': { $in: phases } } },
		{ $unwind: '$photos' },
		{ $match: photoMatch },
		{ $sort: { 'photos.capturedAt': -1 } },
		{ $limit: limit },
		{
			$project: {
				_id: 0,
				imageId: '$photos.imageId',
				cartridgeRecordId: '$_id',
				phase: '$photos.phase',
				r2Url: '$photos.r2Url',
				qcLabel: '$photos.qcLabel',
				labels: '$photos.labels',
				notes: '$photos.notes',
				capturedAt: '$photos.capturedAt',
				cartridgeImageNumber: '$photos.cartridgeImageNumber'
			}
		}
	]);

	return json({ data: JSON.parse(JSON.stringify(rows)), total: rows.length });
};
