/**
 * DECK-VC-1 — seed `deck_versions` from the decks that exist today.
 *
 * Freezes each cartridge deck's CURRENT geometry as a snapshot at its CURRENT
 * version number. It does not bump anything: this is the baseline that later
 * publishes and rollbacks are measured against, so it must record the decks
 * exactly as they are running right now.
 *
 * Idempotent — a deck already frozen at its current version is skipped, so this
 * is safe to re-run.
 *
 * Usage:
 *   MONGODB_URI=... npx tsx scripts/backfill-deck-versions.ts --plan
 *   MONGODB_URI=... npx tsx scripts/backfill-deck-versions.ts --apply
 */
import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
dotenv.config();
import { generateId } from '../src/lib/server/db/utils.js';
import { definitionHash } from '../src/lib/server/services/deck-calibration/definition-hash.js';

const MODE: 'plan' | 'apply' | null = (() => {
	if (process.argv.includes('--apply')) return 'apply';
	if (process.argv.includes('--plan')) return 'plan';
	return null;
})();
if (!MODE) {
	console.error('Usage: npx tsx scripts/backfill-deck-versions.ts --plan | --apply');
	process.exit(1);
}

const OPERATOR = 'system-backfill-deck-versions';
/** Same rule the Deck Calibration Studio uses to decide what is a deck. */
const DECK_RE = /(gen4deck|cartridge_deck)/i;

async function main() {
	const uri = process.env.MONGODB_URI;
	if (!uri) {
		console.error('MONGODB_URI is not set. Export it before running.');
		process.exit(1);
	}
	await mongoose.connect(uri);
	const db = mongoose.connection.db!;
	console.log(`[${MODE}] connected to ${db.databaseName}\n`);

	const all = (await db.collection('labware_definitions').find({}).toArray()) as any[];
	const decks = all.filter((d) => DECK_RE.test(String(d.loadName ?? '')));

	console.log(`labware_definitions: ${all.length} total, ${decks.length} decks\n`);

	let frozen = 0;
	let skipped = 0;

	for (const d of decks.sort((a, b) => String(a.loadName).localeCompare(String(b.loadName)))) {
		const deckLoadName = String(d.loadName);
		const version = Number(d.version ?? 1);
		const wells = d.definition?.wells ?? {};
		const wellCount = Object.keys(wells).length;
		const hash = definitionHash(d.definition);

		const existing = await db
			.collection('deck_versions')
			.findOne({ deckLoadName, version });

		if (existing) {
			const same = existing.definitionHash === hash;
			console.log(
				`  SKIP  ${deckLoadName} v${version} — already frozen` +
					(same ? '' : `  ** hash differs from live! frozen=${String(existing.definitionHash).slice(0, 12)} live=${hash.slice(0, 12)} **`)
			);
			skipped++;
			continue;
		}

		const dims = d.definition?.dimensions ?? {};
		console.log(
			`  FREEZE ${deckLoadName} v${version}  wells=${wellCount}  ns=${d.namespace}  hash=${hash.slice(0, 12)}`
		);

		if (MODE === 'apply') {
			await db.collection('deck_versions').insertOne({
				_id: generateId(),
				deckLoadName,
				namespace: d.namespace,
				version,
				definition: d.definition,
				definitionHash: hash,
				wellCount,
				dimensions: {
					x: Number(dims.xDimension) || undefined,
					y: Number(dims.yDimension) || undefined,
					z: Number(dims.zDimension) || undefined
				},
				publishedAt: new Date(),
				publishedBy: OPERATOR,
				note: 'baseline backfill — geometry as running at migration time',
				rolledBackFrom: null,
				editsSincePrevious: await db
					.collection('deck_calibration_edits')
					.countDocuments({ deckLoadName }),
				publishedToRobots: [],
				createdAt: new Date(),
				updatedAt: new Date()
			} as any);

			await db.collection('labware_definitions').updateOne(
				{ _id: d._id },
				{ $set: { lastPublishedVersion: version, hasUnpublishedEdits: false } }
			);

			await db.collection('audit_log').insertOne({
				_id: generateId(),
				tableName: 'deck_versions',
				recordId: deckLoadName,
				action: 'deck_version_backfill',
				newData: { deckLoadName, version, wellCount, definitionHash: hash },
				changedAt: new Date(),
				changedBy: OPERATOR
			} as any);
		}
		frozen++;
	}

	console.log(`\n${MODE === 'apply' ? 'FROZE' : 'would freeze'}: ${frozen}   skipped: ${skipped}`);
	if (MODE === 'plan') console.log('\nRe-run with --apply to write.');

	await mongoose.disconnect();
}

main().catch((e) => {
	console.error('FAILED:', e);
	process.exit(1);
});
