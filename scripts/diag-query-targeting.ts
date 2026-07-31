/** Read-only: collection sizes + actual server-side indexes for the Atlas
 *  query-targeting investigation (2026-07-31). */
import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
dotenv.config();

const COLLECTIONS = [
	'audit_log', 'kanban_tasks', 'kanban_projects', 'workflow_violations', 'kanban_policy',
	'cartridge_records', 'spus', 'cv_images', 'cv_inspections', 'device_logs', 'device_events',
	'device_crashes', 'scanner_events', 'scanner_triggers', 'ot2_bridge_commands',
	'agent_messages', 'agent_queries', 'part_definitions', 'equipment', 'validation_sessions',
	'robot_arm_runs', 'inventory_transactions', 'sessions'
];

async function main() {
	await mongoose.connect(process.env.MONGODB_URI!);
	const db = mongoose.connection.db!;
	const existing = new Set((await db.listCollections().toArray()).map((c) => c.name));

	const rows: { name: string; count: number; avgKb: number; indexes: string[] }[] = [];
	for (const name of COLLECTIONS) {
		if (!existing.has(name)) continue;
		const coll = db.collection(name);
		const count = await coll.estimatedDocumentCount();
		const stats: any = await db.command({ collStats: name, scale: 1024 }).catch(() => null);
		const indexes = (await coll.indexes()).map((i) => JSON.stringify(i.key));
		rows.push({ name, count, avgKb: stats ? Math.round((stats.avgObjSize ?? 0) / 1024 * 10) / 10 : 0, indexes });
	}
	rows.sort((a, b) => b.count - a.count);
	for (const r of rows) {
		console.log(`\n${r.name}: ${r.count} docs (avg ${r.avgKb}KB)`);
		for (const i of r.indexes) console.log(`   ${i}`);
	}
	await mongoose.disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
