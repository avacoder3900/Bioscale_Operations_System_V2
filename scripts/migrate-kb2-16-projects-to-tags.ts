/**
 * KB2-16 migration: projects → tags, two boards → one, ranks → global scopes.
 * Dry-run by default; --apply (or APPLY=1) to write. Idempotent — safe to re-run.
 * Run AFTER the KB2-16 code is deployed (queuePolicyOf falls back to the old
 * boards.ops values until step 4 runs, so order is deploy → migrate).
 *
 *   npx tsx scripts/migrate-kb2-16-projects-to-tags.ts           # dry run
 *   npx tsx scripts/migrate-kb2-16-projects-to-tags.ts --apply   # apply
 *
 * Steps (per docs/prds/KB2-16-projects-to-tags.md):
 *   1. task.project → tag bearing the project's name; $unset project
 *   2. board:'software' tasks get the 'software' tag; $unset board on all
 *   3. re-rank Tier 1 globally (project sortOrder, then old rank) and Tier 2
 *      globally (ops queue first, then software, intra-board order kept)
 *   4. policy: boards.ops → top-level readyCap/minOrderPoint; drop boards
 *   5. templates: defaultProjectId's project name folds into tags; unset field
 *      (and unset the retired template board field)
 *   6. kanban_projects collection left untouched (dead data, zero risk)
 *   7. indexes: drop the two {board,...} compounds; ensure {status, rank}
 *      (mongoose autoIndex also creates it on next boot)
 *   8. housekeeping: resolve open 'board:*' replenishment signals (the code
 *      also auto-resolves them); unset standing-target board fields
 */
import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
dotenv.config();

const APPLY = process.env.APPLY === '1' || process.argv.includes('--apply');

async function main() {
	await mongoose.connect(process.env.MONGODB_URI!);
	const db = mongoose.connection.db!;
	const tasks = db.collection('kanban_tasks');
	const projects = db.collection('kanban_projects');
	const policy = db.collection('kanban_policy');
	const templates = db.collection('kanban_templates');
	const violations = db.collection('workflow_violations');
	const targets = db.collection('kanban_standing_targets');

	console.log(`\n=== KB2-16 projects→tags migration — ${APPLY ? 'APPLY' : 'DRY RUN'} ===`);

	const projectDocs = (await projects.find({}).sort({ sortOrder: 1 }).toArray()) as any[];
	const projectById = new Map(projectDocs.map((p) => [String(p._id), p]));
	console.log(`Projects found: ${projectDocs.length} (collection is left in place as dead data)`);

	// ---- Step 1: project subdoc → tag --------------------------------------
	const withProject = (await tasks
		.find({ 'project._id': { $exists: true } })
		.project({ _id: 1, project: 1 })
		.toArray()) as any[];
	console.log(`\nStep 1: ${withProject.length} tasks carry a project subdoc → tag`);
	if (APPLY) {
		for (const t of withProject) {
			const name: string | undefined = t.project?.name ?? projectById.get(String(t.project?._id))?.name;
			const update: any = { $unset: { project: '' } };
			if (name?.trim()) update.$addToSet = { tags: name.trim() };
			await tasks.updateOne({ _id: t._id }, update);
		}
	}

	// ---- Step 2: board → 'software' tag; unset board ------------------------
	const softwareCount = await tasks.countDocuments({ board: 'software' });
	const anyBoard = await tasks.countDocuments({ board: { $exists: true } });
	console.log(`Step 2: ${softwareCount} software-board tasks get the 'software' tag; unset board on ${anyBoard}`);
	if (APPLY) {
		await tasks.updateMany({ board: 'software' }, { $addToSet: { tags: 'software' } });
		await tasks.updateMany({ board: { $exists: true } }, { $unset: { board: '' } });
	}

	// ---- Step 3: global re-rank ---------------------------------------------
	// Tier 1: order by (project sortOrder — captured before step 1 ran via the
	// snapshot above, so re-runs after apply fall back to rank/createdAt),
	// then old rank, then createdAt. Strict 1..N.
	const sortOrderOfTask = (t: any): number => {
		const pid = t.project?._id ? String(t.project._id) : null;
		const so = pid ? projectById.get(pid)?.sortOrder : null;
		return typeof so === 'number' ? so : Number.MAX_SAFE_INTEGER;
	};
	const tier1 = (await tasks
		.find({ status: { $in: ['captured', 'processed'] }, archived: { $ne: true } })
		.project({ _id: 1, rank: 1, project: 1, createdAt: 1 })
		.toArray()) as any[];
	tier1.sort(
		(a, b) =>
			sortOrderOfTask(a) - sortOrderOfTask(b) ||
			(a.rank ?? 0) - (b.rank ?? 0) ||
			new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
	);
	console.log(`Step 3a: re-rank ${tier1.length} Tier 1 options into one global 1..N`);
	if (APPLY) {
		let r = 1;
		for (const t of tier1) await tasks.updateOne({ _id: t._id }, { $set: { rank: r++ } });
	}

	const ready = (await tasks
		.find({ status: 'ready', archived: { $ne: true } })
		.project({ _id: 1, rank: 1, board: 1, createdAt: 1 })
		.toArray()) as any[];
	ready.sort(
		(a, b) =>
			(a.board === 'software' ? 1 : 0) - (b.board === 'software' ? 1 : 0) ||
			(a.rank ?? 0) - (b.rank ?? 0) ||
			new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
	);
	console.log(`Step 3b: re-rank ${ready.length} ready items (ops first, then software)`);
	if (APPLY) {
		let r = 1;
		for (const t of ready) await tasks.updateOne({ _id: t._id }, { $set: { rank: r++ } });
	}

	// ---- Step 4: policy singleton -------------------------------------------
	const pol: any = await policy.findOne({ _id: 'default' as any });
	if (pol) {
		const readyCap = pol.readyCap ?? pol.boards?.ops?.readyCap ?? 8;
		const minOrderPoint = pol.minOrderPoint ?? pol.boards?.ops?.minOrderPoint ?? 3;
		console.log(`Step 4: policy → readyCap=${readyCap}, minOrderPoint=${minOrderPoint}; drop boards block (${pol.boards ? 'present' : 'already gone'})`);
		if (APPLY) {
			await policy.updateOne(
				{ _id: 'default' as any },
				{ $set: { readyCap, minOrderPoint }, $unset: { boards: '' } }
			);
		}
	} else {
		console.log('Step 4: no policy doc yet — nothing to migrate (defaults apply)');
	}

	// ---- Step 5: templates ---------------------------------------------------
	const tpls = (await templates
		.find({ $or: [{ defaultProjectId: { $exists: true } }, { board: { $exists: true } }] })
		.toArray()) as any[];
	console.log(`Step 5: ${tpls.length} templates carry defaultProjectId/board`);
	if (APPLY) {
		for (const tpl of tpls) {
			const update: any = { $unset: { defaultProjectId: '', board: '' } };
			const pname = tpl.defaultProjectId ? projectById.get(String(tpl.defaultProjectId))?.name : null;
			if (pname?.trim()) update.$addToSet = { tags: pname.trim() };
			await templates.updateOne({ _id: tpl._id }, update);
		}
	}

	// ---- Step 7: indexes ------------------------------------------------------
	const idx = await tasks.indexes();
	const dead = idx.filter((i) => i.key && 'board' in i.key).map((i) => i.name!);
	console.log(`Step 7: drop stale indexes: ${dead.length ? dead.join(', ') : 'none'}`);
	if (APPLY) {
		for (const name of dead) await tasks.dropIndex(name).catch((e) => console.warn(`  (dropIndex ${name}: ${e.message})`));
		await tasks.createIndex({ status: 1, rank: 1 });
	}

	// ---- Step 8: housekeeping --------------------------------------------------
	const openSignals = await violations.countDocuments({
		type: 'replenishment_needed',
		taskId: { $in: ['board:ops', 'board:software'] },
		resolved: false
	});
	const targetBoards = await targets.countDocuments({ board: { $exists: true } });
	console.log(`Step 8: resolve ${openSignals} legacy board:* replenishment signals; unset board on ${targetBoards} standing targets`);
	if (APPLY) {
		if (openSignals) {
			await violations.updateMany(
				{ type: 'replenishment_needed', taskId: { $in: ['board:ops', 'board:software'] }, resolved: false },
				{ $set: { resolved: true, resolvedAt: new Date(), resolvedBy: 'migration:kb2-16' } }
			);
		}
		if (targetBoards) await targets.updateMany({ board: { $exists: true } }, { $unset: { board: '' } });
	}

	console.log(`\n${APPLY ? 'APPLIED.' : 'Dry run only — re-run with --apply to write.'}\n`);
	await mongoose.disconnect();
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
