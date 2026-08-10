/**
 * ARM-WAX-01 orchestration — guarded transitions for ArmWaxFillRun.
 *
 * Every transition re-checks hardware state at the moment of the call
 * (arm session via the Pi FastAPI, OT-2 run state via the opentrons proxy,
 * which transparently uses the ot2-bridge on Vercel). The invariant:
 *
 *     the arm and the OT-2 gantry NEVER hold the deck token at once.
 *
 * v1 is operator-paced: each step is triggered from the run page, the
 * server verifies the world agrees before flipping the phase. The same
 * functions are callable from agent endpoints later for full automation.
 */
import {
	connectDB,
	ArmWaxFillRun,
	CartridgeRecord,
	AuditLog,
	generateId
} from '$lib/server/db';
import { DECK_TOKEN, NEXT_PHASE, TERMINAL_PHASES } from '$lib/server/db/models/arm-wax-fill-run';
import type { ArmWaxPhase } from '$lib/server/db/models/arm-wax-fill-run';
import { robotArm } from '$lib/server/robot-arm-client';
import { getRobot, robotGet, robotPost, forwardResponse } from '$lib/server/opentrons/proxy';

// Names of the replay tasks in the Pi's tasks.yaml registry. Record these
// with the teleop/record UI, then register them under exactly these names.
export const ARM_LOAD_TASK = 'wax_nest_load';
export const ARM_UNLOAD_TASK = 'wax_nest_unload';

export class TransitionError extends Error {}

interface Actor {
	_id: string;
	username: string;
}

async function getRun(runId: string) {
	await connectDB();
	const run = await ArmWaxFillRun.findById(runId);
	if (!run) throw new TransitionError(`ArmWaxFillRun ${runId} not found`);
	return run;
}

function assertPhase(run: any, expected: ArmWaxPhase) {
	if (run.phase !== expected) {
		throw new TransitionError(
			`Run is in phase '${run.phase}', expected '${expected}'. Refresh and retry.`
		);
	}
}

async function assertArmIdle(): Promise<void> {
	const { active } = await robotArm.getActive();
	if (active) {
		throw new TransitionError(
			`Robot arm still has an active ${active.kind} session (${active.run_id}) — wait for it to finish or stop it.`
		);
	}
}

async function assertOt2Idle(robotId: string): Promise<void> {
	const robot = await getRobot(robotId);
	const res = await robotGet(robot, '/runs');
	const { data } = await forwardResponse(res);
	const runs = (data as any)?.data ?? [];
	const active = runs.find((r: any) =>
		['running', 'paused', 'pause-requested', 'blocked-by-open-door'].includes(r.status)
	);
	if (active) {
		throw new TransitionError(
			`OT-2 has an active run (${active.id}, ${active.status}) — the gantry is not guaranteed parked.`
		);
	}
}

function pushEvent(run: any, type: string, by: string, payload?: unknown) {
	run.events.push({ at: new Date(), type, phase: run.phase, by, payload });
}

function finalizeIfTerminal(run: any) {
	if (TERMINAL_PHASES.includes(run.phase)) {
		run.endedAt = new Date();
		run.finalizedAt = new Date();
	}
}

async function audit(run: any, action: string, actor: Actor, extra?: Record<string, unknown>) {
	await AuditLog.create({
		_id: generateId(),
		tableName: 'arm_wax_fill_runs',
		recordId: run._id,
		action,
		newData: { phase: run.phase, ...extra },
		changedAt: new Date(),
		changedBy: actor.username
	});
}

/** created → arm_loading: start the arm's load replay task. */
export async function startArmLoad(runId: string, actor: Actor) {
	const run = await getRun(runId);
	assertPhase(run, 'created');
	await assertArmIdle();
	await assertOt2Idle(run.robotId); // gantry must be clear before the arm reaches in

	const started = await robotArm.startTask(ARM_LOAD_TASK, { triggered_by: actor });
	run.armLoadRunId = started.run_id;
	run.phase = 'arm_loading';
	run.startedAt ??= new Date();
	pushEvent(run, 'arm_load.started', actor.username, { armRunId: started.run_id });
	await run.save();
	await audit(run, 'arm_wax_start_load', actor, { armRunId: started.run_id });
	return run;
}

/** arm_loading → loaded: verify the arm is parked and its session closed. */
export async function confirmLoaded(runId: string, actor: Actor) {
	const run = await getRun(runId);
	assertPhase(run, 'arm_loading');
	await assertArmIdle();

	run.armParkedVerifiedAt = new Date();
	run.phase = 'loaded';
	pushEvent(run, 'arm_load.confirmed', actor.username);
	await run.save();
	await audit(run, 'arm_wax_confirm_loaded', actor);
	return run;
}

/**
 * loaded → ot2_filling: create + play the OT-2 run for the deployed
 * ARM-WAX protocol. `ot2ProtocolId` is the protocol id on the robot
 * (picked in the UI from the robot's protocol list).
 */
export async function startFill(runId: string, ot2ProtocolId: string, actor: Actor) {
	const run = await getRun(runId);
	assertPhase(run, 'loaded');
	if (!run.armParkedVerifiedAt) throw new TransitionError('Arm-parked verification missing.');
	await assertArmIdle(); // re-check: nobody re-engaged the arm meanwhile
	await assertOt2Idle(run.robotId);

	const robot = await getRobot(run.robotId);

	const createRes = await robotPost(robot, '/runs', { data: { protocolId: ot2ProtocolId } });
	const created = await forwardResponse(createRes);
	if (createRes.status >= 400) {
		throw new TransitionError(`OT-2 refused to create run: ${JSON.stringify(created.data)}`);
	}
	const ot2RunId = (created.data as any)?.data?.id;
	if (!ot2RunId) throw new TransitionError('OT-2 run created but no run id returned.');

	const playRes = await robotPost(robot, `/runs/${ot2RunId}/actions`, {
		data: { actionType: 'play' }
	});
	if (playRes.status >= 400) {
		const body = await forwardResponse(playRes);
		throw new TransitionError(`OT-2 refused to play run: ${JSON.stringify(body.data)}`);
	}

	run.ot2ProtocolId = ot2ProtocolId;
	run.ot2RunId = ot2RunId;
	run.phase = 'ot2_filling';
	pushEvent(run, 'ot2_fill.started', actor.username, { ot2RunId, ot2ProtocolId });
	await run.save();
	await audit(run, 'arm_wax_start_fill', actor, { ot2RunId });
	return run;
}

/** ot2_filling → filled: verify the OT-2 run succeeded (protocol homes at end). */
export async function confirmFilled(runId: string, actor: Actor) {
	const run = await getRun(runId);
	assertPhase(run, 'ot2_filling');

	const robot = await getRobot(run.robotId);
	const res = await robotGet(robot, `/runs/${run.ot2RunId}`);
	const { data } = await forwardResponse(res);
	const status = (data as any)?.data?.status;
	if (status !== 'succeeded') {
		if (['failed', 'stopped'].includes(status)) {
			return failRun(runId, `OT-2 run ${run.ot2RunId} ended '${status}'`, actor);
		}
		throw new TransitionError(`OT-2 run is '${status ?? 'unknown'}' — not finished yet.`);
	}

	run.ot2HomedVerifiedAt = new Date(); // protocol's final step is home()
	run.phase = 'filled';
	pushEvent(run, 'ot2_fill.succeeded', actor.username, { ot2RunId: run.ot2RunId });
	await run.save();
	await audit(run, 'arm_wax_confirm_filled', actor);
	return run;
}

/** filled → arm_unloading: start the arm's unload replay task. */
export async function startArmUnload(runId: string, actor: Actor) {
	const run = await getRun(runId);
	assertPhase(run, 'filled');
	if (!run.ot2HomedVerifiedAt) throw new TransitionError('OT-2 homed verification missing.');
	await assertArmIdle();
	await assertOt2Idle(run.robotId);

	const started = await robotArm.startTask(ARM_UNLOAD_TASK, { triggered_by: actor });
	run.armUnloadRunId = started.run_id;
	run.phase = 'arm_unloading';
	pushEvent(run, 'arm_unload.started', actor.username, { armRunId: started.run_id });
	await run.save();
	await audit(run, 'arm_wax_start_unload', actor, { armRunId: started.run_id });
	return run;
}

/**
 * arm_unloading → complete: verify the arm is done, then advance the
 * cartridge to wax_filled with a note + audit row (same shape as the
 * manual wax-filling flow).
 */
export async function completeRun(runId: string, actor: Actor) {
	const run = await getRun(runId);
	assertPhase(run, 'arm_unloading');
	await assertArmIdle();

	const now = new Date();
	const cart = (await CartridgeRecord.findById(run.cartridgeId)
		.select('_id status')
		.lean()) as any;
	const from = cart?.status ?? '(missing)';
	if (cart) {
		await CartridgeRecord.updateOne(
			{ _id: run.cartridgeId },
			{
				$set: { status: 'wax_filled', priorStatus: from },
				$push: {
					notes: {
						_id: generateId(),
						body: `Wax filled by ARM-WAX cell (run ${run._id}): ${from} → wax_filled.`,
						phase: 'wax_filled',
						author: { _id: actor._id, username: actor.username },
						createdAt: now
					}
				}
			}
		);
		await AuditLog.create({
			_id: generateId(),
			tableName: 'cartridge_records',
			recordId: run.cartridgeId,
			action: 'arm_wax_fill',
			newData: { from, to: 'wax_filled', armWaxFillRunId: run._id },
			changedAt: now,
			changedBy: actor.username
		});
	}

	run.phase = 'complete';
	pushEvent(run, 'run.complete', actor.username, { cartridgeFrom: from });
	finalizeIfTerminal(run);
	await run.save();
	await audit(run, 'arm_wax_complete', actor);
	return run;
}

/** Any non-terminal phase → aborted. Best-effort stop of both machines. */
export async function abortRun(runId: string, reason: string, actor: Actor) {
	const run = await getRun(runId);
	if (TERMINAL_PHASES.includes(run.phase)) {
		throw new TransitionError(`Run already terminal (${run.phase}).`);
	}

	const cleanup: string[] = [];
	if (DECK_TOKEN[run.phase as ArmWaxPhase] === 'arm') {
		try {
			await robotArm.stop();
			cleanup.push('arm sessions stopped');
		} catch (e) {
			cleanup.push(`arm stop failed: ${e instanceof Error ? e.message : e}`);
		}
	}
	if (DECK_TOKEN[run.phase as ArmWaxPhase] === 'ot2' && run.ot2RunId) {
		try {
			const robot = await getRobot(run.robotId);
			await robotPost(robot, `/runs/${run.ot2RunId}/actions`, {
				data: { actionType: 'stop' }
			});
			cleanup.push('ot2 stop requested');
		} catch (e) {
			cleanup.push(`ot2 stop failed: ${e instanceof Error ? e.message : e}`);
		}
	}

	run.error = reason;
	run.phase = 'aborted';
	pushEvent(run, 'run.aborted', actor.username, { reason, cleanup });
	finalizeIfTerminal(run);
	await run.save();
	await audit(run, 'arm_wax_abort', actor, { reason });
	return run;
}

/** Any non-terminal phase → failed (used by confirm steps and agents). */
export async function failRun(runId: string, error: string, actor: Actor) {
	const run = await getRun(runId);
	if (TERMINAL_PHASES.includes(run.phase)) return run;
	run.error = error;
	run.phase = 'failed';
	pushEvent(run, 'run.failed', actor.username, { error });
	finalizeIfTerminal(run);
	await run.save();
	await audit(run, 'arm_wax_fail', actor, { error });
	return run;
}

export { NEXT_PHASE, DECK_TOKEN };
