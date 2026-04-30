/**
 * Master CV Model — single project trained on labeled images aggregated
 * across every CvProject. Provides the unified pass/fail criterion for
 * cartridge photos via project.confidenceThreshold.
 */
import { fail, redirect } from '@sveltejs/kit';
import { connectDB } from '$lib/server/db/connection.js';
import { CvProject } from '$lib/server/db/models/cv-project.js';
import { CvImage } from '$lib/server/db/models/cv-image.js';
import { CvInspection } from '$lib/server/db/models/cv-inspection.js';
import { generateId } from '$lib/server/db/utils.js';
import { getR2Url } from '$lib/server/services/r2';
import type { Actions, PageServerLoad } from './$types';

const MASTER_DEFAULT_NAME = 'Master Cartridge Inspector';
const MASTER_DEFAULT_PURPOSE = 'Unified anomaly-detection model trained on labeled photos from every per-phase project. Pass/fail decisions for cartridge photos go through this model.';

async function findOrCreateMaster() {
	let master = await CvProject.findOne({ isMasterModel: true });
	if (!master) {
		master = await CvProject.create({
			_id: generateId(),
			name: MASTER_DEFAULT_NAME,
			description: 'Aggregator project that trains on labeled images from all other projects.',
			purpose: MASTER_DEFAULT_PURPOSE,
			projectType: 'anomaly_detection',
			isMasterModel: true,
			confidenceThreshold: 0.5,
			tags: ['master', 'aggregator']
		});
	}
	return master;
}

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) redirect(302, '/login');
	await connectDB();

	const master = await findOrCreateMaster();

	// Per-project label tallies across the entire fleet.
	const perProject = await CvImage.aggregate([
		{ $group: {
			_id: { projectId: '$projectId', label: '$label' },
			count: { $sum: 1 }
		} }
	]);

	const projectIds = [...new Set(perProject.map((r: any) => r._id.projectId).filter(Boolean))];
	const projects = await CvProject.find({ _id: { $in: projectIds } }).select('_id name modelStatus').lean();
	const projectMap = new Map((projects as any[]).map(p => [p._id, p]));

	const projectStats = projectIds.map(pid => {
		const rows = perProject.filter((r: any) => r._id.projectId === pid);
		const tally = (label: string | null) =>
			rows.find((r: any) => (r._id.label ?? null) === label)?.count ?? 0;
		const proj = projectMap.get(pid) as any;
		return {
			projectId: pid,
			name: proj?.name ?? pid,
			modelStatus: proj?.modelStatus ?? 'unknown',
			approved: tally('approved'),
			rejected: tally('rejected'),
			unlabeled: tally(null),
			isMaster: pid === master._id
		};
	}).sort((a, b) => (b.approved + b.rejected) - (a.approved + a.rejected));

	const totals = projectStats.reduce((acc, p) => ({
		approved: acc.approved + p.approved,
		rejected: acc.rejected + p.rejected,
		unlabeled: acc.unlabeled + p.unlabeled
	}), { approved: 0, rejected: 0, unlabeled: 0 });

	// Newest 24 labeled images across the fleet — the training-set preview.
	const recentLabeled = await CvImage.find({ label: { $ne: null } })
		.sort({ updatedAt: -1 })
		.limit(24)
		.select('_id projectId label filePath imageUrl thumbnailPath capturedAt cartridgeTag')
		.lean();
	const labeledPreview = (recentLabeled as any[]).map(img => ({
		imageId: img._id,
		projectId: img.projectId,
		projectName: (projectMap.get(img.projectId) as any)?.name ?? img.projectId,
		label: img.label,
		url: img.imageUrl || (img.filePath ? getR2Url(img.filePath) : null),
		thumbnailUrl: img.thumbnailPath ? getR2Url(img.thumbnailPath) : (img.imageUrl || (img.filePath ? getR2Url(img.filePath) : null)),
		capturedAt: img.capturedAt,
		cartridgeRecordId: img.cartridgeTag?.cartridgeRecordId ?? null,
		phase: img.cartridgeTag?.phase ?? null
	}));

	// Recent inspections produced by the master model (post-training).
	const recentInspections = await CvInspection.find({ projectId: master._id })
		.sort({ createdAt: -1 })
		.limit(20)
		.lean();

	return {
		master: JSON.parse(JSON.stringify(master)),
		totals,
		projectStats: JSON.parse(JSON.stringify(projectStats)),
		labeledPreview: JSON.parse(JSON.stringify(labeledPreview)),
		recentInspections: JSON.parse(JSON.stringify(recentInspections))
	};
};

export const actions: Actions = {
	updateConfig: async ({ request, locals }) => {
		if (!locals.user) return fail(401, { error: 'Unauthorized' });
		await connectDB();

		const data = await request.formData();
		const purpose = data.get('purpose')?.toString().trim() ?? '';
		const thresholdRaw = data.get('confidenceThreshold')?.toString() ?? '';
		const name = data.get('name')?.toString().trim();

		const threshold = Number.parseFloat(thresholdRaw);
		if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
			return fail(400, { error: 'confidenceThreshold must be between 0 and 1' });
		}

		const master = await findOrCreateMaster();
		await CvProject.updateOne(
			{ _id: master._id },
			{
				$set: {
					purpose,
					confidenceThreshold: threshold,
					...(name ? { name } : {})
				}
			}
		);

		return { success: true };
	}
};

export const config = { maxDuration: 60 };
