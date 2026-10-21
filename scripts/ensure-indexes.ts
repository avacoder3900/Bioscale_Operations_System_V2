/**
 * Index management for BIMS (PERF-01 BM-05).
 *
 * connectDB() runs with autoIndex/autoCreate off in production, so indexes declared
 * with `schema.index()` are created here, deliberately, instead of by ~155 models
 * firing createCollection + createIndexes on every cold start.
 *
 *   npx tsx --tsconfig tsconfig.json scripts/ensure-indexes.ts           # report only
 *   npx tsx --tsconfig tsconfig.json scripts/ensure-indexes.ts --apply   # create missing
 *
 * Never syncIndexes(): users/sessions/roles/cartridge_records/assay_definitions/audit_log
 * are shared with the research app, whose models declare indexes BIMS does not.
 * An IndexOptionsConflict (e.g. a changed TTL) is reported, not forced.
 */
import 'dotenv/config';
import mongoose, { type Model } from 'mongoose';
import '../src/lib/server/db/models/index.js';

const uri = process.env.MONGODB_URI;
if (!uri) {
	console.error('MONGODB_URI not set in .env');
	process.exit(1);
}
const apply = process.argv.includes('--apply');

// PermissionShadowLog lives in src/lib/server/route-policy.ts, which imports SvelteKit
// modules a script cannot load. Its indexes, mirrored here — keep in step with that file.
const shadowIndexes: [Record<string, 1 | -1>, Record<string, unknown>][] = [
	[{ createdAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 30 }],
	[{ reason: 1, username: 1 }, {}]
];

const keyOf = (fields: Record<string, unknown>) =>
	Object.entries(fields)
		.map(([field, order]) => `${field}:${order}`)
		.join(',');

interface Row {
	model: string;
	collection: string;
	declared: number;
	missing: string;
	result: string;
}

async function existingKeys(collection: mongoose.mongo.Collection): Promise<string[]> {
	try {
		return (await collection.indexes()).map((index) => keyOf(index.key as Record<string, unknown>));
	} catch (error) {
		if ((error as { codeName?: string }).codeName === 'NamespaceNotFound') return [];
		throw error;
	}
}

async function inspectModel(name: string, model: Model<unknown>): Promise<Row> {
	const declared = model.schema.indexes().map(([fields]) => keyOf(fields as Record<string, unknown>));
	const existing = await existingKeys(model.collection.collection);
	const missing = declared.filter((key) => !existing.includes(key));
	let result = missing.length === 0 ? 'ok' : 'missing';
	if (apply && missing.length > 0) {
		try {
			await model.createIndexes();
			result = 'created';
		} catch (error) {
			result = `FAILED ${(error as Error).message.slice(0, 120)}`;
		}
	}
	return { model: name, collection: model.collection.collectionName, declared: declared.length, missing: missing.join(' | '), result };
}

async function inspectShadowLog(): Promise<Row> {
	const collection = mongoose.connection.db!.collection('permission_shadow_log');
	const existing = await existingKeys(collection);
	const missing = shadowIndexes.filter(([fields]) => !existing.includes(keyOf(fields)));
	let result = missing.length === 0 ? 'ok' : 'missing';
	if (apply && missing.length > 0) {
		try {
			for (const [fields, options] of missing) await collection.createIndex(fields, options);
			result = 'created';
		} catch (error) {
			result = `FAILED ${(error as Error).message.slice(0, 120)}`;
		}
	}
	return {
		model: 'PermissionShadowLog',
		collection: 'permission_shadow_log',
		declared: shadowIndexes.length,
		missing: missing.map(([fields]) => keyOf(fields)).join(' | '),
		result
	};
}

async function main() {
	await mongoose.connect(uri!, { autoIndex: false, autoCreate: false });
	const rows: Row[] = [];
	for (const [name, model] of Object.entries(mongoose.models)) {
		if (name !== 'PermissionShadowLog') rows.push(await inspectModel(name, model as Model<unknown>));
	}
	rows.push(await inspectShadowLog());

	const notOk = rows.filter((r) => r.result !== 'ok');
	console.table(notOk.length > 0 ? notOk : [{ model: 'all', result: 'ok' }]);
	console.log(`${rows.length} models checked; ${rows.length - notOk.length} ok.`);
	if (!apply && notOk.length > 0) console.log('Re-run with --apply to create the missing indexes.');
	if (rows.some((r) => r.result.startsWith('FAILED'))) process.exitCode = 1;
	await mongoose.disconnect();
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
