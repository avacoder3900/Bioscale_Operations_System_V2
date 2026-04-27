/**
 * AuditLog Mongoose model maps to collection 'audit_log' (singular).
 * Earlier diagnostics queried 'audit_logs' (plural). Check both.
 */
import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
dotenv.config();

async function main() {
	await mongoose.connect(process.env.MONGODB_URI!);
	const db = mongoose.connection.db!;
	const todayStart = new Date();
	todayStart.setHours(0, 0, 0, 0);

	for (const name of ['audit_log', 'audit_logs']) {
		const exists = await db.listCollections({ name }).toArray();
		const count = exists.length ? await db.collection(name).countDocuments() : 0;
		const today = exists.length
			? await db.collection(name).countDocuments({ changedAt: { $gte: todayStart } })
			: 0;
		console.log(`Collection '${name}': exists=${exists.length > 0}  totalDocs=${count}  today=${today}`);
	}
	console.log('');

	// The right one — audit_log — show today's entries
	const audits = await db
		.collection('audit_log')
		.find({ changedAt: { $gte: todayStart } })
		.sort({ changedAt: 1 })
		.toArray();
	console.log(`audit_log entries TODAY (${audits.length}):`);
	for (const a of audits as any[]) {
		console.log(`  ${a.changedAt?.toISOString?.()} ${a.action} ${a.tableName}/${a.recordId} by=${a.changedBy}`);
	}

	await mongoose.disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
