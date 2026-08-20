/**
 * Freeze a deck's current geometry as the next immutable deck_versions row.
 *
 * The script form of the Studio's publish. Exists because publishing is wired
 * into the Sync action on the feature branch, so a deck corrected and proven
 * good while production is still on the old code has no other way to get a
 * numbered snapshot — and an unnamed known-good state is exactly what this
 * whole feature was built to stop.
 *
 * Bumps `version` so the geometry arrives at the robot under a NEW
 * namespace/loadName/version URI; Opentrons keys registered definitions to that
 * triple, so changed geometry at an unchanged version is how stale coordinates
 * survive a successful upload.
 *
 * Usage:
 *   MONGODB_URI=... npx tsx scripts/publish-deck-version.ts --deck <loadName> --note "..." [--apply]
 */
import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
dotenv.config();
import { generateId } from '../src/lib/server/db/utils.js';
import { definitionHash } from '../src/lib/server/services/deck-calibration/definition-hash.js';

const argv = process.argv.slice(2);
const arg = (n: string) => {
	const i = argv.indexOf('--' + n);
	return i >= 0 && argv[i + 1] ? argv[i + 1] : null;
};
const MODE: 'plan' | 'apply' = argv.includes('--apply') ? 'apply' : 'plan';
const deckLoadName = arg('deck');
const note = arg('note') ?? '';
if (!deckLoadName) {
	console.error('Usage: --deck <loadName> [--note "..."] [--apply]');
	process.exit(1);
}

async function main() {
	const uri = process.env.MONGODB_URI;
	if (!uri) { console.error('MONGODB_URI is not set.'); process.exit(1); }
	await mongoose.connect(uri);
	const db = mongoose.connection.db!;
	console.log(`[${MODE}] ${db.databaseName}\n`);

	const defs = await db.collection('labware_definitions').find({ loadName: deckLoadName }).toArray();
	if (defs.length !== 1) {
		console.error(`Expected exactly 1 definition for "${deckLoadName}", found ${defs.length}. Refusing.`);
		process.exit(1);
	}
	const doc = defs[0] as any;
	const currentHash = definitionHash(doc.definition);

	const latest = await db.collection('deck_versions')
		.find({ deckLoadName }).sort({ version: -1 }).limit(1).toArray();
	const prev = latest[0] as any;

	if (prev && prev.definitionHash === currentHash) {
		console.log(`Already published as v${prev.version} — geometry unchanged. Nothing to do.`);
		await mongoose.disconnect();
		return;
	}

	const nextVersion = Math.max(Number(prev?.version ?? 0), Number(doc.version ?? 0)) + 1;
	const definition = { ...doc.definition, version: nextVersion };
	const frozenHash = definitionHash(definition);
	const wellCount = Object.keys(definition?.wells ?? {}).length;
	const dims = definition?.dimensions ?? {};
	const editsSince = prev?.publishedAt
		? await db.collection('deck_calibration_edits').countDocuments({ deckLoadName, createdAt: { $gt: prev.publishedAt } })
		: await db.collection('deck_calibration_edits').countDocuments({ deckLoadName });

	console.log(`deck            ${deckLoadName}`);
	console.log(`previous        v${prev?.version ?? '(none)'}  hash ${String(prev?.definitionHash ?? '-').slice(0, 16)}`);
	console.log(`publishing as   v${nextVersion}  hash ${frozenHash.slice(0, 16)}`);
	console.log(`wells           ${wellCount}`);
	console.log(`edits since     ${editsSince}`);
	console.log(`note            ${note || '(none)'}`);

	if (MODE === 'plan') {
		console.log('\nRe-run with --apply to write.');
		await mongoose.disconnect();
		return;
	}

	await db.collection('deck_versions').insertOne({
		_id: generateId(),
		deckLoadName,
		namespace: doc.namespace,
		version: nextVersion,
		definition,
		definitionHash: frozenHash,
		wellCount,
		dimensions: {
			x: Number(dims.xDimension) || undefined,
			y: Number(dims.yDimension) || undefined,
			z: Number(dims.zDimension) || undefined
		},
		publishedAt: new Date(),
		publishedBy: 'system-publish-deck-version',
		note,
		rolledBackFrom: null,
		editsSincePrevious: editsSince,
		publishedToRobots: [],
		createdAt: new Date(),
		updatedAt: new Date()
	} as any);

	await db.collection('labware_definitions').updateOne(
		{ _id: doc._id },
		{ $set: { version: nextVersion, 'definition.version': nextVersion, lastPublishedVersion: nextVersion, hasUnpublishedEdits: false } }
	);

	await db.collection('audit_log').insertOne({
		_id: generateId(),
		tableName: 'deck_versions',
		recordId: deckLoadName,
		action: 'deck_version_publish',
		newData: { deckLoadName, version: nextVersion, previousVersion: prev?.version ?? null, definitionHash: frozenHash, wellCount, editsSincePrevious: editsSince, note },
		changedAt: new Date(),
		changedBy: 'system-publish-deck-version'
	} as any);

	console.log(`\nPUBLISHED v${nextVersion}.`);
	await mongoose.disconnect();
}

main().catch((e) => { console.error('FAILED:', e); process.exit(1); });
