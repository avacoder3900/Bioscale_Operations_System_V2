/**
 * Scanner sweep run history.
 *
 * Lists recent OpentronsScannerSweepRun documents — every Scan Cartridges
 * invocation across all robots. Supports filtering by robot and status,
 * and pre-loads the full detail of a single sweep if ?selected=<id> is set.
 */

import { redirect, error as svelteError } from '@sveltejs/kit';
import {
	connectDB,
	OpentronsRobot,
	OpentronsScannerSweepRun
} from '$lib/server/db';
import { requirePermission } from '$lib/server/permissions';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, url }) => {
	if (!locals.user) redirect(302, '/login');
	requirePermission(locals.user, 'manufacturing:read');

	await connectDB();

	const robotFilter = url.searchParams.get('robot')?.trim() || null;
	const statusFilter = url.searchParams.get('status')?.trim() || null;
	const selectedId = url.searchParams.get('selected')?.trim() || null;

	const robots = (await OpentronsRobot.find({})
		.select('_id name')
		.sort({ name: 1 })
		.lean()) as any[];

	const filter: any = {};
	if (robotFilter) filter.robotId = robotFilter;
	if (statusFilter) filter.status = statusFilter;

	const docs = (await OpentronsScannerSweepRun.find(filter)
		.select(
			'_id robotId robotName positionSetTitle status slotsTotal slotsDone scans errors source contextRef startedAt completedAt requestedByUsername abortReason'
		)
		.sort({ startedAt: -1 })
		.limit(50)
		.lean()) as any[];

	const items = docs.map((d) => ({
		_id: d._id,
		robotId: d.robotId,
		robotName: d.robotName,
		positionSetTitle: d.positionSetTitle,
		status: d.status,
		slotsTotal: d.slotsTotal,
		slotsDone: d.slotsDone,
		scanCount: (d.scans ?? []).length,
		errorCount: (d.errors ?? []).length,
		source: d.source,
		contextRef: d.contextRef,
		startedAt: d.startedAt,
		completedAt: d.completedAt,
		durationSec:
			d.completedAt && d.startedAt
				? Math.round(
						(new Date(d.completedAt).getTime() - new Date(d.startedAt).getTime()) / 1000
					)
				: null,
		requestedByUsername: d.requestedByUsername,
		abortReason: d.abortReason
	}));

	let selected: any = null;
	if (selectedId) {
		const full = (await OpentronsScannerSweepRun.findById(selectedId).lean()) as any;
		if (!full) svelteError(404, 'Sweep run not found');
		selected = JSON.parse(JSON.stringify(full));
	}

	return {
		items: JSON.parse(JSON.stringify(items)),
		robots: robots.map((r) => ({ _id: String(r._id), name: r.name as string })),
		filter: { robotId: robotFilter, status: statusFilter, selectedId },
		selected
	};
};
