/**
 * GET  /api/scanner/sweep/<id>            — current snapshot for polling
 * POST /api/scanner/sweep/<id>            — control: { action: 'cancel' | 'pause' | 'resume' }
 */

import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requirePermission } from '$lib/server/permissions';
import { connectDB, OpentronsScannerSweepRun, OpentronsRobot } from '$lib/server/db';
import { getRobot } from '$lib/server/opentrons/proxy';
import { closeMaintenanceRun } from '$lib/server/opentrons/maintenance';

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
		// Step 1: flip the flags + immediately terminal the sweep doc. Cancel
		// no longer depends on the worker reading the flag between slots —
		// the worker may be wedged inside a hung fetch, in which case waiting
		// for it would mean the cancel button does nothing.
		await OpentronsScannerSweepRun.findByIdAndUpdate(params.id, {
			$set: {
				cancelRequested: true,
				pauseRequested: false,
				status: 'cancelled',
				completedAt: new Date(),
				abortReason: doc.abortReason ?? 'cancelled by operator'
			},
			$push: {
				log: {
					ts: new Date(),
					level: 'warn',
					message: `Cancel requested by ${locals.user.username}.`
				}
			}
		});

		// Step 2: actively close any open maintenance run on the OT-2. Closing
		// the run releases motor holds + unblocks any HTTP call the wedged
		// worker is still waiting on (the OT-2 will respond to subsequent
		// commands with "run not found", which makes the worker throw + exit
		// the try/catch cleanly).
		const robot = await getRobot(doc.robotId);
		if (robot) {
			try {
				const baseUrl = `http://${(robot as any).ip}:${(robot as any).port ?? 31950}`;
				const ac = new AbortController();
				const t = setTimeout(() => ac.abort(), 8_000);
				const cr = await fetch(`${baseUrl}/maintenance_runs/current_run`, {
					headers: { 'opentrons-version': '3' },
					signal: ac.signal
				}).finally(() => clearTimeout(t));
				if (cr.ok) {
					const cb: any = await cr.json();
					const runId = cb?.data?.id;
					if (runId) {
						await closeMaintenanceRun(robot as any, runId).catch((e) => {
							console.warn('[cancel] closeMaintenanceRun failed:', e instanceof Error ? e.message : e);
						});
						await OpentronsScannerSweepRun.findByIdAndUpdate(params.id, {
							$push: {
								log: {
									ts: new Date(),
									level: 'info',
									message: `Closed OT-2 maintenance run ${runId} on cancel.`
								}
							}
						});
					}
				}
			} catch (e) {
				console.warn('[cancel] OT-2 cleanup error:', e instanceof Error ? e.message : e);
				await OpentronsScannerSweepRun.findByIdAndUpdate(params.id, {
					$push: {
						log: {
							ts: new Date(),
							level: 'warn',
							message: `OT-2 cleanup on cancel failed: ${e instanceof Error ? e.message : String(e)}`
						}
					}
				});
			}
		}
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
