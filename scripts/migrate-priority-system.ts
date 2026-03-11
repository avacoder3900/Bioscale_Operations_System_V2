/**
 * Migration: Update kanban task priorities from high/medium/low to critical/ready/queued.
 *
 * Usage: npx tsx scripts/migrate-priority-system.ts
 *
 * Mapping:
 *   high   → critical
 *   medium → ready
 *   low    → queued
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

async function migrate() {
	console.log('Connecting to MongoDB...');
	await mongoose.connect(MONGODB_URI!);
	console.log('Connected!\n');

	const db = mongoose.connection.db!;
	const collection = db.collection('kanban_tasks');

	const mapping: Record<string, string> = {
		high: 'critical',
		medium: 'ready',
		low: 'queued'
	};

	for (const [oldValue, newValue] of Object.entries(mapping)) {
		const result = await collection.updateMany(
			{ priority: oldValue },
			{ $set: { priority: newValue } }
		);
		console.log(`  ${oldValue} → ${newValue}: ${result.modifiedCount} tasks updated`);
	}

	// Also update any tasks seeded into 'kanbantasks' collection (seed-domain-data uses this name)
	const altCollection = db.collection('kanbantasks');
	const altCount = await altCollection.countDocuments();
	if (altCount > 0) {
		console.log('\nFound tasks in "kanbantasks" collection, migrating those too...');
		for (const [oldValue, newValue] of Object.entries(mapping)) {
			const result = await altCollection.updateMany(
				{ priority: oldValue },
				{ $set: { priority: newValue } }
			);
			if (result.modifiedCount > 0) {
				console.log(`  ${oldValue} → ${newValue}: ${result.modifiedCount} tasks updated`);
			}
		}
	}

	console.log('\nMigration complete!');
	await mongoose.disconnect();
}

migrate().catch((err) => {
	console.error('Migration failed:', err);
	process.exit(1);
});
