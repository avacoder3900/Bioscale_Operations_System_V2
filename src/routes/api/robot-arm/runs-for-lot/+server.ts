/**
 * GET /api/robot-arm/runs-for-lot?lotId=LOT-XYZ
 *
 * Returns every RobotArmRun tagged with that lotId, newest first, plus the
 * Pi-side recording sidecar (meta) for each — so a single fetch gives the
 * UI both the BIMS run record AND the on-disk recording metadata for any
 * arm activity that touched the lot.
 *
 * Recording match strategy:
 *   1. Pi lists recordings (with .meta sidecars).
 *   2. We join by sidecar.run_id === run.runId when available; otherwise by
 *     sidecar.lot_id === lotId as a coarse fallback.
 *   3. Pi unreachable → returns the BIMS data with recordings: [], rather
 *     than 500ing. The endpoint is for inspection, not transactions.
 */

import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { connectDB } from '$lib/server/db/connection';
import { RobotArmRun } from '$lib/server/db/models';
import { robotArm, type RecordingMeta } from '$lib/server/robot-arm-client';
import { requirePermission } from '$lib/server/permissions';

export const GET: RequestHandler = async ({ url, locals }) => {
	if (!locals.user) throw error(401, 'Unauthorized');
	requirePermission(locals.user, 'manufacturing:read');

	const lotId = url.searchParams.get('lotId')?.trim();
	if (!lotId) return json({ error: 'lotId query param is required' }, { status: 400 });

	await connectDB();

	const runs = (await RobotArmRun.find({ lotId })
		.sort({ createdAt: -1 })
		.limit(200)
		.select('runId type status startedAt endedAt manufacturingStep recordedDuringRunId triggeredBy result')
		.lean()) as Array<{
		runId: string;
		type: string;
		status: string;
		startedAt?: Date;
		endedAt?: Date;
		manufacturingStep?: string;
		recordedDuringRunId?: string;
		triggeredBy?: { _id?: string; username?: string };
		result?: unknown;
	}>;

	let recordings: RecordingMeta[] = [];
	let piError: string | null = null;
	try {
		const r = await robotArm.listRecordings();
		recordings = r.recordings;
	} catch (err) {
		piError = (err as Error).message;
	}

	const matchedRecordings = recordings.filter((rec) => {
		const meta = rec.meta;
		if (!meta) return false;
		if (meta.lot_id && meta.lot_id === lotId) return true;
		if (meta.run_id && runs.some((r) => r.runId === meta.run_id)) return true;
		return false;
	});

	return json({
		lotId,
		runs: runs.map((r) => ({
			runId: r.runId,
			type: r.type,
			status: r.status,
			startedAt: r.startedAt ?? null,
			endedAt: r.endedAt ?? null,
			manufacturingStep: r.manufacturingStep ?? null,
			recordedDuringRunId: r.recordedDuringRunId ?? null,
			operator: r.triggeredBy?.username ?? null,
			result: r.result ?? null
		})),
		recordings: matchedRecordings,
		piError
	});
};
