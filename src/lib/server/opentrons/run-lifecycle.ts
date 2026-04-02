/**
 * OT-2 Run Lifecycle Service.
 * Creates, monitors, and manages OT-2 runs linked to BIMS manufacturing runs.
 */

import { connectDB, OpentronsRunRecord, OpentronsRobot, OpentronProtocol, generateId } from '$lib/server/db';
import { robotBaseUrl } from './proxy';

const RUN_TIMEOUT_MS = 5_000;

interface CreateRunParams {
	manufacturingRunId: string;
	manufacturingRunType: 'wax-filling' | 'reagent-filling';
	robotId: string;
	runtimeParameters?: Record<string, unknown>;
	cartridgeIds?: string[];
	startedBy: string;
}

/**
 * Create an OT-2 run from the deployed protocol and start it.
 * Returns the OpentronsRunRecord or null if no protocol is deployed.
 */
export async function createAndStartRun(params: CreateRunParams): Promise<{
	runRecord: any;
	error?: string;
} | null> {
	await connectDB();

	const robot = await OpentronsRobot.findById(params.robotId).lean() as any;
	if (!robot) return { runRecord: null, error: 'Robot not found' };

	// Find deployed protocol for this process type on this robot
	const protocol = await OpentronProtocol.findOne({
		processType: params.manufacturingRunType,
		'deployments.robotId': params.robotId,
		isActive: true,
	}).lean() as any;

	if (!protocol) return null; // No protocol deployed — skip OT-2 integration

	const deployment = protocol.deployments?.find((d: any) => d.robotId === params.robotId);
	if (!deployment?.opentronsProtocolId) return null;

	const baseUrl = robotBaseUrl({ ip: robot.ip, port: robot.port ?? 31950 });

	// 1. Create OT-2 run
	let otRun: any;
	try {
		const createRes = await fetch(`${baseUrl}/runs`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', 'opentrons-version': '3' },
			body: JSON.stringify({
				data: {
					protocolId: deployment.opentronsProtocolId,
					runTimeParameterValues: params.runtimeParameters ?? {},
				},
			}),
			signal: AbortSignal.timeout(RUN_TIMEOUT_MS),
		});
		if (!createRes.ok) {
			const err = await createRes.json().catch(() => ({}));
			return { runRecord: null, error: `Failed to create OT-2 run: ${JSON.stringify(err)}` };
		}
		otRun = (await createRes.json()).data;
	} catch (e) {
		return { runRecord: null, error: `Robot unreachable: ${(e as Error).message}` };
	}

	// 2. Start the run (play action)
	try {
		const playRes = await fetch(`${baseUrl}/runs/${otRun.id}/actions`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', 'opentrons-version': '3' },
			body: JSON.stringify({ data: { actionType: 'play' } }),
			signal: AbortSignal.timeout(RUN_TIMEOUT_MS),
		});
		if (!playRes.ok) {
			const err = await playRes.json().catch(() => ({}));
			return { runRecord: null, error: `Failed to start OT-2 run: ${JSON.stringify(err)}` };
		}
	} catch (e) {
		return { runRecord: null, error: `Robot unreachable during play: ${(e as Error).message}` };
	}

	// 3. Create BIMS run record
	const runRecord = await OpentronsRunRecord.create({
		_id: generateId(),
		manufacturingRunId: params.manufacturingRunId,
		manufacturingRunType: params.manufacturingRunType,
		robotId: params.robotId,
		robotName: robot.name,
		opentronsRunId: otRun.id,
		opentronsProtocolId: deployment.opentronsProtocolId,
		runtimeParameters: params.runtimeParameters,
		status: 'running',
		robotCreatedAt: otRun.createdAt ? new Date(otRun.createdAt) : new Date(),
		robotStartedAt: new Date(),
		startedBy: params.startedBy,
		cartridgeIds: params.cartridgeIds ?? [],
	});

	return { runRecord: runRecord.toObject() };
}

/**
 * Send a run action (pause, stop, play) to an OT-2 run.
 */
export async function sendRunAction(
	runRecordId: string,
	actionType: 'play' | 'pause' | 'stop'
): Promise<{ success: boolean; error?: string }> {
	await connectDB();

	const record = await OpentronsRunRecord.findById(runRecordId).lean() as any;
	if (!record) return { success: false, error: 'Run record not found' };

	const robot = await OpentronsRobot.findById(record.robotId).lean() as any;
	if (!robot) return { success: false, error: 'Robot not found' };

	const baseUrl = robotBaseUrl({ ip: robot.ip, port: robot.port ?? 31950 });

	try {
		const res = await fetch(`${baseUrl}/runs/${record.opentronsRunId}/actions`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', 'opentrons-version': '3' },
			body: JSON.stringify({ data: { actionType } }),
			signal: AbortSignal.timeout(RUN_TIMEOUT_MS),
		});
		if (!res.ok) {
			const err = await res.json().catch(() => ({}));
			return { success: false, error: `Action failed: ${JSON.stringify(err)}` };
		}
	} catch (e) {
		return { success: false, error: `Robot unreachable: ${(e as Error).message}` };
	}

	// Update status in DB
	const statusMap: Record<string, string> = {
		play: 'running', pause: 'paused', stop: 'stopped',
	};
	await OpentronsRunRecord.updateOne(
		{ _id: runRecordId },
		{ $set: { status: statusMap[actionType] } }
	);

	return { success: true };
}

/**
 * Poll a single run's status from the robot and update the DB record.
 * Called by the health poller for active runs.
 */
export async function pollRunStatus(record: any): Promise<void> {
	const robot = await OpentronsRobot.findById(record.robotId).lean() as any;
	if (!robot) return;

	const baseUrl = robotBaseUrl({ ip: robot.ip, port: robot.port ?? 31950 });

	try {
		const res = await fetch(`${baseUrl}/runs/${record.opentronsRunId}`, {
			signal: AbortSignal.timeout(3000),
			headers: { 'opentrons-version': '3' },
		});
		if (!res.ok) return;

		const data = (await res.json()).data;
		const statusMap: Record<string, string> = {
			idle: 'created', running: 'running', paused: 'paused',
			succeeded: 'succeeded', failed: 'failed', stopped: 'stopped',
			finishing: 'running', 'awaiting-recovery': 'paused',
		};

		const newStatus = statusMap[data.status] ?? record.status;
		const update: Record<string, unknown> = {
			status: newStatus,
		};

		if (data.completedAt) update.robotCompletedAt = new Date(data.completedAt);
		if (data.totalCommandCount != null) update.totalCommands = data.totalCommandCount;
		if (data.completedCommandCount != null) update.completedCommands = data.completedCommandCount;

		if (data.errors?.length) {
			update.errors = data.errors.map((e: any) => ({
				errorType: e.errorType ?? 'unknown',
				detail: e.detail ?? '',
				createdAt: e.createdAt ? new Date(e.createdAt) : new Date(),
			}));
		}

		await OpentronsRunRecord.updateOne({ _id: record._id }, { $set: update });
	} catch { /* robot offline — retry next cycle */ }
}
