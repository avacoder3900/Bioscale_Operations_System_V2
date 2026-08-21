/**
 * Read-only follow-up: BT-M01-0000-0245 had no sessions keyed by spuId/spuUdi.
 * Check by particleDeviceId and loose '0245' matches, plus collection totals.
 */
import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
dotenv.config();

async function main() {
	await mongoose.connect(process.env.MONGODB_URI!);
	const db = mongoose.connection.db!;
	const sessions = db.collection('validation_sessions');

	const byParticle = await sessions
		.find({ particleDeviceId: '0a10aced202194944a07117c' })
		.project({ _id: 1, type: 1, status: 1, overallPassed: 1, spuUdi: 1, spuId: 1, createdAt: 1 })
		.toArray();
	console.log(`by particleDeviceId: ${byParticle.length}`);
	for (const x of byParticle) console.log('  ' + JSON.stringify(x));

	const loose = await sessions
		.find({ $or: [{ spuUdi: /0245/ }, { barcode: /0245/ }, { generatedBarcodeId: /0245/ }] })
		.project({ _id: 1, type: 1, status: 1, spuUdi: 1, barcode: 1, createdAt: 1 })
		.toArray();
	console.log(`loose '0245' match: ${loose.length}`);
	for (const x of loose) console.log('  ' + JSON.stringify(x));

	const totalMag = await sessions.countDocuments({ type: /magnet/i });
	const total = await sessions.countDocuments({});
	console.log(`total magnetometer sessions in collection: ${totalMag} (all types: ${total})`);

	// Distinct type values, in case 'magnetometer' is spelled differently
	const types = await sessions.aggregate([{ $group: { _id: '$type', n: { $sum: 1 } } }]).toArray();
	console.log('session types:', JSON.stringify(types));

	await mongoose.disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
