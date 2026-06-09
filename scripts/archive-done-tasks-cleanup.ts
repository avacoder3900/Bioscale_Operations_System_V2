/**
 * One-shot manual archive of all kanban tasks currently in `done` status.
 *
 * Distinct from the weekly cron (/api/cron/archive-done-tasks) in that this
 * script ignores the 24h min-age filter — every done task gets archived,
 * regardless of how recently it transitioned. Use this for initial cleanup
 * before the weekly cron starts running, or any time you want to clear the
 * board immediately.
 *
 * Run: `npx tsx scripts/archive-done-tasks-cleanup.ts`
 */
import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { nanoid } from 'nanoid';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
dotenv.config({ path: resolve(__dirname, '..', '.env') });

const URI = process.env.MONGODB_URI;
if (!URI) {
	console.error('MONGODB_URI missing in .env');
	process.exit(1);
}

async function main() {
	await mongoose.connect(URI!);
	const db = mongoose.connection.db!;
	const now = new Date();

	const tasks = db.collection('kanban_tasks');
	const audit = db.collection('audit_log');

	const candidates = await tasks
		.find({ status: 'done', archived: false }, { projection: { _id: 1, title: 1, statusChangedAt: 1 } })
		.toArray();
	console.log(`Found ${candidates.length} done tasks to archive.`);
	for (const t of candidates) {
		console.log(`  - ${t._id} :: ${t.title} (statusChangedAt=${t.statusChangedAt ?? 'none'})`);
	}

	if (candidates.length === 0) {
		console.log('Nothing to do.');
		await mongoose.disconnect();
		return;
	}

	const result = await tasks.updateMany(
		{ status: 'done', archived: false },
		{ $set: { archived: true, archivedAt: now } }
	);
	console.log(`\nArchived ${result.modifiedCount} tasks.`);

	await audit.insertOne({
		_id: nanoid(),
		tableName: 'kanban_tasks',
		recordId: 'manual-cleanup',
		action: 'UPDATE',
		newData: {
			archived: true,
			count: result.modifiedCount,
			source: 'archive-done-tasks-cleanup.ts',
			runAt: now.toISOString()
		},
		changedAt: now,
		changedBy: 'system-manual'
	});
	console.log('Wrote audit_log entry (recordId=manual-cleanup, changedBy=system-manual).');

	await mongoose.disconnect();
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
