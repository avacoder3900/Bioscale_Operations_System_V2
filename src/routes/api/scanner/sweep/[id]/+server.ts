/**
 * GET  /api/scanner/sweep/<id>            — current snapshot for polling
 * POST /api/scanner/sweep/<id>            — control: { action: 'cancel' | 'pause' | 'resume' }
 */

import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requirePermission } from '$lib/server/permissions';
import { connectDB, OpentronsScannerSweepRun, Ot2BridgeCommand } from '$lib/server/db';
import { getRobot, robotGet } from '$lib/server/opentrons/proxy';
import { closeMaintenanceRun } from '$lib/server/opentrons/maintenance';

// Cancel may relay the maintenance-run close through the command bridge,
// which can take tens of seconds when the daemon is slow to claim.
export const config = { maxDuration: 60 };

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

	let doc = await OpentronsScannerSweepRun.findById(params.id).lean() as any;
	if (!doc) error(404, 'Sweep run not found');

	// Lazy liveness check (OT2-BRIDGE-2): commands only get expired when a
	// daemon polls or a caller waits — a sweep has neither, so a dead daemon
	// would leave the run "running" forever. The UI polls this snapshot, so
	// detect the stranded command here and fail the run visibly.
	if (doc.status === 'running') {
		const cmd = await Ot2BridgeCommand.findOne({ kind: 'sweep', 'payload.sweepRunId': params.id })
			.sort({ createdAt: -1 }).select('status createdAt ttlMs').lean() as any;
		const overdue = cmd?.status === 'pending'
			&& Date.now() - new Date(cmd.createdAt).getTime() > (cmd.ttlMs ?? 120_000);
		if (cmd && (cmd.status === 'expired' || cmd.status === 'failed' || overdue)) {
			const now = new Date();
			if (overdue) {
				await Ot2BridgeCommand.updateOne(
					{ _id: cmd._id, status: 'pending' },
					{ $set: { status: 'expired', error: 'Never claimed by bridge daemon', completedAt: now } }
				);
			}
			doc = await OpentronsScannerSweepRun.findByIdAndUpdate(params.id, {
				$set: {
					status: 'errored',
					completedAt: now,
					abortReason: 'Bridge daemon did not pick up the sweep — is the robot\'s bridge online?'
				},
				$push: { log: { ts: now, level: 'error', message: 'Sweep command was never claimed by the bridge daemon' } }
			}, { new: true }).lean() as any;
		}
	}

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

		// Step 2: expire any live bridge command for this sweep. A dead daemon
		// must not strand the command in the queue (pending), and a daemon that
		// claims/continues it late gets a 409 from the progress endpoint once
		// the command is terminal — so the cancelled sweep can't resurrect.
		await Ot2BridgeCommand.updateMany(
			{
				kind: 'sweep',
				status: { $in: ['pending', 'claimed'] },
				'payload.sweepRunId': params.id
			},
			{
				$set: {
					status: 'expired',
					error: `Sweep cancelled by ${locals.user.username}`,
					completedAt: new Date()
				}
			}
		).catch((e) => {
			console.warn('[cancel] expiring sweep command failed:', e instanceof Error ? e.message : e);
		});

		// Step 3: actively close any open maintenance run on the OT-2 — the
		// wedge fallback. Closing the run releases motor holds + makes any
		// in-flight motion command on a wedged daemon fail fast ("run not
		// found"). robotGet/closeMaintenanceRun are transport-aware, so this
		// works both direct (lab LAN) and via kind:'http' bridge commands.
		const robot = await getRobot(doc.robotId);
		if (robot) {
			try {
				const cr = await robotGet(robot as any, '/maintenance_runs/current_run');
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
