/**
 * The arm Pi pushes the OT-2's commands here as they end (2026-11-06), so the
 * Movement Log fills in live instead of on page load.
 *
 *   POST /api/robot-arm/ot2-commands   header x-api-key = ROBOT_ARM_API_KEY (the Pi's key)
 *        { robotName, run: { id, status, labware, pipettes, ... }, startSeq, commands: [...ended, in order], clockOffsetMs }
 *     → { logged }
 *
 * The robot is found by its slot (B07). Rows are the same as the page-load
 * read's ($lib/server/ot2-move-log ot2Docs: id = run + command index, so a row
 * the read already wrote is skipped), on the Pi's clock. The run's read cursor
 * moves forward so the page-load read does not fetch them again.
 */
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { connectDB, OpentronsRobot, Ot2MoveSync } from '$lib/server/db';
import { isArmPiKey } from '$lib/server/arm-loop-drive';
import { insertOt2Docs, ot2Docs } from '$lib/server/ot2-move-log';
import { robotSlot } from '$lib/server/ot2-arm-link';
import { runNames, type Ot2RowDraft } from '$lib/robot-arm/ot2-move-log';

export const POST: RequestHandler = async ({ request }) => {
	if (!isArmPiKey(request)) return json({ error: 'Unauthorized' }, { status: 401 });
	const body = (await request.json().catch(() => null)) as any;
	const run = body?.run;
	const runId = typeof run?.id === 'string' ? run.id : '';
	const startSeq = Number(body?.startSeq);
	const commands: any[] = Array.isArray(body?.commands) ? body.commands.slice(0, 500) : [];
	if (!runId || !Number.isInteger(startSeq) || startSeq < 0) return json({ error: 'run.id and startSeq are required.' }, { status: 400 });
	const slot = robotSlot(body?.robotName);
	if (!slot) return json({ error: 'robotName has no slot (e.g. B07).' }, { status: 400 });
	await connectDB();
	const robots = (await OpentronsRobot.find({ isActive: { $ne: false } }).select('_id name').lean()) as any[];
	const robot = robots.find((r) => robotSlot(r.name) === slot);
	if (!robot) return json({ error: `No active robot for ${slot}.` }, { status: 404 });
	const robotRef = { _id: String(robot._id), name: String(robot.name ?? '') };
	const state = (await Ot2MoveSync.findById(runId).select('protocolName').lean()) as any;
	const from = state?.protocolName ? `Run ${state.protocolName}` : `Run ${runId.slice(0, 8)}`;
	const off = Number(body?.clockOffsetMs);
	const rows: Ot2RowDraft[] = commands
		.map((c, i) => ({ seq: startSeq + i, command: c }))
		.filter((r) => r.command && (r.command.status === 'succeeded' || r.command.status === 'failed'));
	const logged = await insertOt2Docs(ot2Docs(robotRef, runId, from, runNames(run), rows, Number.isFinite(off) ? off : null));
	await Ot2MoveSync.updateOne(
		{ _id: runId },
		{ $max: { cursor: startSeq + commands.length }, $set: { robot: robotRef, runStatus: run.status ?? null, syncedAt: new Date() } },
		{ upsert: true }
	);
	return json({ logged });
};
