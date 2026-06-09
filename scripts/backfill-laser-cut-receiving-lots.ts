/**
 * Backfill ReceivingLot records for past LaserCutBatch documents.
 *
 * Forward fix lives in src/routes/manufacturing/laser-cutting/+page.server.ts —
 * new batches now create a ReceivingLot at submission time. This script catches
 * up the historical batches so PT-CT-112's Receiving Lots tab shows the full
 * production history.
 *
 * Idempotent: skips any batch whose outputLotId already has a ReceivingLot.
 *
 * Usage: npx tsx scripts/backfill-laser-cut-receiving-lots.ts [--dry-run]
 */
import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
dotenv.config();

const DRY_RUN = process.argv.includes('--dry-run');
const URI = process.env.MONGODB_URI;
if (!URI) { console.error('MONGODB_URI missing'); process.exit(1); }

function generateId(): string {
	// nanoid 21-char alphabet — matches src/lib/server/db/utils generateId
	const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';
	let id = '';
	for (let i = 0; i < 21; i++) id += alphabet[Math.floor(Math.random() * alphabet.length)];
	return id;
}

async function main() {
	await mongoose.connect(URI!);
	const db = mongoose.connection.db!;

	const ptCt112 = await db.collection('part_definitions').findOne({ partNumber: 'PT-CT-112' });
	if (!ptCt112) {
		console.error('PT-CT-112 not found — aborting.');
		await mongoose.disconnect();
		process.exit(1);
	}
	console.log(`PT-CT-112 → ${ptCt112._id} | ${ptCt112.name}`);

	const settings = await db.collection('manufacturing_settings').findOne({ _id: 'default' as any });
	const stripsPerSheet: number = (settings as any)?.general?.cartridgesPerLaserCutSheet ?? 16;
	console.log(`stripsPerSheet (from settings) = ${stripsPerSheet}`);

	const batches = await db.collection('laser_cut_batches')
		.find({ outputLotId: { $exists: true, $ne: null } })
		.sort({ createdAt: 1 })
		.toArray();
	console.log(`\nFound ${batches.length} laser cut batches with outputLotId.\n`);

	let created = 0;
	let skippedExisting = 0;
	let skippedNoOutput = 0;
	let skippedNoTx = 0;
	const failures: { outputLotId: string; error: string }[] = [];

	for (const batch of batches) {
		const outputLotId = batch.outputLotId;
		const outputSheetCount = batch.outputSheetCount ?? 0;
		const inputSheetCount = batch.inputSheetCount ?? 0;
		const failureCount = batch.failureCount ?? 0;

		if (outputSheetCount <= 0) {
			skippedNoOutput++;
			continue;
		}

		// Idempotency: bail if a ReceivingLot with this lotId already exists
		const existing = await db.collection('receiving_lots').findOne({ lotId: outputLotId });
		if (existing) {
			skippedExisting++;
			continue;
		}

		// Source the quantity from the original InventoryTransaction so we
		// preserve the strips/sheet ratio in effect at production time. Setting
		// changed from 6 → 16 between Apr 22 and Apr 27, so recomputing with
		// the current ratio would overstate the older batches.
		//
		// Batches without a matching tx predate the partDefinitionId wiring
		// (commit 6795b23) and never moved PT-CT-112's inventoryCount. Skip
		// them rather than fabricate phantom receiving lots that wouldn't
		// reconcile against inventory.
		const matchingTx = await db.collection('inventory_transactions').findOne({
			partDefinitionId: ptCt112._id,
			transactionType: 'creation',
			$or: [{ manufacturingRunId: outputLotId }, { lotId: outputLotId }]
		});
		if (!matchingTx) {
			console.log(`- ${outputLotId} | SKIPPED: predates inventory wiring (no matching transaction)`);
			skippedNoTx++;
			continue;
		}
		const stripsProduced = matchingTx.quantity;
		const operator = batch.operator ?? { _id: batch.operatorId ?? null, username: batch.operatorId ?? 'unknown' };

		const doc = {
			_id: generateId(),
			lotId: outputLotId,
			lotNumber: outputLotId,
			part: {
				_id: ptCt112._id,
				partNumber: ptCt112.partNumber,
				name: ptCt112.name
			},
			quantity: stripsProduced,
			operator: { _id: operator._id ?? null, username: operator.username ?? 'unknown' },
			inspectionPathway: 'coc',
			cocMeetsStandards: true,
			status: 'accepted',
			notes: `[Backfill] Internal production from laser cut batch: ${outputSheetCount} sheets × ${stripsPerSheet} strips/sheet = ${stripsProduced} strips (${failureCount} sheet failures from ${inputSheetCount} input)`,
			photos: [],
			additionalDocuments: [],
			overrideApplied: false,
			firstArticleInspection: false,
			storageConditionsRequired: false,
			esdHandlingRequired: false,
			consumedUl: 0,
			createdAt: batch.createdAt ?? new Date(),
			updatedAt: batch.createdAt ?? new Date()
		};

		console.log(`${DRY_RUN ? '[dry-run] ' : ''}+ ${outputLotId} | qty=${stripsProduced} | operator=${doc.operator.username} | createdAt=${doc.createdAt.toISOString?.() ?? doc.createdAt}`);

		if (!DRY_RUN) {
			try {
				await db.collection('receiving_lots').insertOne(doc as any);
				created++;
			} catch (err: any) {
				failures.push({ outputLotId, error: err.message ?? String(err) });
				console.error(`  ✗ failed: ${err.message ?? err}`);
			}
		} else {
			created++;
		}
	}

	console.log(`\n=== Summary ===`);
	console.log(`Mode:            ${DRY_RUN ? 'DRY RUN (no writes)' : 'LIVE'}`);
	console.log(`Total batches:   ${batches.length}`);
	console.log(`Created:         ${created}`);
	console.log(`Skipped (dup):   ${skippedExisting}`);
	console.log(`Skipped (zero):  ${skippedNoOutput}`);
	console.log(`Skipped (no tx): ${skippedNoTx}`);
	console.log(`Failed:          ${failures.length}`);
	if (failures.length > 0) {
		for (const f of failures) console.log(`  - ${f.outputLotId}: ${f.error}`);
	}

	await mongoose.disconnect();
}

main().catch(err => { console.error(err); process.exit(1); });
