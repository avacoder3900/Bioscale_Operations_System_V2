/**
 * Retire global robot deck offsets — set every stored offset to 0,0,0.
 *
 * The deck's labware definition is the single source of truth for where a hole
 * is, and the per-tip probe is the only correction applied on top. A global
 * offset moves all 576 holes plus the tube rack and tip rack, so it double-counts
 * geometry the Deck Calibration Studio already tuned.
 *
 * The rows are kept, not deleted. Deleting them would make the protocol fall
 * back to its hardcoded ROBOT_OFFSETS table, which is NOT all zeros — B07 /
 * hidden-leaf carries {0.15, -0.25, -1.3} there. A row of zeros keeps
 * bims_native true and the table bypassed.
 *
 * Precedent: B14 carried {-0.1, -2.4, 0} from 2026-07-01, caused the 07-08
 * deck-004 fill misses, and was zeroed on 07-09. R04 carried {1, 0, 0} from
 * 2026-08-19, pushing every wax hole 1mm right of the position operators had
 * physically verified in the Studio (the Studio jogs via the maintenance API,
 * which applies no global offset).
 *
 * Usage:
 *   MONGODB_URI=... npx tsx scripts/zero-robot-offsets.ts --plan
 *   MONGODB_URI=... npx tsx scripts/zero-robot-offsets.ts --apply
 */
import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
dotenv.config();
import { generateId } from '../src/lib/server/db/utils.js';

const MODE: 'plan' | 'apply' | null = (() => {
	if (process.argv.includes('--apply')) return 'apply';
	if (process.argv.includes('--plan')) return 'plan';
	return null;
})();
if (!MODE) {
	console.error('Usage: npx tsx scripts/zero-robot-offsets.ts --plan | --apply');
	process.exit(1);
}

const OPERATOR = 'system-retire-global-offsets';
const NOTE =
	'Global offsets retired 2026-08-19 — deck definition is the single source of truth ' +
	'for hole positions; per-tip calibration is the only correction on top. Row kept at ' +
	'zero so bims_native stays true and the protocol hardcoded table stays bypassed.';

async function main() {
	const uri = process.env.MONGODB_URI;
	if (!uri) {
		console.error('MONGODB_URI is not set.');
		process.exit(1);
	}
	await mongoose.connect(uri);
	const db = mongoose.connection.db!;
	console.log(`[${MODE}] connected to ${db.databaseName}\n`);

	const robots = await db.collection('opentrons_robots').find({}).toArray();
	const nameOf = new Map(robots.map((r: any) => [String(r._id), r.name ?? String(r._id)]));

	const rows = await db.collection('robot_deck_offsets').find({}).toArray();
	let changed = 0;

	for (const r of rows as any[]) {
		const o = r.offset ?? { x: 0, y: 0, z: 0 };
		const nonZero = Number(o.x) !== 0 || Number(o.y) !== 0 || Number(o.z) !== 0;
		const label = String(nameOf.get(String(r.robotId)) ?? r.robotId);

		if (!nonZero) {
			console.log(`  OK      ${label.padEnd(16)} already 0,0,0`);
			continue;
		}
		console.log(
			`  ZERO    ${label.padEnd(16)} ${JSON.stringify(o)} -> {x:0,y:0,z:0}` +
				(r.isReference ? '   (reference robot)' : '')
		);
		if (MODE === 'apply') {
			await db.collection('robot_deck_offsets').updateOne(
				{ _id: r._id },
				{ $set: { offset: { x: 0, y: 0, z: 0 }, note: NOTE, capturedAt: new Date() } }
			);
			await db.collection('audit_log').insertOne({
				_id: generateId(),
				tableName: 'robot_deck_offsets',
				recordId: String(r.robotId),
				action: 'retire_global_offset',
				oldData: { offset: o, note: r.note ?? null },
				newData: { offset: { x: 0, y: 0, z: 0 }, reason: 'global offsets retired' },
				changedAt: new Date(),
				changedBy: OPERATOR
			} as any);
		}
		changed++;
	}

	console.log(`\n${MODE === 'apply' ? 'ZEROED' : 'would zero'}: ${changed} of ${rows.length} row(s)`);
	if (MODE === 'plan') console.log('\nRe-run with --apply to write.');
	await mongoose.disconnect();
}

main().catch((e) => {
	console.error('FAILED:', e);
	process.exit(1);
});
