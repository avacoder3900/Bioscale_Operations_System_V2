#!/usr/bin/env node
/**
 * One-time migration: convert KanbanTask.priority (string enum) → prioritized (boolean)
 *
 * Run with:
 *   node scripts/migrate-priority-to-prioritized.js
 *
 * Requires MONGODB_URI in environment or .env file.
 *
 * Mapping:
 *   priority === 'critical' → prioritized: true
 *   anything else (or missing) → prioritized: false
 *
 * After converting, removes the old `priority` field from all documents.
 */

import { config } from 'dotenv';
import { MongoClient } from 'mongodb';

config(); // Load .env

const uri = process.env.MONGODB_URI;
if (!uri) {
	console.error('ERROR: MONGODB_URI environment variable is not set.');
	process.exit(1);
}

async function main() {
	const client = new MongoClient(uri);

	try {
		await client.connect();
		console.log('Connected to MongoDB.');

		const db = client.db(); // uses the database from the URI
		const collection = db.collection('kanban_tasks');

		// Count documents that still have the old priority field
		const totalWithPriority = await collection.countDocuments({ priority: { $exists: true } });
		console.log(`Found ${totalWithPriority} task(s) with legacy 'priority' field.`);

		if (totalWithPriority === 0) {
			console.log('Nothing to migrate. Exiting.');
			return;
		}

		// Step 1: Set prioritized = true for tasks with priority === 'critical'
		const criticalResult = await collection.updateMany(
			{ priority: 'critical' },
			{
				$set: { prioritized: true },
				$unset: { priority: '' }
			}
		);
		console.log(`Migrated ${criticalResult.modifiedCount} 'critical' task(s) → prioritized: true`);

		// Step 2: Set prioritized = false for all remaining tasks that still have a priority field
		const otherResult = await collection.updateMany(
			{ priority: { $exists: true } },
			{
				$set: { prioritized: false },
				$unset: { priority: '' }
			}
		);
		console.log(`Migrated ${otherResult.modifiedCount} other task(s) → prioritized: false`);

		// Verify
		const remaining = await collection.countDocuments({ priority: { $exists: true } });
		if (remaining === 0) {
			console.log('Migration complete. No legacy priority fields remain.');
		} else {
			console.warn(`WARNING: ${remaining} document(s) still have a 'priority' field. Investigate manually.`);
		}
	} finally {
		await client.close();
		console.log('Disconnected from MongoDB.');
	}
}

main().catch((err) => {
	console.error('Migration failed:', err);
	process.exit(1);
});
