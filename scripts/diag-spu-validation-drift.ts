/**
 * Read-only diagnostic: how much unit data lives OUTSIDE the Spu document
 * (sacred-record drift audit, 2026-09-04). Counts + linkage checks only.
 * Run: npx tsx scripts/diag-spu-validation-drift.ts
 */
import 'dotenv/config';
import mongoose from 'mongoose';

async function main() {
	const uri = process.env.MONGODB_URI;
	if (!uri) throw new Error('MONGODB_URI not set');
	await mongoose.connect(uri);
	const db = mongoose.connection.db!;

	const cols = (await db.listCollections().toArray()).map((c) => c.name).sort();
	console.log('--- collections (validation/session/run/device related) ---');
	console.log(cols.filter((n) => /valid|session|run|device|optic|thermo|mag|signat|assembl/i.test(n)).join('\n'));

	const spus = db.collection('spus');
	const total = await spus.countDocuments();
	console.log(`\n--- spus (${total}) validation rollup state ---`);
	for (const k of ['magnetometer', 'thermocouple', 'spectrophotometer', 'lux']) {
		const agg = await spus
			.aggregate([{ $group: { _id: `$validation.${k}.status`, n: { $sum: 1 } } }, { $sort: { n: -1 } }])
			.toArray();
		console.log(`${k.padEnd(18)}`, agg.map((r) => `${r._id ?? 'unset'}=${r.n}`).join('  '));
	}
	const withAttach = await spus.countDocuments({ 'attachments.0': { $exists: true } });
	const withJournal = await spus.countDocuments({ 'journal.0': { $exists: true } });
	const withInlineService = await spus.countDocuments({ 'serviceRecords.0': { $exists: true } });
	const withAssembly = await spus.countDocuments({ 'assembly.sessionId': { $exists: true } });
	const withSignature = await spus.countDocuments({ 'signature._id': { $exists: true } });
	console.log(`attachments>0: ${withAttach}  journal>0: ${withJournal}  inline serviceRecords>0: ${withInlineService}  assembly snapshot: ${withAssembly}  signature embed: ${withSignature}`);

	// Satellite collections keyed to SPUs
	async function report(name: string, spuKey: string, extra?: Record<string, unknown>) {
		if (!cols.includes(name)) {
			console.log(`${name}: (collection not found)`);
			return;
		}
		const c = db.collection(name);
		const n = await c.countDocuments(extra ?? {});
		const withKey = await c.countDocuments({ ...(extra ?? {}), [spuKey]: { $exists: true, $nin: [null, ''] } });
		console.log(`${name.padEnd(28)} total=${n}  with ${spuKey}=${withKey}`);
	}

	console.log('\n--- satellite collections ---');
	await report('validation_sessions', 'spuId');
	await report('validation_runs', 'members');
	await report('assembly_sessions', 'spuId');
	await report('electronic_signatures', 'entityId');
	await report('service_records', 'spuId');
	await report('service_groups', '_id');
	await report('device_events', 'deviceId');
	await report('device_logs', 'deviceId');
	await report('device_crashes', 'deviceId');
	await report('webhook_logs', 'deviceId');
	await report('inventory_transactions', 'spuId');
	await report('optical_test_cartridges', 'spuId');

	console.log('\n--- validation_sessions by type/status, and rollup drift ---');
	if (cols.includes('validation_sessions')) {
		const vs = db.collection('validation_sessions');
		const byType = await vs
			.aggregate([{ $group: { _id: { t: '$type', s: '$status' }, n: { $sum: 1 } } }, { $sort: { n: -1 } }])
			.toArray();
		for (const r of byType) console.log(`  type=${r._id.t ?? '?'} status=${r._id.s ?? '?'} n=${r.n}`);

		// Sessions whose spuId doesn't resolve to a live SPU
		const spuIds = new Set((await spus.find({}).project({ _id: 1 }).toArray()).map((s) => String(s._id)));
		const sessSpuIds = await vs.distinct('spuId');
		const orphaned = sessSpuIds.filter((id) => id && !spuIds.has(String(id)));
		console.log(`  sessions referencing ${sessSpuIds.length} distinct spuIds; ${orphaned.length} spuIds no longer exist (orphaned by hard-deletes)`);

		// Passed sessions where the SPU rollup doesn't say passed
		const passed = await vs
			.find({ overallPassed: true })
			.project({ spuId: 1, type: 1, completedAt: 1 })
			.toArray();
		let driftCount = 0;
		const driftSamples: string[] = [];
		for (const s of passed) {
			const spu = await spus.findOne({ _id: s.spuId }, { projection: { udi: 1, validation: 1 } });
			if (!spu) continue;
			const t = String(s.type ?? '').toLowerCase();
			const key = t.includes('mag') ? 'magnetometer' : t.includes('thermo') ? 'thermocouple' : t.includes('spec') || t.includes('opt') ? 'spectrophotometer' : t.includes('lux') ? 'lux' : null;
			if (!key) continue;
			const rolled = (spu as any).validation?.[key]?.status;
			if (rolled !== 'passed') {
				driftCount++;
				if (driftSamples.length < 8) driftSamples.push(`${(spu as any).udi} ${key}: session passed, rollup=${rolled ?? 'unset'}`);
			}
		}
		console.log(`  DRIFT: ${driftCount} passed sessions whose SPU rollup is not 'passed'`);
		for (const d of driftSamples) console.log(`    ${d}`);
	}

	console.log('\n--- validation_runs contents (if present) ---');
	for (const name of cols.filter((n) => /validation_run/i.test(n))) {
		const c = db.collection(name);
		const n = await c.countDocuments();
		const sample = await c.findOne({});
		console.log(`${name}: ${n} docs; top-level keys of sample: ${sample ? Object.keys(sample).join(', ') : '(empty)'}`);
	}

	console.log('\n--- audit log keying (detail-page query mismatch check) ---');
	const al = db.collection('audit_logs');
	const totalAl = await al.countDocuments();
	const withEntityId = await al.countDocuments({ entityId: { $exists: true } });
	const withRecordId = await al.countDocuments({ recordId: { $exists: true } });
	const spusByRecordId = await al.countDocuments({ tableName: 'spus', recordId: { $exists: true } });
	const spusByEntityId = await al.countDocuments({ entityId: { $exists: true }, tableName: 'spus' });
	console.log(`audit_logs total=${totalAl}  with entityId=${withEntityId}  with recordId=${withRecordId}  tableName=spus&recordId=${spusByRecordId}  tableName=spus&entityId=${spusByEntityId}`);

	await mongoose.disconnect();
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
