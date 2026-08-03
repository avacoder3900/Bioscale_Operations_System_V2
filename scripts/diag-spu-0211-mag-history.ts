/**
 * Read-only: device BT-M01-0000-0211 — list ALL magnetometer validation data:
 * every validation_session (type mag/magnetometer), with timestamps, test
 * counters, and raw-data fingerprints, plus the embedded
 * spu.validation.magnetometer snapshot. Goal: determine whether repeat runs
 * accumulate as separate sessions or overwrite each other.
 */
import mongoose from 'mongoose';
import crypto from 'crypto';
import * as dotenv from 'dotenv';
dotenv.config();

const UDI = 'BT-M01-0000-0211';

async function main() {
	await mongoose.connect(process.env.MONGODB_URI!);
	const db = mongoose.connection.db!;
	const spus = db.collection('spus');
	const sessions = db.collection('validation_sessions');

	const spu = await spus.findOne({ $or: [{ udi: UDI }, { barcode: UDI }] }) as any;
	if (!spu) {
		console.log(`No SPU found with udi/barcode '${UDI}'.`);
		const near = await spus.find({ udi: /0211/ }).project({ _id: 1, udi: 1 }).toArray();
		console.log(`near matches: ${JSON.stringify(near)}`);
		await mongoose.disconnect();
		return;
	}

	console.log('='.repeat(72));
	console.log(' SPU');
	console.log('='.repeat(72));
	console.log(`  _id:      ${spu._id}`);
	console.log(`  udi:      ${spu.udi}`);
	console.log(`  particle: ${spu.particleLink?.particleSerial ?? '-'} (${spu.particleLink?.particleDeviceId ?? '-'})`);

	console.log('\n' + '='.repeat(72));
	console.log(' EMBEDDED spu.validation.magnetometer (single slot — latest only)');
	console.log('='.repeat(72));
	const mag = spu.validation?.magnetometer;
	if (!mag) {
		console.log('  (none)');
	} else {
		console.log(`  status:      ${mag.status}`);
		console.log(`  sessionId:   ${mag.sessionId}`);
		console.log(`  completedAt: ${mag.completedAt?.toISOString?.() ?? mag.completedAt}`);
		console.log(`  rawData:     ${mag.rawData ? `present (${String(mag.rawData).length} chars)` : 'none'}`);
	}

	console.log('\n' + '='.repeat(72));
	console.log(' validation_sessions — ALL mag sessions for this SPU');
	console.log('='.repeat(72));
	const sess = await sessions
		.find({
			$and: [
				{ $or: [{ spuId: spu._id }, { spuUdi: spu.udi }] },
				{ type: { $in: ['mag', 'magnetometer'] } }
			]
		})
		.sort({ createdAt: 1 })
		.toArray() as any[];

	console.log(`  TOTAL SAVED MAG SESSIONS: ${sess.length}\n`);
	for (const s of sess) {
		const raw = typeof s.rawData === 'string' ? s.rawData : JSON.stringify(s.rawData ?? '');
		const counterMatch = raw.match(/^#(\d+)\t/);
		const fp = raw ? crypto.createHash('md5').update(raw).digest('hex').slice(0, 8) : '(no raw)';
		const wells = Array.isArray(s.magResults) ? s.magResults.length : 0;
		console.log(`  ${s.createdAt?.toISOString?.() ?? s.createdAt}  _id=${s._id}`);
		console.log(`      type=${s.type} status=${s.status} overallPassed=${s.overallPassed}${s.override ? ' [OVERRIDDEN]' : ''}`);
		console.log(`      deviceTestCounter=${counterMatch ? '#' + counterMatch[1] : '-'}  rawData=${raw.length} chars (md5:${fp})  magResults wells=${wells}`);
		console.log(`      failureReasons=${(s.failureReasons ?? []).length ? JSON.stringify(s.failureReasons) : '[]'}`);
	}

	// Distinct raw datasets vs session count
	const fps = new Set(sess.map((s) => crypto.createHash('md5').update(String(s.rawData ?? s._id)).digest('hex')));
	console.log(`\n  distinct raw datasets: ${fps.size} across ${sess.length} sessions`);
	if (mag?.sessionId) {
		const idx = sess.findIndex((s) => s._id === mag.sessionId);
		console.log(`  embedded SPU snapshot points at session ${mag.sessionId} (${idx >= 0 ? `#${idx + 1} of ${sess.length} chronologically` : 'NOT in list above'})`);
	}

	await mongoose.disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
