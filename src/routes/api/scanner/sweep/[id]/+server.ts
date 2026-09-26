/**
 * GET  /api/scanner/sweep/<id>            — current snapshot for polling
 * POST /api/scanner/sweep/<id>            — control: { action: 'cancel' | 'pause' | 'resume' }
 *
 * TAILNET LINE (OT2-TAILNET-5 S6) — only for a SweepRun the tailnet prepare
 * created (doc.line === 'tailnet'); a queue SweepRun is handled exactly as before:
 *   - pause / resume set the same flags + log (the daemon ORs them with its
 *     /bridge control flags on every progress report);
 *   - cancel terminal-izes the run the same way, but there is no queue command
 *     to expire and the maintenance-run close is NOT relayed through the queue:
 *     the daemon closes its own run when it stops (the browser also cancels the
 *     /bridge job directly);
 *   - { action: 'abandon', line: 'tailnet', jobId, error } — the browser's
 *     bridge submit failed after the prepare: the SweepRun (never reported on)
 *     is closed 'errored' with the reason, plus AuditLog 'sweep_submit_failed'.
 */

import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requirePermission } from '$lib/server/permissions';
import { connectDB, OpentronsScannerSweepRun, Ot2BridgeCommand, AuditLog, generateId } from '$lib/server/db';
import { getRobot, robotGet } from '$lib/server/opentrons/proxy';
import { closeMaintenanceRun } from '$lib/server/opentrons/maintenance';

// Cancel may relay the maintenance-run close through the command bridge,
// which can take tens of seconds when the daemon is slow to claim.
export const config = { maxDuration: 60 };

// A tailnet sweep with no daemon report after this long is stranded (see GET).
const TAILNET_UNREPORTED_MS = 30 * 60_000;

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
		requestedByUsername: doc.requestedByUsername,
		// Tailnet line only (undefined, so absent from the JSON, on queue runs):
		// lets a page reattach to the daemon job via /bridge/jobs/<bridgeJobId>.
		line: doc.line,
		bridgeJobId: doc.bridgeJobId
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
	if (doc.status === 'running' && doc.line === 'tailnet') {
		// Tailnet line (OT2-TAILNET-5 S6): there is no command to inspect. A run
		// the daemon never reported on within a generous window (it may queue
		// behind a long job on the robot's single worker) was never submitted to
		// /bridge, or never started there — fail it visibly. A daemon that starts
		// it later gets a 409 from the jobs progress route and stops.
		const age = Date.now() - new Date(doc.createdAt ?? doc.startedAt).getTime();
		if (!doc.bridgeLastReportAt && age > TAILNET_UNREPORTED_MS) {
			const now = new Date();
			doc = (await OpentronsScannerSweepRun.findOneAndUpdate(
				{ _id: params.id, status: 'running', bridgeLastReportAt: { $exists: false } },
				{
					$set: {
						status: 'errored',
						completedAt: now,
						abortReason: "The robot's bridge never reported on this sweep — was it submitted over Tailscale?"
					},
					$push: {
						log: {
							ts: now,
							level: 'error',
							message: `No report from the bridge daemon for tailnet job ${doc.bridgeJobId} within ${Math.round(TAILNET_UNREPORTED_MS / 60_000)} min`
						}
					}
				},
				{ new: true }
			).lean()) as any ?? (await OpentronsScannerSweepRun.findById(params.id).lean());
		}
	} else if (doc.status === 'running') {
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
	const tailnetRun = doc.line === 'tailnet';

	if (action === 'abandon' && tailnetRun) {
		// The prepare wrote this run; the browser could not hand the job to the
		// robot's /bridge. Close it now instead of leaving it 'running' until the
		// 30-min unreported sweep check. Refused once the daemon has reported —
		// then the job IS running and only cancel applies.
		const jobId = body?.jobId?.toString() ?? '';
		if (!jobId || jobId !== doc.bridgeJobId) error(400, 'jobId does not match this sweep run');
		if (doc.bridgeLastReportAt) error(409, 'The robot is already running this sweep — cancel it instead.');
		const reason = (typeof body?.error === 'string' && body.error.trim() ? body.error.trim() : 'bridge submit failed').slice(0, 500);
		const now = new Date();
		const closed = await OpentronsScannerSweepRun.findOneAndUpdate(
			{ _id: params.id, status: { $in: ['running', 'paused'] }, bridgeLastReportAt: { $exists: false } },
			{
				$set: { status: 'errored', completedAt: now, abortReason: reason },
				$push: { log: { ts: now, level: 'error', message: `Not started: ${reason}` } }
			},
			{ new: true }
		).lean();
		if (!closed) error(409, 'The sweep changed state — reload it.');
		await AuditLog.create({
			_id: generateId(),
			tableName: 'opentrons_scanner_sweeps',
			recordId: doc.positionSetId,
			action: 'sweep_submit_failed',
			newData: {
				sweepRunId: doc._id,
				robotId: doc.robotId,
				bridgeJobId: jobId,
				line: 'tailnet',
				source: doc.source,
				contextRef: doc.contextRef,
				error: reason
			},
			changedAt: now,
			changedBy: locals.user.username
		});
		return json(pickSnapshot(closed));
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

		if (tailnetRun) {
			// Tailnet line: no Ot2BridgeCommand exists, and the robot cleanup must
			// not ride the queue. The daemon's next report gets a 409 (terminal
			// run) and stops; it closes its maintenance run on the way out.
			await OpentronsScannerSweepRun.findByIdAndUpdate(params.id, {
				$push: {
					log: {
						ts: new Date(),
						level: 'info',
						message: `Tailnet sweep (job ${doc.bridgeJobId}): the robot's bridge daemon stops the walk and closes its maintenance run.`
					}
				}
			});
		}

		// Step 2: expire any live bridge command for this sweep. A dead daemon
		// must not strand the command in the queue (pending), and a daemon that
		// claims/continues it late gets a 409 from the progress endpoint once
		// the command is terminal — so the cancelled sweep can't resurrect.
		if (!tailnetRun) await Ot2BridgeCommand.updateMany(
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
		const robot = tailnetRun ? null : await getRobot(doc.robotId);
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
