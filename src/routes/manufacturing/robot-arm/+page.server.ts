/**
 * Robot Arm — landing page.
 * Read-only Phase A: registered arms, recent runs, dataset count.
 */
import { redirect } from '@sveltejs/kit';
import { connectDB } from '$lib/server/db/connection';
import { RobotArm, RobotArmRun, RobotArmDataset } from '$lib/server/db/models';
import { requirePermission } from '$lib/server/permissions';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) redirect(302, '/login');
	requirePermission(locals.user, 'manufacturing:read');
	await connectDB();

	const [arms, recentRuns, datasetCount] = await Promise.all([
		RobotArm.find({ isActive: true })
			.select('_id role serialNumber comPort modelName voltage firmwareVersion')
			.sort({ role: 1 })
			.lean(),
		RobotArmRun.find({})
			.select('_id runId type status startedAt endedAt triggeredBy parameters')
			.sort({ createdAt: -1 })
			.limit(10)
			.lean(),
		RobotArmDataset.countDocuments({})
	]);

	return {
		arms: JSON.parse(JSON.stringify(arms)),
		recentRuns: JSON.parse(JSON.stringify(recentRuns)),
		datasetCount
	};
};
