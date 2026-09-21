/**
 * KB2-34 data pass — wire the dependency gates Jacob decided 2026-08-21
 * (this session + the workshop agent's queued fix):
 *   1. Bench studies (TASK-055/056/057/058) gate A4M — December-facing
 *      validation evidence. Pulls the whole internal-testing limb into the
 *      A4M subgraph (they're its ancestors).
 *   2. Internal diurnal round 1 (TASK-009) gates external round 1 (TASK-011)
 *      — first internal before first external; internal 2/3 run parallel.
 *   3. Internal protocol v3 (TASK-085) gates A4M.
 *   4. SPU testing regime (TASK-019 control-sample test, TASK-020 failure
 *      thresholds) gates A4M.
 * Uses the addLink service: existence + self-link + dupe + blocking-cycle
 * guard, activity log + audit rows. Idempotent (dupes are no-ops).
 * Actor: jacob (decisions made in-session 2026-08-21).
 */
import * as dotenv from 'dotenv';
dotenv.config();
import mongoose from 'mongoose';
import { connectDB, KanbanTask } from '../src/lib/server/db';
import { addLink } from '../src/lib/server/kanban/transition';

const ACTOR = { username: 'jacob', via: 'ui' as const };

const EDGES: { on: string; blockedBy: string; why: string }[] = [
	{ on: 'TASK-090', blockedBy: 'TASK-055', why: 'bench validation (linearity) is A4M evidence' },
	{ on: 'TASK-090', blockedBy: 'TASK-056', why: 'bench validation (precision) is A4M evidence' },
	{ on: 'TASK-090', blockedBy: 'TASK-057', why: 'bench validation (recovery) is A4M evidence' },
	{ on: 'TASK-090', blockedBy: 'TASK-058', why: 'bench validation (cross-reactivity) is A4M evidence' },
	{ on: 'TASK-090', blockedBy: 'TASK-085', why: 'internal protocol v3 gates A4M (Jacob 2026-08-21)' },
	{ on: 'TASK-090', blockedBy: 'TASK-019', why: 'SPU 4-test regime gates A4M (control-sample test)' },
	{ on: 'TASK-090', blockedBy: 'TASK-020', why: 'SPU 4-test regime gates A4M (failure thresholds)' },
	{ on: 'TASK-011', blockedBy: 'TASK-009', why: 'first internal round before first external round' }
];

async function main() {
	await connectDB();
	const nums = [...new Set(EDGES.flatMap((e) => [e.on, e.blockedBy]))];
	const tasks = (await KanbanTask.find({ trackingNumber: { $in: nums } })
		.select('_id trackingNumber title')
		.lean()) as any[];
	const byNum = new Map(tasks.map((t) => [t.trackingNumber, t]));
	for (const n of nums) if (!byNum.has(n)) throw new Error(`Missing task ${n}`);

	for (const e of EDGES) {
		const owner = byNum.get(e.on)!;
		const target = byNum.get(e.blockedBy)!;
		const res = await addLink(
			String(owner._id),
			{ taskId: String(target._id), type: 'blocked_by', note: e.why },
			ACTOR
		);
		console.log(`${res.added ? 'ADDED ' : 'exists'} ${e.on} blocked_by ${e.blockedBy} — ${e.why}`);
	}
	await mongoose.disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
