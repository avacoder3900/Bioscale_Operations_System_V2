/**
 * Verification script for the equipment-resolve helper.
 * Acceptance-criteria gate for PRD ECC-01a: confirms `resolveFridgeId`
 * hits by _id, barcode, and display name, and returns null on unknown.
 *
 * Usage: `npx tsx scripts/verify-equipment-resolve.ts`
 */
import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
dotenv.config();

const URI = process.env.MONGODB_URI;
if (!URI) throw new Error('MONGODB_URI not set in env');

async function main() {
	await mongoose.connect(URI!);

	const { resolveFridgeId, resolveOvenId, __clearEquipmentResolveCacheForTests } = await import(
		'../src/lib/server/services/equipment-resolve.ts'
	);
	const db = mongoose.connection.db!;

	// Pick a sample fridge and oven to probe.
	const fridge = await db.collection('equipment').findOne({ equipmentType: 'fridge' });
	if (!fridge) {
		console.error('No fridge found in equipment collection — cannot verify.');
		process.exit(2);
	}
	const oven = await db.collection('equipment').findOne({ equipmentType: 'oven' });

	const expectedFridgeId = String(fridge._id);
	const fridgeName = (fridge as any).name;
	const fridgeBarcode = (fridge as any).barcode;

	console.log(`Probe fridge: _id=${expectedFridgeId}  name="${fridgeName}"  barcode="${fridgeBarcode}"`);

	__clearEquipmentResolveCacheForTests();

	const byId = await resolveFridgeId(expectedFridgeId);
	const byName = fridgeName ? await resolveFridgeId(fridgeName) : null;
	const byBarcode = fridgeBarcode ? await resolveFridgeId(fridgeBarcode) : null;
	const byUnknown = await resolveFridgeId('DEFINITELY-NOT-A-REAL-FRIDGE-xyz');

	const results = [
		{ label: 'lookup by _id',             got: byId,       expect: expectedFridgeId },
		{ label: 'lookup by name',            got: byName,     expect: fridgeName ? expectedFridgeId : null },
		{ label: 'lookup by barcode',         got: byBarcode,  expect: fridgeBarcode ? expectedFridgeId : null },
		{ label: 'lookup with bogus string',  got: byUnknown,  expect: null }
	];

	let failed = 0;
	for (const r of results) {
		const pass = r.got === r.expect;
		console.log(`  ${pass ? '✔' : '✘'}  ${r.label}: got=${r.got ?? 'null'}  expected=${r.expect ?? 'null'}`);
		if (!pass) failed++;
	}

	// Also confirm oven side works if an oven is present.
	if (oven) {
		const expectedOvenId = String(oven._id);
		const ovenName = (oven as any).name;
		const byOvenId = await resolveOvenId(expectedOvenId);
		const byOvenName = ovenName ? await resolveOvenId(ovenName) : null;
		const byFridgeLookupAsOven = fridgeName ? await resolveOvenId(fridgeName) : null;

		const ovenResults = [
			{ label: 'oven lookup by _id',                           got: byOvenId,              expect: expectedOvenId },
			{ label: 'oven lookup by name',                          got: byOvenName,            expect: ovenName ? expectedOvenId : null },
			{ label: 'oven lookup of a fridge name (should be null)', got: byFridgeLookupAsOven, expect: null }
		];
		for (const r of ovenResults) {
			const pass = r.got === r.expect;
			console.log(`  ${pass ? '✔' : '✘'}  ${r.label}: got=${r.got ?? 'null'}  expected=${r.expect ?? 'null'}`);
			if (!pass) failed++;
		}
	} else {
		console.log('  (skipped oven checks — no oven equipment records in DB)');
	}

	await mongoose.disconnect();

	if (failed > 0) {
		console.error(`\n${failed} check(s) failed.`);
		process.exit(1);
	}
	console.log('\nAll checks passed.');
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
