/**
 * GET  /api/scanner/sweep/<id>            — current snapshot for polling
 * POST /api/scanner/sweep/<id>            — control: { action: 'cancel' | 'pause' | 'resume' }
 */

import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requirePermission } from '$lib/server/permissions';
import { connectDB, OpentronsScannerSweepRun } from '$lib/server/db';

function pickSnapshot(doc: any) {
	return {
		_id: doc._id,
		robotId: doc.robotId,
		robotName: doc.robotName,
		positionSetId: doc.positionSetId,
		positionSetTitle: doc.positionSetTitle,
		deviceId: doc.deviceId,
		source: doc.source,
		contextRef: doc.contextRef,
		status: doc.status,
		pauseRequested: doc.pauseRequested,
		cancelRequested: doc.cancelRequested,
		slotsTotal: doc.slotsTotal,
		slotsDone: doc.slotsDone,
		currentSlotIndex: doc.currentSlotIndex,
		scans: doc.scans ?? [],
		errors: doc.errors ?? [],
		log: doc.log ?? [],
		startedAt: doc.startedAt,
		completedAt: doc.completedAt,
		abortReason: doc.abortReason,
		requestedByUsername: doc.requestedByUsername
	};
}

export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) error(401, 'Not authenticated');
	requirePermission(locals.user, 'manufacturing:read');
	await connectDB();

	const doc = await OpentronsScannerSweepRun.findById(params.id).lean();
	if (!doc) error(404, 'Sweep run not found');
	return json(pickSnapshot(doc));
};

export const POST: RequestHandler = async ({ params, request, locals }) => {
	if (!locals.user) error(401, 'Not authenticated');
	requirePermission(locals.user, 'manufacturing:write');
	await connectDB();

	const body = await request.json().catch(() => ({} as any));
	const action = body?.action as string | undefined;

	const doc: any = await OpentronsScannerSweepRun.findById(params.id);
	if (!doc) error(404, 'Sweep run not found');
	if (['completed', 'cancelled', 'errored'].includes(doc.status)) {
		error(409, `Sweep is already ${doc.status} — no control action accepted.`);
	}

	if (action === 'cancel') {
		await OpentronsScannerSweepRun.findByIdAndUpdate(params.id, {
			$set: { cancelRequested: true, pauseRequested: false },
			$push: {
				log: {
					ts: new Date(),
					level: 'warn',
					message: `Cancel requested by ${locals.user.username}.`
				}
			}
		});
	} else if (action === 'pause') {
		await OpentronsScannerSweepRun.findByIdAndUpdate(params.id, {
			$set: { pauseRequested: true },
			$push: {
				log: {
					ts: new Date(),
					level: 'info',
					message: `Pause requested by ${locals.user.username}.`
				}
			}
		});
	} else if (action === 'resume') {
		await OpentronsScannerSweepRun.findByIdAndUpdate(params.id, {
			$set: { pauseRequested: false },
			$push: {
				log: {
					ts: new Date(),
					level: 'info',
					message: `Resume requested by ${locals.user.username}.`
				}
			}
		});
	} else {
		error(400, "action must be one of 'cancel', 'pause', 'resume'");
	}

	const updated = await OpentronsScannerSweepRun.findById(params.id).lean();
	return json(pickSnapshot(updated));
};
