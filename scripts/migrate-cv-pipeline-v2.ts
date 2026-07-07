/**
 * CV-PIPELINE-V2 Migration Script — Bioscale Operations System V2
 *
 * PRD: docs/prds/CV-PIPELINE-V2.md §4 (Migration script).
 *
 * Steps (in order):
 *   1. cv_images:      label → qcLabel (preserving labeledBy/At → qcLabeledBy/At),
 *                      then $unset the legacy label/labeledBy/labeledAt fields.
 *   2. cv_projects:    wrap any legacy project-level classifier into a trainedModels[]
 *                      v1 entry (legacy classifier field is kept for the migration window).
 *   3. cv_inspections: normalize legacy status values to the new enum
 *                      (pending → queued, processing → running, complete → completed).
 *
 * All reads AND writes go through the RAW driver (mongoose.connection.db.collection)
 * — never Mongoose models — so strict mode cannot strip anything.
 *
 * Usage:
 *   npx tsx scripts/migrate-cv-pipeline-v2.ts            # DRY-RUN (default): report only
 *   npx tsx scripts/migrate-cv-pipeline-v2.ts --apply    # actually write the changes
 */

import mongoose from 'mongoose';
import type { AnyBulkWriteOperation, Document } from 'mongodb';
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

const apply = process.argv.slice(2).includes('--apply');

interface StepSummary {
	step: string;
	matched: number;
	modified: number;
	skipped: number;
	notes: string;
}
const summary: StepSummary[] = [];

// ============================================================
// Step 1 — cv_images: label → qcLabel, then retire legacy fields
// ============================================================

async function migrateImageLabels(db: mongoose.mongo.Db): Promise<void> {
	console.log('\n--- Step 1: cv_images label → qcLabel ---');
	const col = db.collection('cv_images');

	// qcLabel: null matches both explicit-null and absent in Mongo query semantics.
	const filter = { label: { $exists: true }, qcLabel: null };
	const docs = await col
		.find(filter)
		.project({ _id: 1, label: 1, labeledBy: 1, labeledAt: 1 })
		.toArray();

	// Docs that already have a qcLabel keep it (last write wins); we leave their
	// legacy fields alone in this step and just report them.
	const alreadyLabeled = await col.countDocuments({
		label: { $exists: true },
		qcLabel: { $ne: null }
	});

	const ops: AnyBulkWriteOperation<Document>[] = [];
	let withAttribution = 0;
	for (const doc of docs) {
		const set: Record<string, unknown> = { qcLabel: doc.label };
		if (doc.labeledBy != null) set.qcLabeledBy = doc.labeledBy;
		if (doc.labeledAt != null) set.qcLabeledAt = doc.labeledAt;
		if (doc.labeledBy != null || doc.labeledAt != null) withAttribution++;
		ops.push({
			updateOne: {
				filter: { _id: doc._id },
				update: {
					$set: set,
					$unset: { label: '', labeledBy: '', labeledAt: '' }
				}
			}
		});
	}

	let modified = 0;
	if (apply && ops.length > 0) {
		const result = await col.bulkWrite(ops);
		modified = result.modifiedCount;
	}

	console.log(`  matched (legacy label, no qcLabel): ${docs.length}`);
	console.log(`  with labeledBy/labeledAt attribution: ${withAttribution}`);
	console.log(`  skipped (qcLabel already set):      ${alreadyLabeled}`);
	console.log(`  ${apply ? 'modified' : 'WOULD modify'}: ${apply ? modified : docs.length}`);

	summary.push({
		step: '1. cv_images label→qcLabel',
		matched: docs.length,
		modified: apply ? modified : 0,
		skipped: alreadyLabeled,
		notes: `${withAttribution} carried labeledBy/At`
	});
}

// ============================================================
// Step 2 — cv_projects: wrap legacy classifier into trainedModels[] v1
// ============================================================

async function migrateProjectClassifiers(db: mongoose.mongo.Db): Promise<void> {
	console.log('\n--- Step 2: cv_projects legacy classifier → trainedModels[] v1 entry ---');
	const col = db.collection('cv_projects');

	const docs = await col
		.find({ classifier: { $exists: true, $ne: null } })
		.project({
			_id: 1,
			name: 1,
			classifier: 1,
			modelVersion: 1,
			activeModelVersion: 1,
			confidenceThreshold: 1,
			trainedModels: 1,
			updatedAt: 1
		})
		.toArray();

	let wrapped = 0;
	let skipped = 0;
	for (const doc of docs) {
		if (Array.isArray(doc.trainedModels) && doc.trainedModels.length > 0) {
			// Already has versioned entries — nothing to wrap.
			skipped++;
			console.log(`  skip ${doc._id} (${doc.name}): trainedModels[] already populated (${doc.trainedModels.length})`);
			continue;
		}

		const entry = {
			version: doc.modelVersion || 'v1-legacy',
			status: doc.activeModelVersion ? 'deployed' : 'trained',
			classifier: doc.classifier,
			confidenceThreshold: typeof doc.confidenceThreshold === 'number' ? doc.confidenceThreshold : 0.5,
			trainedAt: doc.classifier?.trainedAt ?? doc.updatedAt ?? null,
			trainingSet: { imageIds: [], legacy: true },
			verification: null,
			legacy: true
		};

		console.log(
			`  ${apply ? 'wrap' : 'WOULD wrap'} ${doc._id} (${doc.name}): ` +
				`version=${entry.version} status=${entry.status} threshold=${entry.confidenceThreshold}`
		);
		if (apply) {
			// Legacy project-level classifier field is intentionally NOT deleted yet
			// (kept declared for the migration window per the PRD).
			await col.updateOne({ _id: doc._id }, { $push: { trainedModels: entry } });
		}
		wrapped++;
	}

	console.log(`  matched (legacy classifier present): ${docs.length}`);
	console.log(`  skipped (trainedModels already set): ${skipped}`);
	console.log(`  ${apply ? 'wrapped' : 'WOULD wrap'}: ${wrapped}`);

	summary.push({
		step: '2. cv_projects classifier→trainedModels[]',
		matched: docs.length,
		modified: apply ? wrapped : 0,
		skipped,
		notes: 'legacy classifier field kept in place'
	});
}

// ============================================================
// Step 3 — cv_inspections: normalize legacy status values
// ============================================================

const STATUS_MAP: Record<string, string> = {
	pending: 'queued',
	processing: 'running',
	complete: 'completed'
};

async function migrateInspectionStatuses(db: mongoose.mongo.Db): Promise<void> {
	console.log('\n--- Step 3: cv_inspections status normalization ---');
	const col = db.collection('cv_inspections');

	let totalMatched = 0;
	let totalModified = 0;
	for (const [oldStatus, newStatus] of Object.entries(STATUS_MAP)) {
		const count = await col.countDocuments({ status: oldStatus });
		totalMatched += count;
		let modified = 0;
		if (apply && count > 0) {
			const result = await col.updateMany({ status: oldStatus }, { $set: { status: newStatus } });
			modified = result.modifiedCount;
			totalModified += modified;
		}
		console.log(
			`  ${oldStatus} → ${newStatus}: ${count} matched, ` +
				`${apply ? `${modified} modified` : `WOULD modify ${count}`}`
		);
	}

	summary.push({
		step: '3. cv_inspections status enum',
		matched: totalMatched,
		modified: apply ? totalModified : 0,
		skipped: 0,
		notes: 'pending→queued, processing→running, complete→completed'
	});
}

// ============================================================
// Main
// ============================================================

async function main(): Promise<void> {
	console.log('='.repeat(72));
	console.log(`CV-PIPELINE-V2 migration — mode: ${apply ? 'APPLY (writing changes)' : 'DRY-RUN (report only)'}`);
	console.log('='.repeat(72));
	if (!apply) {
		console.log('No writes will be performed. Re-run with --apply to execute.');
	}

	await mongoose.connect(MONGODB_URI as string);
	const db = mongoose.connection.db;
	if (!db) throw new Error('mongoose.connection.db unavailable after connect');
	console.log(`Connected to database: ${db.databaseName}`);

	try {
		await migrateImageLabels(db);
		await migrateProjectClassifiers(db);
		await migrateInspectionStatuses(db);

		// Summary table
		console.log('\n' + '='.repeat(72));
		console.log(`SUMMARY (${apply ? 'APPLIED' : 'DRY-RUN — nothing written'})`);
		console.log('='.repeat(72));
		const header = `${'Step'.padEnd(44)} ${'Matched'.padStart(8)} ${'Modified'.padStart(9)} ${'Skipped'.padStart(8)}`;
		console.log(header);
		console.log('-'.repeat(header.length));
		for (const row of summary) {
			console.log(
				`${row.step.padEnd(44)} ${String(row.matched).padStart(8)} ` +
					`${String(row.modified).padStart(9)} ${String(row.skipped).padStart(8)}  ${row.notes}`
			);
		}
		if (!apply) {
			console.log('\nDry-run complete. Run again with --apply to write these changes.');
		}
	} finally {
		await mongoose.disconnect();
	}
}

main().catch((err) => {
	console.error('Migration failed:', err);
	process.exit(1);
});
