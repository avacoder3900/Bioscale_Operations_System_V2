import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
dotenv.config();

const COLLECTIONS = [
	'reagent_catalog',
	'reagent_inventory',
	'protocol_definitions',
	'protocol_executions',
	'reagent_protocol_templates',
	'reagent_lots',
	'reagent_batch_records'
];

async function main() {
	await mongoose.connect(process.env.MONGODB_URI!);
	const db = mongoose.connection.db!;

	const existingNames = (await db.listCollections().toArray()).map((c) => c.name);

	console.log('=== Collection counts ===');
	for (const name of COLLECTIONS) {
		if (!existingNames.includes(name)) {
			console.log(`  ${name}: <does not exist>`);
			continue;
		}
		const n = await db.collection(name).countDocuments();
		console.log(`  ${name}: ${n}`);
	}

	console.log('\n=== Sample shapes (1 doc each, top-level keys) ===');
	for (const name of COLLECTIONS) {
		if (!existingNames.includes(name)) continue;
		const sample = await db.collection(name).findOne({}, { projection: undefined });
		if (!sample) {
			console.log(`  ${name}: <empty>`);
			continue;
		}
		const keys = Object.keys(sample).sort();
		console.log(`  ${name}: ${keys.join(', ')}`);
	}

	console.log('\n=== reagent_catalog by type/category ===');
	if (existingNames.includes('reagent_catalog')) {
		const agg = await db
			.collection('reagent_catalog')
			.aggregate([
				{ $group: { _id: { type: '$type', category: '$category' }, n: { $sum: 1 } } },
				{ $sort: { n: -1 } }
			])
			.toArray();
		for (const r of agg as any[]) {
			console.log(`  type=${r._id?.type ?? '<null>'} / category=${r._id?.category ?? '<null>'}: ${r.n}`);
		}
	}

	console.log('\n=== reagent_inventory by status/type ===');
	if (existingNames.includes('reagent_inventory')) {
		const agg = await db
			.collection('reagent_inventory')
			.aggregate([
				{ $group: { _id: { type: '$type', status: '$status' }, n: { $sum: 1 } } },
				{ $sort: { n: -1 } }
			])
			.toArray();
		for (const r of agg as any[]) {
			console.log(`  type=${r._id?.type ?? '<null>'} / status=${r._id?.status ?? '<null>'}: ${r.n}`);
		}
	}

	console.log('\n=== protocol_definitions by name/version ===');
	if (existingNames.includes('protocol_definitions')) {
		const rows = await db
			.collection('protocol_definitions')
			.find({}, { projection: { name: 1, version: 1, status: 1, category: 1 } })
			.toArray();
		for (const r of rows as any[]) {
			console.log(`  ${r.name} v${r.version}  [${r.status ?? '?'}, ${r.category ?? '?'}]`);
		}
	}

	console.log('\n=== reagent_protocol_templates ===');
	if (existingNames.includes('reagent_protocol_templates')) {
		const rows = await db
			.collection('reagent_protocol_templates')
			.find({}, { projection: { name: 1, slug: 1, version: 1, status: 1 } })
			.toArray();
		for (const r of rows as any[]) {
			console.log(`  ${r.name} v${r.version}  slug=${r.slug ?? '?'}  [${r.status ?? '?'}]`);
		}
	}

	console.log('\n=== protocol_executions by status ===');
	if (existingNames.includes('protocol_executions')) {
		const agg = await db
			.collection('protocol_executions')
			.aggregate([{ $group: { _id: '$status', n: { $sum: 1 } } }])
			.toArray();
		for (const r of agg as any[]) console.log(`  ${r._id ?? '<null>'}: ${r.n}`);
	}

	console.log('\n=== reagent_lots by status ===');
	if (existingNames.includes('reagent_lots')) {
		const agg = await db
			.collection('reagent_lots')
			.aggregate([{ $group: { _id: '$status', n: { $sum: 1 } } }])
			.toArray();
		for (const r of agg as any[]) console.log(`  ${r._id ?? '<null>'}: ${r.n}`);

		const recent = await db
			.collection('reagent_lots')
			.find({}, { projection: { lotBarcode: 1, templateName: 1, status: 1, startedAt: 1 } })
			.sort({ startedAt: -1 })
			.limit(15)
			.toArray();
		console.log('\n  Recent 15 lots:');
		for (const r of recent as any[]) {
			console.log(`    ${r.lotBarcode}  template=${r.templateName ?? '?'}  status=${r.status}`);
		}
	}

	console.log('\n=== Lineage check: reagent_inventory with preparedFromExecutionId ===');
	if (existingNames.includes('reagent_inventory')) {
		const linked = await db
			.collection('reagent_inventory')
			.countDocuments({ preparedFromExecutionId: { $exists: true, $nin: ['', null] } });
		console.log(`  inventory items linked to a protocol_execution: ${linked}`);
	}

	await mongoose.disconnect();
}
main().catch((e) => {
	console.error(e);
	process.exit(1);
});
