/**
 * One-time fold (Jacob, 2026-09-10): "there should be no distinction — a linked
 * group IS an analysis group."
 *
 * The optical assign endpoint used to create `assign_batch` groups (membership
 * via optical_test_cartridges.groupId) while the Analysis Groups page only shows
 * `optical_analysis` groups (membership via cartridgeIds[] of barcodes). Batches
 * therefore never appeared where they could be analyzed. The endpoint now creates
 * / joins an optical_analysis group directly; this script folds every legacy
 * batch group (purpose assign_batch or missing) into a same-named analysis group:
 *   - find-or-create the optical_analysis group with the same name;
 *   - add the batch's barcodes to its cartridgeIds, EXCEPT barcodes already held
 *     by a different analysis group (one group per cartridge — reported, not moved);
 *   - repoint optical_test_cartridges.groupId to the analysis group;
 *   - archive the legacy group (BIMS never hard-deletes) with a note.
 * Empty legacy groups (no cartridges point at them) are just archived.
 *
 *   npx tsx scripts/unify-optical-groups.ts            # dry run
 *   npx tsx scripts/unify-optical-groups.ts --apply
 */
import mongoose from 'mongoose';
import { nanoid } from 'nanoid';
import * as dotenv from 'dotenv';
dotenv.config();

const APPLY = process.argv.includes('--apply');
const PALETTE = ['cyan', 'green', 'purple', 'yellow', 'orange', 'blue'];
const ACTOR = 'script:unify-optical-groups (jacob)';

async function main() {
	await mongoose.connect(process.env.MONGODB_URI!);
	const db = mongoose.connection.db!;
	const groups = db.collection('cartridge_groups');
	const optCarts = db.collection('optical_test_cartridges');
	const now = new Date();

	const legacy = await groups
		.find({ purpose: { $ne: 'optical_analysis' }, archivedAt: null })
		.sort({ createdAt: 1 })
		.toArray();
	console.log(`${APPLY ? 'APPLY' : 'DRY RUN'} — ${legacy.length} legacy group(s)\n`);

	for (const g of legacy) {
		const barcodes = (await optCarts.find({ groupId: g._id }).project({ barcode: 1 }).toArray()).map(
			(o: any) => o.barcode as string
		);
		const kind = g.purpose ?? 'no purpose';
		if (barcodes.length === 0) {
			console.log(`"${g.name}" (${kind}) — empty → archive`);
			if (APPLY) {
				await groups.updateOne(
					{ _id: g._id },
					{ $set: { archivedAt: now, description: `Empty legacy ${kind} group — archived by unify-optical-groups` } }
				);
			}
			continue;
		}

		let target: any = await groups.findOne({ name: g.name, purpose: 'optical_analysis', archivedAt: null });
		const heldElsewhere = await groups
			.find({
				purpose: 'optical_analysis',
				archivedAt: null,
				...(target ? { _id: { $ne: target._id } } : {}),
				cartridgeIds: { $in: barcodes }
			})
			.project({ name: 1, cartridgeIds: 1 })
			.toArray();
		const taken = new Set<string>();
		for (const h of heldElsewhere) for (const id of h.cartridgeIds ?? []) if (barcodes.includes(id)) taken.add(id);
		const toAdd = barcodes.filter((b) => !taken.has(b));
		const elsewhere = heldElsewhere.map((h: any) => `"${h.name}"`).join('/');

		// Every cart already lives in exactly one hand-made analysis group (e.g. the
		// July "control for optics test 1" batch == "control group1"): that group IS
		// the batch's home — point at it instead of spawning an empty duplicate.
		if (!target && toAdd.length === 0 && heldElsewhere.length === 1) target = heldElsewhere[0];

		console.log(
			`"${g.name}" (${kind}) — ${barcodes.length} cart(s) → ${target ? `MERGE into analysis group "${target.name}" ${target._id}` : 'CREATE analysis group'}; add ${toAdd.length}` +
				(taken.size ? `, ${taken.size} already in ${elsewhere} (left there)` : '')
		);
		if (!APPLY) continue;

		if (!target) {
			const used = (await groups.find({ purpose: 'optical_analysis', archivedAt: null }).project({ color: 1 }).toArray()).map(
				(x: any) => x.color
			);
			const color = PALETTE.find((k) => !used.includes(k)) ?? PALETTE[used.length % PALETTE.length];
			target = {
				_id: nanoid(),
				name: g.name,
				description: g.description ?? `Assigned batch (folded from legacy ${kind} group)`,
				color,
				purpose: 'optical_analysis',
				cartridgeIds: [],
				createdBy: g.createdBy ?? ACTOR,
				createdAt: g.createdAt ?? now,
				updatedAt: now
			};
			await groups.insertOne(target);
		}
		if (toAdd.length) await groups.updateOne({ _id: target._id }, { $addToSet: { cartridgeIds: { $each: toAdd } } });
		await optCarts.updateMany({ groupId: g._id }, { $set: { groupId: target._id } });
		await groups.updateOne(
			{ _id: g._id },
			{ $set: { archivedAt: now, description: `Folded into analysis group ${target._id} ("${g.name}") by unify-optical-groups` } }
		);
		await db.collection('audit_log').insertOne({
			_id: nanoid(),
			tableName: 'cartridge_groups',
			recordId: String(target._id),
			action: 'UPDATE',
			oldData: { legacyGroupId: g._id, purpose: g.purpose ?? null },
			newData: { name: g.name, added: toAdd, leftElsewhere: [...taken] },
			changedBy: ACTOR,
			changedAt: now,
			reason: 'Fold legacy assign batch into its analysis group (one kind of group)'
		});
	}
	console.log(APPLY ? '\nDone.' : '\nRe-run with --apply to write.');
	await mongoose.disconnect();
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
