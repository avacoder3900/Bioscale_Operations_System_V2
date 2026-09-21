/**
 * Read-only: sample type='mag' validation sessions to see how they key to
 * devices, and search every plausible key for SPU BT-M01-0000-0245
 * (_id BsRzjSDa-ZH-h3Vn_r40V, particle 0a10aced202194944a07117c).
 */
import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
dotenv.config();

const SPU_ID = 'BsRzjSDa-ZH-h3Vn_r40V';
const UDI = 'BT-M01-0000-0245';
const PARTICLE = '0a10aced202194944a07117c';

async function main() {
	await mongoose.connect(process.env.MONGODB_URI!);
	const db = mongoose.connection.db!;
	const sessions = db.collection('validation_sessions');

	const sample = await sessions.find({ type: 'mag' }).sort({ createdAt: -1 }).limit(3).toArray() as any[];
	console.log(`sample of ${sample.length} type='mag' sessions (keys + identifiers):`);
	for (const s of sample) {
		console.log(`  _id=${s._id} keys=[${Object.keys(s).join(', ')}]`);
		console.log(`    spuId=${s.spuId} spuUdi=${s.spuUdi} barcode=${s.barcode} generatedBarcodeId=${s.generatedBarcodeId} particleDeviceId=${s.particleDeviceId} status=${s.status} overallPassed=${s.overallPassed} createdAt=${s.createdAt?.toISOString?.()}`);
	}

	// Brute-force: any session of ANY type whose document JSON contains our identifiers
	const all = await sessions.find({}).toArray() as any[];
	const hits = all.filter((s) => {
		const j = JSON.stringify(s);
		return j.includes(SPU_ID) || j.includes(UDI) || j.includes(PARTICLE) || j.includes('0245');
	});
	console.log(`\nbrute-force scan of all ${all.length} sessions for SPU_ID/UDI/PARTICLE/'0245': ${hits.length} hits`);
	for (const s of hits) {
		console.log(`  _id=${s._id} type=${s.type} status=${s.status} overallPassed=${s.overallPassed} spuId=${s.spuId} spuUdi=${s.spuUdi} createdAt=${s.createdAt?.toISOString?.()}`);
	}

	await mongoose.disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
