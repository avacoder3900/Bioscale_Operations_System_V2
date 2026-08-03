/**
 * Read-only: find device BT-M01-0000-0245 and report any magnetometer
 * validation data — both embedded (spu.validation.magnetometer) and in the
 * validation_sessions collection.
 */
import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
dotenv.config();

const TARGET = 'BT-M01-0000-0245';

async function main() {
	await mongoose.connect(process.env.MONGODB_URI!);
	const db = mongoose.connection.db!;
	const spus = db.collection('spus');
	const sessions = db.collection('validation_sessions');

	const spu = await spus.findOne({
		$or: [{ udi: TARGET }, { barcode: TARGET }, { _id: TARGET as any }]
	}) as any;

	if (!spu) {
		console.log(`No SPU found with udi/barcode/_id = '${TARGET}'.`);
		// Loose fallback: anything containing 0245
		const near = await spus
			.find({ $or: [{ udi: /0245/ }, { barcode: /0245/ }] })
			.project({ _id: 1, udi: 1, barcode: 1 })
			.limit(10)
			.toArray();
		console.log(`Near matches containing '0245': ${near.length}`);
		for (const n of near as any[]) console.log(`  _id=${n._id} udi=${n.udi} barcode=${n.barcode}`);
		await mongoose.disconnect();
		return;
	}

	console.log('='.repeat(72));
	console.log(' SPU FOUND');
	console.log('='.repeat(72));
	console.log(`  _id:      ${spu._id}`);
	console.log(`  udi:      ${spu.udi}`);
	console.log(`  barcode:  ${spu.barcode}`);
	console.log(`  particle: ${spu.particleLink?.particleSerial ?? '-'} (${spu.particleLink?.particleDeviceId ?? '-'})`);

	console.log('\n' + '='.repeat(72));
	console.log(' EMBEDDED validation.magnetometer');
	console.log('='.repeat(72));
	const mag = spu.validation?.magnetometer;
	if (!mag) {
		console.log('  (no validation.magnetometer object on the SPU)');
	} else {
		console.log(`  status:         ${mag.status ?? '-'}`);
		console.log(`  sessionId:      ${mag.sessionId ?? '-'}`);
		console.log(`  completedAt:    ${mag.completedAt ?? '-'}`);
		console.log(`  failureReasons: ${JSON.stringify(mag.failureReasons ?? [])}`);
		console.log(`  rawData:        ${mag.rawData ? `present (${JSON.stringify(mag.rawData).length} chars)` : 'none'}`);
		console.log(`  results:        ${mag.results ? JSON.stringify(mag.results, null, 2).split('\n').join('\n                  ') : 'none'}`);
		console.log(`  criteriaUsed:   ${mag.criteriaUsed ? JSON.stringify(mag.criteriaUsed) : 'none'}`);
	}
	console.log(`\n  overall validation.status: ${spu.validation?.status ?? '-'}`);

	console.log('\n' + '='.repeat(72));
	console.log(' validation_sessions (magnetometer) for this SPU');
	console.log('='.repeat(72));
	const sess = await sessions
		.find({
			$and: [
				{ $or: [{ spuId: spu._id }, { spuUdi: spu.udi }, { barcode: spu.barcode ?? '__none__' }] },
				{ type: /magnet/i }
			]
		})
		.sort({ createdAt: -1 })
		.toArray() as any[];

	console.log(`  sessions found: ${sess.length}`);
	for (const s of sess) {
		console.log(`\n  session ${s._id}`);
		console.log(`    type=${s.type} status=${s.status} overallPassed=${s.overallPassed}`);
		console.log(`    startedAt=${s.startedAt?.toISOString?.() ?? s.startedAt}  completedAt=${s.completedAt?.toISOString?.() ?? s.completedAt}`);
		console.log(`    failureReasons=${JSON.stringify(s.failureReasons ?? [])}`);
		console.log(`    rawData=${s.rawData ? `present (${JSON.stringify(s.rawData).length} chars)` : 'none'}  magResults=${s.magResults ? `present (${JSON.stringify(s.magResults).length} chars)` : 'none'}`);
		console.log(`    results[]=${(s.results ?? []).length} entries`);
		if (s.magResults) {
			console.log(`    magResults: ${JSON.stringify(s.magResults, null, 2).split('\n').join('\n    ')}`);
		}
		if (s.override) console.log(`    OVERRIDE by ${s.override.by?.username} at ${s.override.at}: ${s.override.reason}`);
	}

	// Any non-magnetometer sessions, for context
	const others = await sessions
		.find({ $or: [{ spuId: spu._id }, { spuUdi: spu.udi }] })
		.project({ _id: 1, type: 1, status: 1, overallPassed: 1, createdAt: 1 })
		.sort({ createdAt: -1 })
		.toArray() as any[];
	console.log(`\n  (all validation sessions for this SPU, any type: ${others.length})`);
	for (const o of others) console.log(`    ${o.createdAt?.toISOString?.() ?? o.createdAt}  type=${o.type} status=${o.status} passed=${o.overallPassed}`);

	await mongoose.disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
