/**
 * Read-only census of the active fleet's validation cycles (2026-09-10).
 * For each non-retired SPU: lifecycle status, when it last ENTERED servicing,
 * the rollup on the record, and what evidence exists AFTER that servicing entry.
 */
import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
dotenv.config();

async function main() {
	await mongoose.connect(process.env.MONGODB_URI!);
	const db = mongoose.connection.db!;
	const spus = await db.collection('spus').find({ status: { $ne: 'retired' } })
		.project({ udi: 1, status: 1, validation: 1, validationResetAt: 1, statusTransitions: 1 })
		.sort({ udi: 1 }).toArray();
	const openJobs = await db.collection('service_records').aggregate([
		{ $match: { status: 'open' } }, { $group: { _id: '$spuId', n: { $sum: 1 } } }
	]).toArray();
	const openBySpu = new Map(openJobs.map((o: any) => [o._id, o.n]));

	const fmt = (d: any) => (d ? new Date(d).toISOString().slice(0, 16) : '—');
	const st = (r: any) => `${r?.status ?? 'pending'}@${fmt(r?.completedAt)}`;

	for (const s of spus) {
		const entries = (s.statusTransitions ?? []).filter((t: any) => t.to === 'servicing').map((t: any) => new Date(t.changedAt).getTime());
		const lastSvc = entries.length ? new Date(Math.max(...entries)) : null;
		const after = lastSvc ?? new Date(0);
		const [mag, thermo, optics] = await Promise.all([
			db.collection('validation_sessions').find({ spuId: s._id, type: { $in: ['mag', 'magnetometer'] }, startedAt: { $gte: after } }).project({ overallPassed: 1, startedAt: 1 }).sort({ startedAt: -1 }).toArray(),
			db.collection('validation_sessions').find({ spuId: s._id, type: 'thermo', startedAt: { $gte: after } }).project({ overallPassed: 1, passed: 1, status: 1, startedAt: 1 }).sort({ startedAt: -1 }).toArray(),
			db.collection('cartridge_records').find({ $or: [{ assayCategory: 'optical_test' }, { assayId: 'A9EB41AD' }], 'device.name': s.udi, createdAt: { $gte: after }, 'rawData.readings.0': { $exists: true } }).project({ createdAt: 1 }).sort({ createdAt: -1 }).toArray()
		]);
		const v = s.validation ?? {};
		console.log(
			`${s.udi} ${String(s.status).padEnd(10)} svcEntry=${fmt(lastSvc)} reset=${fmt(s.validationResetAt)} openJobs=${openBySpu.get(s._id) ?? 0}\n` +
			`   rollup  mag=${st(v.magnetometer)} thermo=${st(v.thermocouple)} optics=${st(v.spectrophotometer)}\n` +
			`   after   mag=${mag.length}${mag[0] ? `(latest ${mag[0].overallPassed ? 'PASS' : 'fail'} ${fmt(mag[0].startedAt)})` : ''} ` +
			`thermo=${thermo.length}${thermo[0] ? `(latest ${thermo[0].overallPassed ?? thermo[0].passed} ${thermo[0].status} ${fmt(thermo[0].startedAt)})` : ''} ` +
			`optics=${optics.length}${optics[0] ? `(latest ${fmt(optics[0].createdAt)})` : ''}`
		);
	}
	await mongoose.disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
