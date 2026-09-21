/**
 * KB2-01 migration: flat kanban → two-tier vocabulary.
 * Dry-run by default; APPLY=1 to write. Idempotent — safe to re-run.
 * Run AFTER the KB2-01 code is deployed (enum must accept new values first).
 *
 *   npx tsx scripts/migrate-kanban-two-tier.ts          # dry run
 *   APPLY=1 npx tsx scripts/migrate-kanban-two-tier.ts  # apply
 */
import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
dotenv.config();

const APPLY = process.env.APPLY === '1';
// ALL_TO_TIER1=1 (Jacob, 2026-07-31): clean-slate mode — ALL active tasks land in
// Tier 1 'captured' (including current ready/wip/waiting), the ready queue starts
// empty, and the first replenishment ceremony populates it. Old data is going to be
// reorganized/deleted anyway. Archived/done tasks are untouched.
const ALL_TO_TIER1 = process.env.ALL_TO_TIER1 === '1';

async function main() {
	await mongoose.connect(process.env.MONGODB_URI!);
	const tasks = mongoose.connection.db!.collection('kanban_tasks');

	const histogram = async (label: string) => {
		const rows = await tasks
			.aggregate([{ $group: { _id: { s: '$status', a: '$archived' }, n: { $sum: 1 } } }, { $sort: { n: -1 } }])
			.toArray();
		console.log(`\n=== Status histogram (${label}) ===`);
		for (const r of rows) console.log(`  ${r._id.s}${r._id.a ? ' [archived]' : ''}: ${r.n}`);
	};

	await histogram('before');

	// ---- Step 1: status renames ------------------------------------------
	const renames: [Record<string, unknown>, string][] = ALL_TO_TIER1
		? [
				// Clean slate: every active task becomes an uncommitted Tier 1 option.
				[{ status: { $in: ['backlog', 'todo', 'in_progress', 'ready', 'wip', 'waiting', 'blocked'] }, archived: { $ne: true } }, 'captured']
			]
		: [
				[{ status: 'backlog' }, 'captured'],
				[{ status: 'todo' }, 'captured'], // rogue value (2 docs) — bypassed enum historically
				[{ status: 'in_progress' }, 'wip'] // rogue value (1 doc)
			];
	for (const [filter, to] of renames) {
		const n = await tasks.countDocuments(filter);
		console.log(`\nStep 1: ${JSON.stringify(filter)} → '${to}' — ${n} docs`);
		if (APPLY && n) await tasks.updateMany(filter, { $set: { status: to } });
	}

	// ---- Step 2: field defaults ------------------------------------------
	const defaults: [string, unknown][] = [
		['board', 'ops'],
		['itemType', 'deliverable'],
		['classOfService', 'standard'],
		['origin', 'planned']
	];
	for (const [field, value] of defaults) {
		const filter = { [field]: { $exists: false } };
		const n = await tasks.countDocuments(filter);
		console.log(`Step 2: default ${field}='${value}' — ${n} docs`);
		if (APPLY && n) await tasks.updateMany(filter, { $set: { [field]: value } });
	}

	// sizeClass ← taskLength (default medium)
	const noSize = await tasks.countDocuments({ sizeClass: { $exists: false } });
	console.log(`Step 2: sizeClass ← taskLength — ${noSize} docs`);
	if (APPLY && noSize) {
		await tasks.updateMany({ sizeClass: { $exists: false }, taskLength: { $in: ['short', 'medium', 'long'] } }, [
			{ $set: { sizeClass: '$taskLength' } }
		] as any);
		await tasks.updateMany({ sizeClass: { $exists: false } }, { $set: { sizeClass: 'medium' } });
	}

	// ---- Step 3: committedAt backfill for Tier 2 (incl. archived done) ----
	// In ALL_TO_TIER1 mode only archived/done docs remain Tier 2 (history keeps
	// its committedAt for metrics); active docs are captured and get none.
	const tier2NoCommit = {
		status: { $in: ['ready', 'wip', 'waiting', 'blocked', 'done'] },
		committedAt: { $exists: false }
	};
	const n3 = await tasks.countDocuments(tier2NoCommit);
	console.log(`Step 3: committedAt backfill — ${n3} docs`);
	if (APPLY && n3) {
		await tasks.updateMany(tier2NoCommit, [
			{
				$set: {
					committedAt: {
						$ifNull: ['$readyDate', { $ifNull: ['$wipDate', { $ifNull: ['$statusChangedAt', '$createdAt'] }] }]
					}
				}
			}
		] as any);
	}

	// ---- Step 4: rank backfill -------------------------------------------
	// Tier 2 global per board: wip first, then waiting, then ready; within a
	// group prioritized (legacy) first, then oldest first. Ranks 1..N.
	console.log('\nStep 4: rank backfill');
	const statusWeight: Record<string, number> = { wip: 0, waiting: 1, blocked: 1, ready: 2 };
	for (const board of ['ops']) {
		if (!ALL_TO_TIER1) {
			const tier2 = await tasks
				.find({ board: APPLY ? board : { $in: [board, null as never] }, status: { $in: ['wip', 'waiting', 'blocked', 'ready'] }, archived: { $ne: true } })
				.project({ _id: 1, status: 1, prioritized: 1, createdAt: 1 })
				.toArray();
			tier2.sort(
				(a, b) =>
					(statusWeight[a.status] ?? 9) - (statusWeight[b.status] ?? 9) ||
					Number(b.prioritized ?? false) - Number(a.prioritized ?? false) ||
					new Date(a.createdAt ?? 0).getTime() - new Date(b.createdAt ?? 0).getTime()
			);
			console.log(`  Tier 2 (${board}): ranking ${tier2.length} docs 1..${tier2.length}`);
			if (APPLY) {
				let r = 1;
				for (const t of tier2) await tasks.updateOne({ _id: t._id }, { $set: { rank: r++ } });
			}
		} else {
			console.log(`  Tier 2 (${board}): skipped — ALL_TO_TIER1 leaves the ready queue empty`);
		}

		// Tier 1 per project: prioritized first, then oldest.
		// ($in includes pre-rename values so the dry run previews correctly; post-step-1 they ARE captured)
		const tier1Statuses = ALL_TO_TIER1
			? { $in: ['captured', 'backlog', 'todo', 'in_progress', 'ready', 'wip', 'waiting', 'blocked'] }
			: { $in: ['captured', 'backlog', 'todo'] };
		const projects = await tasks.distinct('project._id', { status: tier1Statuses, archived: { $ne: true } });
		for (const pid of projects) {
			const t1 = await tasks
				.find({ 'project._id': pid, status: tier1Statuses, archived: { $ne: true } })
				.project({ _id: 1, prioritized: 1, createdAt: 1 })
				.toArray();
			t1.sort(
				(a, b) =>
					Number(b.prioritized ?? false) - Number(a.prioritized ?? false) ||
					new Date(a.createdAt ?? 0).getTime() - new Date(b.createdAt ?? 0).getTime()
			);
			console.log(`  Tier 1 project ${pid}: ranking ${t1.length} docs`);
			if (APPLY) {
				let r = 1;
				for (const t of t1) await tasks.updateOne({ _id: t._id }, { $set: { rank: r++ } });
			}
		}
	}
	// Archived/done stay rank 0 (unranked).
	if (APPLY) await tasks.updateMany({ rank: { $exists: false } }, { $set: { rank: 0 } });

	// ---- Step 5: drop dead fields ----------------------------------------
	const dead = await tasks.countDocuments({
		$or: [{ prioritized: { $exists: true } }, { sortOrder: { $exists: true } }, { taskLength: { $exists: true } }]
	});
	console.log(`\nStep 5: unset prioritized/sortOrder/taskLength — ${dead} docs`);
	if (APPLY && dead) {
		await tasks.updateMany({}, { $unset: { prioritized: '', sortOrder: '', taskLength: '' } });
	}

	await histogram('after');
	console.log(`\n${APPLY ? 'APPLIED' : 'DRY RUN — set APPLY=1 to write'}`);
	await mongoose.disconnect();
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
