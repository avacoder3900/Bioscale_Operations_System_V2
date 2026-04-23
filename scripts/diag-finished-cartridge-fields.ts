/**
 * Read-only diagnostic: inspect real finished cartridges in Mongo to confirm
 * what fields a cartridge must have populated to be linked (assayLoaded) and
 * ran (testExecution), so we can verify a "Research" cartridge (which has
 * reagentFilling.assayType = null) will still flow through those steps.
 *
 * Purely a SELECT — writes nothing.
 */
import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
dotenv.config();
const URI = process.env.MONGODB_URI!;

function keys(obj: any): string[] {
	if (!obj || typeof obj !== 'object') return [];
	return Object.keys(obj).filter((k) => obj[k] !== null && obj[k] !== undefined);
}

async function main() {
	await mongoose.connect(URI);
	const db = mongoose.connection.db!;
	const carts = db.collection('cartridge_records');

	// 1) Cartridges that have been LINKED (status='linked' or assayLoaded set)
	console.log('=== Recent LINKED cartridges (up to 5) ===');
	const linked = await carts
		.find({
			$or: [{ status: 'linked' }, { 'assayLoaded.recordedAt': { $exists: true } }]
		})
		.sort({ 'assayLoaded.recordedAt': -1, updatedAt: -1 })
		.limit(5)
		.toArray();

	if (linked.length === 0) {
		console.log('  (none found)');
	}
	for (const c of linked as any[]) {
		console.log(`\n  _id=${c._id}  status=${c.status}`);
		console.log(`    reagentFilling.assayType     = ${JSON.stringify(c.reagentFilling?.assayType ?? null)}`);
		console.log(`    reagentFilling.isResearch    = ${c.reagentFilling?.isResearch ?? '(unset)'}`);
		console.log(`    reagentFilling.recordedAt    = ${c.reagentFilling?.recordedAt?.toISOString?.() ?? '(unset)'}`);
		console.log(`    assayLoaded.assay            = ${JSON.stringify(c.assayLoaded?.assay ?? null)}`);
		console.log(`    assayLoaded.recordedAt       = ${c.assayLoaded?.recordedAt?.toISOString?.() ?? '(unset)'}`);
		console.log(`    storage.fridgeName           = ${c.storage?.fridgeName ?? '(unset)'}`);
		console.log(`    storage.recordedAt           = ${c.storage?.recordedAt?.toISOString?.() ?? '(unset)'}`);
		console.log(`    populated subdocs            = ${keys(c).filter((k) => typeof c[k] === 'object').join(', ')}`);
	}

	// 2) Cartridges that have been RAN (testExecution written)
	console.log('\n=== Recent cartridges with testExecution recorded (up to 5) ===');
	const ran = await carts
		.find({ 'testExecution.recordedAt': { $exists: true } })
		.sort({ 'testExecution.recordedAt': -1 })
		.limit(5)
		.toArray();

	if (ran.length === 0) {
		console.log('  (none found)');
	}
	for (const c of ran as any[]) {
		console.log(`\n  _id=${c._id}  status=${c.status}`);
		console.log(`    reagentFilling.assayType     = ${JSON.stringify(c.reagentFilling?.assayType ?? null)}`);
		console.log(`    assayLoaded.assay            = ${JSON.stringify(c.assayLoaded?.assay ?? null)}`);
		console.log(`    testExecution.spu._id        = ${c.testExecution?.spu?._id ?? '(unset)'}`);
		console.log(`    testExecution.executedAt     = ${c.testExecution?.executedAt?.toISOString?.() ?? '(unset)'}`);
		console.log(`    testResult.status            = ${c.testResult?.status ?? '(unset)'}`);
	}

	// 3) Are there any cartridges already with assayType=null but further progress?
	//    (Would indicate prior ad-hoc research usage we should be aware of.)
	console.log('\n=== Cartridges past reagent_filled with assayType unset (up to 5) ===');
	const nullAssayProgressed = await carts
		.find({
			'reagentFilling.recordedAt': { $exists: true },
			$or: [
				{ 'reagentFilling.assayType': null },
				{ 'reagentFilling.assayType._id': { $exists: false } }
			],
			status: { $in: ['inspected', 'sealed', 'cured', 'stored', 'linked', 'released', 'shipped'] }
		})
		.limit(5)
		.toArray();
	if (nullAssayProgressed.length === 0) {
		console.log('  (none — no precedent of cartridges flowing past filling without an assay)');
	}
	for (const c of nullAssayProgressed as any[]) {
		console.log(`  _id=${c._id}  status=${c.status}  assayLoaded=${!!c.assayLoaded?.recordedAt}  testExec=${!!c.testExecution?.recordedAt}`);
	}

	// 4) Count distribution
	console.log('\n=== Distribution counts ===');
	const counts = {
		total: await carts.countDocuments({}),
		withReagentFilling: await carts.countDocuments({ 'reagentFilling.recordedAt': { $exists: true } }),
		withAssayLoaded: await carts.countDocuments({ 'assayLoaded.recordedAt': { $exists: true } }),
		withTestExecution: await carts.countDocuments({ 'testExecution.recordedAt': { $exists: true } }),
		statusLinked: await carts.countDocuments({ status: 'linked' }),
		statusStored: await carts.countDocuments({ status: 'stored' }),
		statusCompleted: await carts.countDocuments({ status: 'completed' }),
		isResearchTrue: await carts.countDocuments({ 'reagentFilling.isResearch': true })
	};
	for (const [k, v] of Object.entries(counts)) {
		console.log(`  ${k.padEnd(22)} = ${v}`);
	}

	await mongoose.disconnect();
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
