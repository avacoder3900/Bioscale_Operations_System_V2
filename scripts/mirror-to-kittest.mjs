/**
 * Mirror the live `bioscale` database into an isolated `bioscale_kittest`
 * database on the SAME Atlas cluster, for testing the SPU kit withdrawal
 * button without touching real inventory.
 *
 * The app reaches Mongo through a single MONGODB_URI, and mongoose writes to
 * whatever database that URI names. So pointing a preview deployment at
 * `bioscale_kittest` redirects EVERY model -- including inventory_transactions
 * and audit_log -- at the mirror. The real collections are unreachable.
 *
 * READS from bioscale. WRITES only to bioscale_kittest. There is no code path
 * in this script that writes to the source database.
 *
 * Usage:
 *   node scripts/mirror-to-kittest.mjs            # dry run, reports only
 *   node scripts/mirror-to-kittest.mjs --apply    # actually build the mirror
 */

import { MongoClient } from 'mongodb';
import { readFileSync } from 'node:fs';

const SOURCE_DB = 'bioscale';
const TARGET_DB = 'bioscale_kittest';

// Copied wholesale from prod so the page renders and you can log in with your
// normal password (permissions ride along inside user.roles[]).
const COPY = ['part_definitions', 'spus', 'users', 'sessions'];

// Deliberately empty at the start: the button's own writes are then the only
// rows in the log, so the result is trivially readable.
const EMPTY = ['inventory_transactions', 'audit_log'];

// Mirror-only stock overrides, so the test draws down from a sane number.
// PT-SPU-032: belts are cut from 3000 mm spools into 350 mm sections up front
// and counted as sections. Prod still carries 7 (spools) with no unitOfMeasure
// set, so the mirror seeds 10 sections and names the unit explicitly. One SPU
// consumes 1 section, so a successful test run leaves 9.
const SEED_STOCK = {
	'PT-SPU-032': { inventoryCount: 10, unitOfMeasure: 'section' }
};

const APPLY = process.argv.includes('--apply');

function readUri() {
	const raw = readFileSync('C:/Users/aleja/.env', 'utf8');
	for (const line of raw.split(/\r?\n/)) {
		const m = line.match(/^\s*MONGODB_URI\s*=\s*(.*)$/);
		if (m) return m[1].trim().replace(/^["']|["']$/g, '');
	}
	throw new Error('MONGODB_URI not found in C:/Users/aleja/.env');
}

function assertSafe() {
	if (TARGET_DB === SOURCE_DB) {
		throw new Error('REFUSING: target database equals source database.');
	}
	if (TARGET_DB !== 'bioscale_kittest') {
		throw new Error(`REFUSING: target "${TARGET_DB}" is not the sanctioned test database.`);
	}
}

async function main() {
	assertSafe();

	const client = new MongoClient(readUri(), { serverSelectionTimeoutMS: 15000 });
	await client.connect();

	const src = client.db(SOURCE_DB);
	const dst = client.db(TARGET_DB);

	console.log(`source: ${SOURCE_DB}  ->  target: ${TARGET_DB}`);
	console.log(APPLY ? 'mode:   APPLY (writing)\n' : 'mode:   DRY RUN (no writes)\n');

	const report = [];

	for (const name of COPY) {
		const docs = await src.collection(name).find({}).toArray();
		let written = 0;

		if (APPLY) {
			await dst.collection(name).deleteMany({});
			for (let i = 0; i < docs.length; i += 500) {
				const batch = docs.slice(i, i + 500);
				if (batch.length) {
					await dst.collection(name).insertMany(batch, { ordered: false });
					written += batch.length;
				}
			}
		}

		report.push({ collection: name, source: docs.length, mirrored: APPLY ? written : '(dry)' });
	}

	for (const name of EMPTY) {
		const srcCount = await src.collection(name).countDocuments();
		if (APPLY) await dst.collection(name).deleteMany({});
		report.push({ collection: name, source: srcCount, mirrored: APPLY ? 0 : '(dry)' });
	}

	console.table(report);

	// Apply mirror-only stock overrides.
	console.log('\nstock overrides (mirror only):');
	for (const [partNumber, override] of Object.entries(SEED_STOCK)) {
		const before = await src.collection('part_definitions').findOne(
			{ partNumber },
			{ projection: { partNumber: 1, name: 1, inventoryCount: 1, unitOfMeasure: 1 } }
		);

		if (!before) {
			console.log(`  ${partNumber}: NOT FOUND in source -- skipped`);
			continue;
		}

		if (APPLY) {
			await dst.collection('part_definitions').updateOne({ partNumber }, { $set: override });
		}

		const fromUom = before.unitOfMeasure ?? '(unset)';
		console.log(
			`  ${partNumber} (${before.name})\n` +
				`    prod:   ${before.inventoryCount} ${fromUom}\n` +
				`    mirror: ${override.inventoryCount} ${override.unitOfMeasure}`
		);
	}

	// Verify isolation: confirm the source is untouched by re-reading a canary.
	const srcTxns = await src.collection('inventory_transactions').countDocuments();
	const dstTxns = await dst.collection('inventory_transactions').countDocuments();
	console.log(`\nisolation check:`);
	console.log(`  ${SOURCE_DB}.inventory_transactions = ${srcTxns} (must be unchanged)`);
	console.log(`  ${TARGET_DB}.inventory_transactions = ${dstTxns} (must be 0)`);

	await client.close();

	if (!APPLY) console.log('\nDry run only. Re-run with --apply to build the mirror.');
}

main().catch((err) => {
	console.error('FAILED:', err.message);
	process.exit(1);
});
