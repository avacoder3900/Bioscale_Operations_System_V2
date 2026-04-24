import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
dotenv.config();

async function main() {
	await mongoose.connect(process.env.MONGODB_URI!);
	const db = mongoose.connection.db!;
	const removals = await db.collection('manual_cartridge_removals').find({
		'operator.username': 'system-backfill-2026-04-23'
	}).toArray() as any[];
	console.log(`manual_cartridge_removals with operator='system-backfill-2026-04-23': ${removals.length}`);
	const cartIds = new Set<string>();
	for (const r of removals) for (const cid of r.cartridgeIds ?? []) cartIds.add(cid);
	console.log(`distinct cartridge IDs in those removals: ${cartIds.size}`);

	const checkoutAudits = await db.collection('audit_logs').countDocuments({
		action: 'CHECKOUT',
		recordId: { $in: Array.from(cartIds) }
	});
	console.log(`existing CHECKOUT audit entries for those cartridges: ${checkoutAudits}`);

	await mongoose.disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
