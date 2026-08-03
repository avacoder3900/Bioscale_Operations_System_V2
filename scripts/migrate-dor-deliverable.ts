/**
 * KB2-12 addendum (2026-08-03): collapse DoR outcome + acceptanceCriteria into
 * one field dor.deliverable ("what will exist/be true when this is done, and
 * how you'd verify it") on kanban_tasks and kanban_templates.
 *
 *   dor.deliverable = outcome + (acceptance ? "\n\nVerify: " + acceptance : "")
 *   then $unset dor.outcome + dor.acceptanceCriteria.
 *
 * Dry-run by default; APPLY=1 to write. Idempotent — docs that already have
 * dor.deliverable keep it (old fields are still unset).
 *
 *   npx tsx scripts/migrate-dor-deliverable.ts          # dry run
 *   APPLY=1 npx tsx scripts/migrate-dor-deliverable.ts  # apply
 */
import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
dotenv.config();

const APPLY = process.env.APPLY === '1';

function buildDeliverable(outcome?: string, acceptance?: string): string {
	const o = outcome?.trim() ?? '';
	const a = acceptance?.trim() ?? '';
	if (o && a) return `${o}\n\nVerify: ${a}`;
	if (o) return o;
	if (a) return `Verify: ${a}`;
	return '';
}

async function migrateCollection(name: string) {
	const coll = mongoose.connection.db!.collection(name);
	const filter = {
		$or: [{ 'dor.outcome': { $exists: true } }, { 'dor.acceptanceCriteria': { $exists: true } }]
	};
	const docs = await coll
		.find(filter)
		.project({ _id: 1, title: 1, name: 1, dor: 1 })
		.toArray();
	console.log(`\n=== ${name}: ${docs.length} doc(s) with dor.outcome/acceptanceCriteria ===`);

	let migrated = 0;
	let keptExisting = 0;
	for (const d of docs) {
		const label = (d as any).title ?? (d as any).name ?? '';
		const hasDeliverable = typeof d.dor?.deliverable === 'string' && d.dor.deliverable.trim();
		const deliverable = buildDeliverable(d.dor?.outcome, d.dor?.acceptanceCriteria);
		const update: Record<string, unknown> = {
			$unset: { 'dor.outcome': '', 'dor.acceptanceCriteria': '' }
		};
		if (hasDeliverable) {
			keptExisting++;
			console.log(`  ${d._id} "${label}" — dor.deliverable already set; unsetting old fields only`);
		} else {
			(update as any).$set = { 'dor.deliverable': deliverable };
			migrated++;
			console.log(`  ${d._id} "${label}" — deliverable ← ${JSON.stringify(deliverable.slice(0, 120))}${deliverable.length > 120 ? '…' : ''}`);
		}
		if (APPLY) await coll.updateOne({ _id: d._id }, update);
	}
	console.log(`  → ${migrated} migrated, ${keptExisting} kept existing deliverable, old fields unset on all ${docs.length}`);
	return { total: docs.length, migrated, keptExisting };
}

async function main() {
	if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI not set (.env)');
	await mongoose.connect(process.env.MONGODB_URI);

	const tasks = await migrateCollection('kanban_tasks');
	const templates = await migrateCollection('kanban_templates');

	console.log(
		`\nTOTAL: kanban_tasks ${tasks.total} (migrated ${tasks.migrated}), kanban_templates ${templates.total} (migrated ${templates.migrated})`
	);
	console.log(APPLY ? 'APPLIED' : 'DRY RUN — set APPLY=1 to write');
	await mongoose.disconnect();
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
