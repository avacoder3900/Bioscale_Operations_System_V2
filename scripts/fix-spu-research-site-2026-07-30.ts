/**
 * One-off (Jacob, 2026-07-30): make the research-site SPU set exactly the 16
 * requested UDIs so the research app's push-assay command can target them.
 *
 * - The 16 listed SPUs: ensure assignment = { type:'research', customer:'Brevitest Research' }
 *   (matching the shape of the SPUs already assigned).
 * - Any other SPU with assignment.type='research': clear the assignment (site null).
 *
 * Dry-run by default; APPLY=1 to write. Idempotent.
 */
import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
dotenv.config();

const APPLY = process.env.APPLY === '1';
const WANTED_UDIS = ['243','245','248','247','250','211','222','212','229','218','249','223','236','251','244','202']
	.map((n) => `BT-M01-0000-0${n}`);

async function main() {
	await mongoose.connect(process.env.MONGODB_URI!);
	const spus = mongoose.connection.db!.collection('spus');
	const now = new Date();

	// Template: copy the exact assignment shape from an already-assigned SPU.
	const template = await spus.findOne(
		{ 'assignment.type': 'research', udi: { $in: WANTED_UDIS } },
		{ projection: { assignment: 1, udi: 1 } }
	);
	if (!template) throw new Error('No template research assignment found — aborting.');
	console.log(`template (from ${template.udi}):`, JSON.stringify(template.assignment));

	// 1. Assign missing members of the wanted set.
	const toAssign = await spus
		.find({ udi: { $in: WANTED_UDIS }, 'assignment.type': { $ne: 'research' } })
		.project({ udi: 1, status: 1, assignment: 1 })
		.toArray();
	console.log(`\nTO ASSIGN → research (${toAssign.length}):`);
	for (const s of toAssign) console.log(`  ${s.udi} (status=${s.status}, was: ${JSON.stringify(s.assignment ?? null)})`);
	if (APPLY && toAssign.length) {
		await spus.updateMany(
			{ udi: { $in: toAssign.map((s) => s.udi) } },
			{
				$set: {
					assignment: {
						type: 'research',
						customer: template.assignment.customer,
						assignedAt: now,
						assignedBy: { _id: 'script', username: 'fix-spu-research-site (jacob)' }
					}
				}
			}
		);
	}

	// 2. Unassign strays: research-assigned but not in the wanted set.
	const strays = await spus
		.find({ 'assignment.type': 'research', udi: { $nin: WANTED_UDIS } })
		.project({ udi: 1, status: 1 })
		.toArray();
	console.log(`\nTO UNASSIGN (research but not in list) (${strays.length}):`);
	for (const s of strays) console.log(`  ${s.udi} (status=${s.status})`);
	if (APPLY && strays.length) {
		await spus.updateMany({ udi: { $in: strays.map((s) => s.udi) } }, { $unset: { assignment: '' } });
	}

	// Verify
	const finalCount = await spus.countDocuments({ 'assignment.type': 'research' });
	const missing = await spus.countDocuments({ udi: { $in: WANTED_UDIS }, 'assignment.type': { $ne: 'research' } });
	console.log(`\n${APPLY ? 'APPLIED' : 'DRY RUN'} — research-assigned total: ${finalCount}, wanted-but-unassigned: ${missing}`);
	await mongoose.disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
