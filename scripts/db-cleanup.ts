/**
 * Database Cleanup Script — Bioscale Operations System V2
 *
 * Drops ghost collections left behind by the Postgres → MongoDB migration.
 * See docs/db-cleanup-plan.md for the full audit and rationale.
 *
 * Usage:
 *   npx tsx scripts/db-cleanup.ts --tier1          # Drop 71 dead collections (safe, no data)
 *   npx tsx scripts/db-cleanup.ts --tier2           # Migrate + drop 15 camelCase twins
 *   npx tsx scripts/db-cleanup.ts --tier1 --dry-run # Preview what would be dropped
 *   npx tsx scripts/db-cleanup.ts --tier2 --dry-run # Preview migrations without executing
 */

import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
dotenv.config({ path: resolve(__dirname, '..', '.env') });

const MONGODB_URI = process.env.MONGODB_URI;
if (!MONGODB_URI) {
	console.error('MONGODB_URI not found in .env');
	process.exit(1);
}

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const runTier1 = args.includes('--tier1');
const runTier2 = args.includes('--tier2');

if (!runTier1 && !runTier2) {
	console.error('Usage: npx tsx scripts/db-cleanup.ts --tier1 [--tier2] [--dry-run]');
	console.error('  --tier1     Drop 71 dead/empty collections');
	console.error('  --tier2     Migrate data from camelCase twins → snake_case, then drop camelCase');
	console.error('  --dry-run   Preview actions without executing');
	process.exit(1);
}

// ============================================================
// TIER 1: Safe to drop — zero code references, empty or stale
// ============================================================

const TIER1_DROPS = [
	// 1a. Empty camelCase twins (model points to snake_case)
	'agentqueries',
	'manufacturingsettings',
	'opentronsrobots',
	'particledevices',
	'auditlogs',
	'schemametadatas',

	// 1b. Postgres-era ghost collections — eliminated junction tables
	'assemblysteprecords',
	'approvalhistories',
	'lotstepentries',
	'processsteps',
	'productionrununits',
	'validationresults',
	'spectroreadings',
	'locationplacements',
	'packagecartridges',
	'qaqcreleases',

	// Eliminated Kanban sub-tables
	'kanbancomments',
	'kanbantags',
	'kanbantasktags',
	'kanbanactionlogs',
	'kanbantaskproposals',
	'kanbanboardevents',

	// Eliminated reagent/cartridge sub-tables
	'waxcartridgerecords',
	'reagentcartridgerecords',
	'reagentdefinitions',
	'reagentsubcomponents',
	'reagenttuberecords',
	'reagentfillingruns',
	'reagentfillingsettings',
	'waxfillingsettings',
	'topsealbatches',
	'topsealcutrecords',
	'topsealrolls',

	// Eliminated consumables sub-tables
	'incubatortubes',
	'incubatortubeusages',
	'coolingtrayrecords',
	'deckrecords',

	// Old Postgres table names (superseded entirely)
	'assays',
	'assaytypes',
	'assayversions',
	'cartridges',
	'cartridgeusagelogs',
	'cartridgebomitems',
	'bomitemversions',
	'bompartlinks',
	'spuparts',
	'spupartusages',
	'boxintegrations',
	'particleintegrations',
	'particlelinks',
	'rejectionreasoncodes',
	'opentronsprotocolrecords',
	'opentronshealthsnapshots',
	'documentrepositories',
	'documentrevisions',
	'documenttrainings',
	'customernotes',
	'communicationpreferences',
	'equipmenteventlogs',
	'laborentries',
	'stepfielddefinitions',
	'stepfieldrecords',
	'steppartrequirements',
	'steptoolrequirements',
	'bomcolumnmappings',
	'workinstructionsteps',
	'workinstructionversions',

	// 1c. Post-migration dead collections (no model on any branch)
	'approvalrequests',
	'permissions',
	'rolepermissions',
	'userroles',

	// 1d. Additional empty camelCase twins (all 0 docs, model points to snake_case)
	'agentmessages',
	'assemblysessions',
	'cartridgegroups',
	'deviceevents',
	'electronicsignatures',
	'firmwarecartridges',
	'firmwaredevices',
	'invitetokens',
	'lasercutbatches',
	'manufacturingmaterials',
	'manufacturingmaterialtransactions',
	'productionruns',
	'routingpatterns',
	'systemdependencies',
	'testresults',
	'workinstructions',
	'bom_column_mapping',
];

// ============================================================
// TIER 2: Migrate camelCase data → snake_case, then drop camelCase
// ============================================================

const TIER2_MIGRATIONS: Array<{ from: string; to: string }> = [
	// Section 1 split-write pairs (seed script wrote to camelCase)
	// NOTE: assaydefinitions excluded — schema divergence, needs Monday discussion
	{ from: 'cartridgerecords', to: 'cartridge_records' },
	{ from: 'lotrecords', to: 'lot_records' },
	{ from: 'reagentbatchrecords', to: 'reagent_batch_records' },
	{ from: 'waxfillingruns', to: 'wax_filling_runs' },
	{ from: 'kanbantasks', to: 'kanban_tasks' },
	{ from: 'validationsessions', to: 'validation_sessions' },
	{ from: 'partdefinitions', to: 'part_definitions' },
	{ from: 'kanbanprojects', to: 'kanban_projects' },
	{ from: 'equipmentlocations', to: 'equipment_locations' },
	{ from: 'inventorytransactions', to: 'inventory_transactions' },
	{ from: 'generatedbarcodes', to: 'generated_barcodes' },

	// Section 2 reversed pairs (camelCase has data, model now targets snake_case)
	{ from: 'processconfigurations', to: 'process_configurations' },
	{ from: 'shippinglots', to: 'shipping_lots' },
	{ from: 'shippingpackages', to: 'shipping_packages' },
	{ from: 'bomitems', to: 'bom_items' },
];

async function dropCollections(db: mongoose.mongo.Db, collections: string[]) {
	const existing = (await db.listCollections().toArray()).map((c) => c.name);
	let dropped = 0;
	let skipped = 0;

	for (const name of collections) {
		if (!existing.includes(name)) {
			console.log(`  SKIP (not found): ${name}`);
			skipped++;
			continue;
		}

		const count = await db.collection(name).countDocuments();

		if (dryRun) {
			console.log(`  DRY RUN — would drop: ${name} (${count} documents)`);
		} else {
			await db.dropCollection(name);
			console.log(`  DROPPED: ${name} (had ${count} documents)`);
		}
		dropped++;
	}

	return { dropped, skipped };
}

async function migrateAndDrop(db: mongoose.mongo.Db, migrations: Array<{ from: string; to: string }>) {
	const existing = (await db.listCollections().toArray()).map((c) => c.name);
	let migrated = 0;
	let skipped = 0;

	for (const { from, to } of migrations) {
		if (!existing.includes(from)) {
			console.log(`  SKIP (source not found): ${from}`);
			skipped++;
			continue;
		}

		const sourceCount = await db.collection(from).countDocuments();
		const targetCountBefore = existing.includes(to)
			? await db.collection(to).countDocuments()
			: 0;

		if (sourceCount === 0) {
			if (dryRun) {
				console.log(`  DRY RUN — would drop empty: ${from} → ${to} (0 docs to migrate)`);
			} else {
				await db.dropCollection(from);
				console.log(`  DROPPED (empty source): ${from}`);
			}
			migrated++;
			continue;
		}

		console.log(`  MIGRATING: ${from} (${sourceCount} docs) → ${to} (${targetCountBefore} docs)`);

		if (dryRun) {
			console.log(`  DRY RUN — would migrate ${sourceCount} documents, then drop ${from}`);
			migrated++;
			continue;
		}

		// Fetch all source documents
		const sourceDocs = await db.collection(from).find({}).toArray();

		// Insert each doc, skipping duplicates by _id
		let inserted = 0;
		let duplicates = 0;
		for (const doc of sourceDocs) {
			try {
				await db.collection(to).insertOne(doc);
				inserted++;
			} catch (err: any) {
				if (err.code === 11000) {
					// Duplicate key — document already exists in target
					duplicates++;
				} else {
					throw err;
				}
			}
		}

		const targetCountAfter = await db.collection(to).countDocuments();
		console.log(`    Inserted: ${inserted}, Duplicates skipped: ${duplicates}`);
		console.log(`    Target count: ${targetCountBefore} → ${targetCountAfter}`);

		// Verify no data loss: target should have at least as many docs as before + inserted
		const expectedMin = targetCountBefore + inserted;
		if (targetCountAfter < expectedMin) {
			console.error(`    ERROR: Target count (${targetCountAfter}) less than expected (${expectedMin}). NOT dropping source.`);
			continue;
		}

		// Drop the source
		await db.dropCollection(from);
		console.log(`    DROPPED source: ${from}`);
		migrated++;
	}

	return { migrated, skipped };
}

async function main() {
	console.log('='.repeat(60));
	console.log('Bioscale MongoDB Database Cleanup');
	console.log(dryRun ? 'MODE: DRY RUN (no changes will be made)' : 'MODE: LIVE (changes are permanent!)');
	console.log('='.repeat(60));

	await mongoose.connect(MONGODB_URI!);
	const db = mongoose.connection.db!;

	// Show current collection count
	const allCollections = await db.listCollections().toArray();
	console.log(`\nCurrent collection count: ${allCollections.length}\n`);

	if (runTier1) {
		console.log('--- TIER 1: Dropping dead collections ---\n');
		const result = await dropCollections(db, TIER1_DROPS);
		console.log(`\nTier 1 complete: ${result.dropped} dropped, ${result.skipped} not found\n`);
	}

	if (runTier2) {
		console.log('--- TIER 2: Migrating camelCase → snake_case ---\n');
		const result = await migrateAndDrop(db, TIER2_MIGRATIONS);
		console.log(`\nTier 2 complete: ${result.migrated} migrated, ${result.skipped} not found\n`);
	}

	// Show final collection count
	const finalCollections = await db.listCollections().toArray();
	console.log(`Final collection count: ${finalCollections.length}`);

	// List remaining collections
	console.log('\nRemaining collections:');
	for (const col of finalCollections.sort((a, b) => a.name.localeCompare(b.name))) {
		console.log(`  ${col.name}`);
	}

	await mongoose.disconnect();
	console.log('\nDone.');
}

main().catch((err) => {
	console.error('Fatal error:', err);
	process.exit(1);
});
