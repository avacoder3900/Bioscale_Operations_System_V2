/**
 * Audit: find all WI-01 / wi-01 / WI01- references in Mongo.
 * Read-only.
 */
import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
dotenv.config();
(async () => {
	await mongoose.connect(process.env.MONGODB_URI!);
	const db = mongoose.connection.db!;

	console.log('=== ProcessConfiguration rows mentioning backing / WI-01 ===');
	const procCfg = await db.collection('process_configurations').find({
		$or: [
			{ processType: 'backing' },
			{ processName: /WI-?01/i }
		]
	}).toArray();
	for (const p of procCfg as any[]) {
		console.log(`  _id=${p._id}  type=${p.processType}  name=${p.processName}`);
	}

	console.log('\n=== LotRecord count by processConfig.processType ===');
	const typeAgg = await db.collection('lot_records').aggregate([
		{ $group: { _id: '$processConfig.processType', n: { $sum: 1 } } }
	]).toArray();
	for (const t of typeAgg) console.log(`  type=${t._id ?? '(none)'}: ${t.n}`);

	console.log('\n=== LotRecord qrCodeRef prefix distribution (first 10 unique prefixes) ===');
	const prefixes = await db.collection('lot_records').aggregate([
		{ $match: { qrCodeRef: { $exists: true, $ne: null } } },
		{ $project: { prefix: { $substrBytes: ['$qrCodeRef', 0, 5] } } },
		{ $group: { _id: '$prefix', n: { $sum: 1 } } },
		{ $sort: { n: -1 } },
		{ $limit: 10 }
	]).toArray();
	for (const p of prefixes) console.log(`  prefix="${p._id}" : ${p.n}`);

	console.log('\n=== LotRecord outputLotNumber format samples ===');
	const samples = await db.collection('lot_records').find({}).sort({ createdAt: -1 }).limit(5).project({ _id: 1, outputLotNumber: 1, qrCodeRef: 1, 'processConfig.processType': 1, 'processConfig.processName': 1 }).toArray();
	for (const s of samples as any[]) {
		console.log(`  _id=${s._id}  qrCodeRef=${s.qrCodeRef}  outputLotNumber=${s.outputLotNumber}  type=${s.processConfig?.processType}  name=${s.processConfig?.processName}`);
	}

	console.log('\n=== AuditLog rows referencing WI-01 in reason or newData ===');
	const auditHits = await db.collection('audit_logs').countDocuments({
		$or: [
			{ reason: /WI-?01/i },
			{ 'newData.notes': /WI-?01/i }
		]
	});
	console.log(`  count: ${auditHits}`);

	console.log('\n=== ManufacturingMaterialTransaction notes referencing WI-01 ===');
	const txnHits = await db.collection('manufacturing_material_transactions').countDocuments({
		notes: /WI-?01/i
	});
	const invTxnHits = await db.collection('inventory_transactions').countDocuments({
		notes: /WI-?01/i
	});
	console.log(`  manufacturing_material_transactions: ${txnHits}`);
	console.log(`  inventory_transactions: ${invTxnHits}`);

	console.log('\n=== ProcessAnalyticsEvent + SpecLimit + FmeaRecord with processType=wi-01 ===');
	for (const col of ['process_analytics_events', 'spec_limits', 'fmea_records']) {
		const n = await db.collection(col).countDocuments({ processType: 'wi-01' });
		console.log(`  ${col}: ${n}`);
	}

	console.log('\n=== WorkInstruction docs (any mentioning WI-01) ===');
	const wiDocs = await db.collection('work_instructions').find({
		$or: [{ wiNumber: /WI-?01/i }, { title: /WI-?01/i }, { code: /WI-?01/i }]
	}).project({ _id: 1, wiNumber: 1, title: 1, code: 1 }).toArray();
	for (const w of wiDocs as any[]) console.log(`  _id=${w._id}  wiNumber=${w.wiNumber}  title=${w.title}  code=${w.code}`);
	if (wiDocs.length === 0) console.log('  (none)');

	console.log('\n=== Total LotRecord count ===');
	const totalLots = await db.collection('lot_records').countDocuments({});
	console.log(`  total: ${totalLots}`);

	await mongoose.disconnect();
})();
