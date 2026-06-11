/**
 * Robot Arm — single-run detail page.
 * Read-only: header, parameters, result, full event timeline.
 */
import { error, redirect } from '@sveltejs/kit';
import { connectDB } from '$lib/server/db/connection';
import { RobotArmRun, RobotArmDataset } from '$lib/server/db/models';
import { requirePermission } from '$lib/server/permissions';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, params }) => {
	if (!locals.user) redirect(302, '/login');
	requirePermission(locals.user, 'manufacturing:read');
	await connectDB();

	const run = await RobotArmRun.findById(params.id).lean();
	if (!run) throw error(404, 'Run not found');

	const dataset =
		run.type === 'record'
			? await RobotArmDataset.findOne({ sourceRunId: run._id })
					.select('_id name path frames durationS rateHz')
					.lean()
			: null;

	return {
		run: JSON.parse(JSON.stringify(run)),
		dataset: dataset ? JSON.parse(JSON.stringify(dataset)) : null
	};
};
